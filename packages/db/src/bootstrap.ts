import type { Database } from "./ports.js";
import { createMemoryDatabase } from "./memory.js";
import { createPostgresDatabase, type SqlClient } from "./postgres.js";

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

/** Wrap a node-postgres Pool as the driver-agnostic SqlClient the adapter expects. */
export async function createPgClient(connectionString: string): Promise<SqlClient> {
  let pgmod: any;
  try {
    // Dynamic so 'pg' is only required when Postgres is actually configured.
    pgmod = await import("pg" as string);
  } catch {
    throw new Error("DATABASE_URL is set but the 'pg' package is not installed (npm install pg)");
  }
  const Pool = pgmod.Pool ?? pgmod.default?.Pool;
  if (!Pool) throw new Error("could not load pg.Pool");
  const pool = new Pool({ connectionString });
  return {
    query: (text: string, params?: unknown[]) => pool.query(text, params),
  };
}
