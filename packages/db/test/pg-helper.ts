import { createPgClient, createPostgresDatabase, type Database, type SqlClient } from "../src/index.js";

/**
 * Real-Postgres tests run only when TEST_DATABASE_URL is set, so a plain `npm test` stays
 * offline. Each call gets its own schema: test files run in parallel against one database.
 *
 * To run them, point TEST_DATABASE_URL at any empty, disposable Postgres database (the
 * role needs CREATE on it) and run the usual command, e.g. with the URL in an env file:
 *   node --env-file=<file> node_modules/vitest/vitest.mjs run packages/db/test packages/api/test/postgres.integration.test.ts
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestPostgres {
  db: Database;
  sql: SqlClient;
  schema: string;
  /** A connection string that lands in this test's schema — hand it to a second "process". */
  url: string;
  /** Open another Database on the same schema, as a second API/worker process would. */
  another(): Promise<Database>;
  drop(): Promise<void>;
}

export async function openTestPostgres(label: string, opts: { bootstrap?: boolean } = {}): Promise<TestPostgres> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const schema = `t_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await createPgClient(TEST_DATABASE_URL, { max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(TEST_DATABASE_URL);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const url = scoped.toString();
  const sql = await createPgClient(url);
  const extra: Database[] = [];
  const db = opts.bootstrap === false ? (null as unknown as Database) : await createPostgresDatabase(sql);
  return {
    db,
    sql,
    schema,
    url,
    another: async () => {
      const other = await createPostgresDatabase(await createPgClient(url));
      extra.push(other);
      return other;
    },
    drop: async () => {
      for (const other of extra) await other.close();
      await sql.end?.();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end?.();
    },
  };
}
