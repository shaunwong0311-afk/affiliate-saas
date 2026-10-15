import type { Database } from "./ports.js";
import { createMemoryDatabase } from "./memory.js";
import { createPostgresDatabase, type SqlClient, type SqlConnection } from "./postgres.js";

/**
 * Resolve the runtime Database from the environment. This is what makes the
 * documented `USE_POSTGRES` / `DATABASE_URL` switch real: set them and the API,
 * edge, and worker all share ONE Postgres-backed store instead of each holding
 * isolated in-memory state. Default (no env) stays in-memory so dev/test run with
 * zero external services.
 */
export async function createDatabaseFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Database> {
  const usePostgres = env.USE_POSTGRES === "true" || !!env.DATABASE_URL;
  if (!usePostgres) return createMemoryDatabase();

  if (!env.DATABASE_URL) {
    throw new Error("USE_POSTGRES is set but DATABASE_URL is missing");
  }
  const sql = await createPgClient(env.DATABASE_URL);
  return createPostgresDatabase(sql);
}

export interface PgClientOptions {
  /** Connections for statements and transactions. Default 10. */
  max?: number;
  /** Connections reserved for session locks (`withLock`). Default 4. */
  lockMax?: number;
}

/**
 * Wrap node-postgres as the driver-agnostic SqlClient the adapter expects: a pool for
 * ordinary statements, dedicated connections for transactions, and a second small pool
 * for session locks (a lock holder needs a statement connection to do its work — if lock
 * waiters could take those, the holder could never finish).
 */
export async function createPgClient(connectionString: string, opts: PgClientOptions = {}): Promise<SqlClient> {
  let pgmod: any;
  try {
    // Dynamic so 'pg' is only required when Postgres is actually configured.
    pgmod = await import("pg" as string);
  } catch {
    throw new Error("DATABASE_URL is set but the 'pg' package is not installed (npm install pg)");
  }
  const Pool = pgmod.Pool ?? pgmod.default?.Pool;
  if (!Pool) throw new Error("could not load pg.Pool");

  const createPool = (max: number) => {
    const pool = new Pool({ connectionString, max, keepAlive: true, connectionTimeoutMillis: 30_000 });
    // An idle connection can die at any moment (server restart, network). Without a
    // listener node-postgres raises that as an uncaught exception and the process exits.
    pool.on("error", (err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[db] idle Postgres connection failed: ${err.message}`);
    });
    return pool;
  };

  /** A dedicated connection that survives dying while checked out, and is never reused if it did. */
  const checkOut = async (pool: any): Promise<SqlConnection> => {
    const client = await pool.connect();
    let failure: Error | null = null;
    const onError = (err: Error) => {
      failure = err;
    };
    client.on("error", onError);
    return {
      query: (text: string, params?: unknown[]) => client.query(text, params),
      release: (destroy?: boolean | Error) => {
        client.removeListener("error", onError);
        client.release(destroy || failure ? (destroy instanceof Error ? destroy : failure ?? true) : undefined);
      },
    };
  };

  const pool = createPool(opts.max ?? 10);
  let lockPool: any = null;
  return {
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    connect: () => checkOut(pool),
    lockConnect: () => checkOut((lockPool ??= createPool(opts.lockMax ?? 4))),
    end: async () => {
      await pool.end();
      if (lockPool) await lockPool.end();
    },
  };
}
