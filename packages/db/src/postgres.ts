import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Database, LockOptions, Repo, TransactionOptions } from "./ports.js";
import { UNIQUE_CONSTRAINTS, constraintFieldNames, uniqueIndexDdl, uniqueIndexName, type CollectionName } from "./constraints.js";
import { DuplicateKeyError, LockTimeoutError, NotFoundError, TransactionAbortedError, UniqueViolationError } from "./errors.js";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  KeyedMutex,
  NO_LOCKS,
  holds,
  sessionLockKey,
  transactionLockKey,
  withHeld,
  type Ambient,
  type HeldLock,
} from "./sync.js";

/**
 * Postgres adapter for the Database port.
 *
 * It persists each entity as a row in a per-entity JSONB document table — a pragmatic
 * durable store that satisfies the same contract as the in-memory adapter without a full
 * ORM mapping. `schema.sql` is a reference model only; this adapter neither reads nor
 * applies it. What this adapter creates is `operationalDdl()`.
 *
 * It is decoupled from the driver, but the driver handle must be able to hand out ONE
 * dedicated connection (`connect`): a transaction or a session lock issued through a pool's
 * shared `query` lands on a different connection per statement and protects nothing.
 * `createPgClient` (bootstrap.ts) wraps node-postgres correctly.
 *
 * Known limit: `find`, `findOne` and `count(predicate)` read the whole table and filter in
 * the process. Rows carry an insertion sequence so the order matches the in-memory adapter.
 */
export interface SqlQueryResult {
  rows: any[];
  rowCount?: number | null;
  /** The command tag ("COMMIT", "ROLLBACK", …) when the driver exposes it. */
  command?: string;
}

export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<SqlQueryResult>;
}

/** One dedicated connection. `release(true)` discards it instead of reusing it. */
export interface SqlConnection extends SqlExecutor {
  release(destroy?: boolean | Error): void;
}

export interface SqlClient extends SqlExecutor {
  /** Check out a dedicated connection. The caller releases it. */
  connect(): Promise<SqlConnection>;
  /**
   * Connections for session locks, from a pool of their own so that lock holders and
   * waiters cannot starve the statements they are waiting on. Defaults to `connect`.
   */
  lockConnect?(): Promise<SqlConnection>;
  end?(): Promise<void>;
}

const TABLES: Record<CollectionName, { table: string; idCol: string }> = {
  merchants: { table: "kv_merchants", idCol: "id" },
  merchantUsers: { table: "kv_merchant_users", idCol: "id" },
  users: { table: "kv_users", idCol: "id" },
  auditLogs: { table: "kv_audit_logs", idCol: "id" },
  subscriptions: { table: "kv_subscriptions", idCol: "id" },
  usageEvents: { table: "kv_usage_events", idCol: "id" },
  entitlements: { table: "kv_entitlements", idCol: "id" },
  integrations: { table: "kv_integrations", idCol: "id" },
  mailboxes: { table: "kv_mailboxes", idCol: "id" },
  secrets: { table: "kv_secrets", idCol: "id" },
  sendingDomains: { table: "kv_sending_domains", idCol: "id" },
  webhookDeliveries: { table: "kv_webhook_deliveries", idCol: "id" },
  affiliates: { table: "kv_affiliates", idCol: "id" },
  relationships: { table: "kv_relationships", idCol: "id" },
  payoutAccounts: { table: "kv_payout_accounts", idCol: "id" },
  taxDocuments: { table: "kv_tax_documents", idCol: "id" },
  programs: { table: "kv_programs", idCol: "id" },
  offers: { table: "kv_offers", idCol: "id" },
  codes: { table: "kv_codes", idCol: "id" },
  creatives: { table: "kv_creatives", idCol: "id" },
  agreements: { table: "kv_agreements", idCol: "id" },
  agreementAcceptances: { table: "kv_agreement_acceptances", idCol: "id" },
  customers: { table: "kv_customers", idCol: "id" },
  orders: { table: "kv_orders", idCol: "id" },
  clicks: { table: "kv_clicks", idCol: "clickId" },
  conversions: { table: "kv_conversions", idCol: "id" },
  ledger: { table: "kv_ledger", idCol: "id" },
  overrides: { table: "kv_overrides", idCol: "id" },
  payoutBatches: { table: "kv_payout_batches", idCol: "id" },
  payouts: { table: "kv_payouts", idCol: "id" },
  payoutAdjustments: { table: "kv_payout_adjustments", idCol: "id" },
  affiliateNotes: { table: "kv_affiliate_notes", idCol: "id" },
  affiliateTasks: { table: "kv_affiliate_tasks", idCol: "id" },
  affiliateMessages: { table: "kv_affiliate_messages", idCol: "id" },
  prospects: { table: "kv_prospects", idCol: "id" },
  prospectSources: { table: "kv_prospect_sources", idCol: "id" },
  prospectSignals: { table: "kv_prospect_signals", idCol: "id" },
  campaigns: { table: "kv_campaigns", idCol: "id" },
  outreachMessages: { table: "kv_outreach_messages", idCol: "id" },
  replies: { table: "kv_replies", idCol: "id" },
  suppressions: { table: "kv_suppressions", idCol: "id" },
  prospectOutcomes: { table: "kv_prospect_outcomes", idCol: "id" },
  meetings: { table: "kv_meetings", idCol: "id" },
  automationStates: { table: "kv_automation_states", idCol: "id" },
  frontierMerchants: { table: "kv_frontier_merchants", idCol: "id" },
  merchantFaqs: { table: "kv_merchant_faqs", idCol: "id" },
  handoffs: { table: "kv_handoffs", idCol: "id" },
  dmTasks: { table: "kv_dm_tasks", idCol: "id" },
  apiKeys: { table: "kv_api_keys", idCol: "id" },
  webhookSubscriptions: { table: "kv_webhook_subscriptions", idCol: "id" },
};

/** The collection names this adapter knows — the in-memory adapter must list the same ones. */
export const POSTGRES_COLLECTIONS: readonly string[] = Object.keys(TABLES);

// `seq` records insertion order: reads sort by it so "first match" means the same row here
// as in the in-memory adapter (an unordered SELECT returns rows in whatever order the heap
// happens to hold them, which changes after updates).
const createTableDdl = (table: string): string =>
  `CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, doc jsonb NOT NULL, seq bigserial NOT NULL)`;
const seqIndexName = (table: string): string => `${table}_seq_idx`;
const seqIndexDdl = (table: string): string => `CREATE INDEX IF NOT EXISTS ${seqIndexName(table)} ON ${table} (seq)`;

/** DDL that creates the operational document tables and indexes this adapter reads/writes. */
export function operationalDdl(): string {
  const statements: string[] = [];
  for (const { table } of Object.values(TABLES)) statements.push(createTableDdl(table), seqIndexDdl(table));
  for (const constraint of UNIQUE_CONSTRAINTS) statements.push(uniqueIndexDdl(constraint, TABLES[constraint.collection].table));
  return statements.map((s) => `${s};`).join("\n");
}

/** One transaction — or a savepoint inside one. Every level shares the connection. */
interface PgTx {
  conn: SqlConnection;
  /** Set the moment the work function settles, BEFORE commit/rollback is sent. */
  closed: boolean;
  parent: PgTx | null;
  root: PgTxRoot;
}

interface PgTxRoot {
  savepoints: number;
  /** Transaction lock keys whose in-process mutex this transaction holds. */
  queued: Set<string>;
  /** Transaction lock keys this transaction holds in Postgres. */
  locked: Set<string>;
  onEnd: Array<() => void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Turn driver errors into the port's errors, so both adapters fail the same way. */
function translate(err: unknown, id?: string): unknown {
  const e = err as PgErrorLike | null;
  if (e?.code === "23505") {
    const constraint = UNIQUE_CONSTRAINTS.find((c) => uniqueIndexName(c) === e.constraint);
    if (constraint) return new UniqueViolationError(constraint.name, constraint.collection, constraintFieldNames(constraint));
    const fromDetail = /\(id\)=\((.*)\) already exists/.exec(e.detail ?? "")?.[1];
    return new DuplicateKeyError(id ?? fromDetail ?? e.constraint ?? "unknown");
  }
  if (e?.code === "25P02") return new TransactionAbortedError();
  return err;
}

class PgRepo<T> implements Repo<T> {
  constructor(
    /** Where a statement issued right now must go: the open transaction's connection, or the pool. */
    private readonly executor: () => SqlExecutor,
    private readonly table: string,
    private readonly idCol: string,
  ) {}

  private idOf(row: T): string {
    return (row as Record<string, unknown>)[this.idCol] as string;
  }

  private async run(text: string, params: unknown[], id?: string): Promise<SqlQueryResult> {
    try {
      return await this.executor().query(text, params);
    } catch (err) {
      throw translate(err, id);
    }
  }

  async get(id: string): Promise<T | null> {
    const { rows } = await this.run(`SELECT doc FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? (rows[0].doc as T) : null;
  }

  async require(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError(id);
    return row;
  }

  async insert(row: T): Promise<T> {
    const id = this.idOf(row);
    const { rows } = await this.run(`INSERT INTO ${this.table} (id, doc) VALUES ($1, $2::jsonb) RETURNING doc`, [id, JSON.stringify(row)], id);
    return rows[0].doc as T;
  }

  async insertMany(rows: T[]): Promise<T[]> {
    if (rows.length === 0) return [];
    // One statement: all rows or none, inserted in the given order.
    const { rows: out } = await this.run(
      `INSERT INTO ${this.table} (id, doc)
       SELECT elem->>$2, elem FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS items(elem, ord) ORDER BY ord
       RETURNING doc`,
      [JSON.stringify(rows), this.idCol],
    );
    return out.map((r) => r.doc as T);
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    // One statement, so two concurrent updates of different fields cannot lose each other's
    // write (the old read-modify-write could). `undefined` means "remove the key", exactly
    // what merging and re-serializing the whole document did.
    const cleared = Object.entries(patch as Record<string, unknown>)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    const { rows } = await this.run(
      `UPDATE ${this.table} SET doc = (doc - $3::text[]) || $2::jsonb WHERE id = $1 RETURNING doc`,
      [id, JSON.stringify(patch), cleared],
      id,
    );
    if (!rows[0]) throw new NotFoundError(id);
    return rows[0].doc as T;
  }

  async upsert(row: T): Promise<T> {
    const id = this.idOf(row);
    const { rows } = await this.run(
      `INSERT INTO ${this.table} (id, doc) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc
       RETURNING doc`,
      [id, JSON.stringify(row)],
      id,
    );
    return rows[0].doc as T;
  }

  async delete(id: string): Promise<void> {
    await this.run(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async all(): Promise<T[]> {
    const { rows } = await this.run(`SELECT doc FROM ${this.table} ORDER BY seq`, []);
    return rows.map((r) => r.doc as T);
  }

  async find(predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async findOne(predicate: (row: T) => boolean): Promise<T | null> {
    return (await this.all()).find(predicate) ?? null;
  }

  async count(predicate?: (row: T) => boolean): Promise<number> {
    if (!predicate) {
      const { rows } = await this.run(`SELECT count(*)::int AS n FROM ${this.table}`, []);
      return rows[0]?.n ?? 0;
    }
    return (await this.find(predicate)).length;
  }
}

/** A fixed key for "this process is creating tables": first boots must not race each other. */
const DDL_LOCK_ID = createHash("sha256").update("affiliate-saas:ddl").digest().readBigInt64BE(0).toString();

/**
 * Create whatever is missing and return the schema the tables live in. Steady state runs
 * no DDL at all (catalog reads only), so a restart never takes a table lock under live
 * traffic.
 */
async function ensureSchema(sql: SqlClient): Promise<string> {
  const conn = await sql.connect();
  let destroy = false;
  try {
    await conn.query("BEGIN");
    try {
      await conn.query("SELECT pg_advisory_xact_lock($1::bigint)", [DDL_LOCK_ID]);
      const schema = (await conn.query("SELECT current_schema() AS schema")).rows[0]?.schema as string | null | undefined;
      if (!schema) throw new Error("Postgres connection has no current schema — check its search_path");
      const names = async (text: string): Promise<Set<string>> => new Set((await conn.query(text)).rows.map((r) => r.name as string));
      const tables = await names("SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()");
      const sequenced = await names(
        "SELECT table_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'seq'",
      );
      const indexes = await names("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()");

      for (const { table } of Object.values(TABLES)) {
        if (!tables.has(table)) await conn.query(createTableDdl(table));
        // A table from before rows carried a sequence: number the existing rows once.
        else if (!sequenced.has(table)) await conn.query(`ALTER TABLE ${table} ADD COLUMN seq bigserial NOT NULL`);
        if (!indexes.has(seqIndexName(table))) await conn.query(seqIndexDdl(table));
      }
      for (const constraint of UNIQUE_CONSTRAINTS) {
        if (indexes.has(uniqueIndexName(constraint))) continue;
        const { table } = TABLES[constraint.collection];
        try {
          await conn.query(uniqueIndexDdl(constraint, table));
        } catch (err) {
          const e = err as PgErrorLike;
          if (e?.code !== "23505") throw err;
          throw new Error(
            `cannot enforce uniqueness of ${constraint.collection}(${constraintFieldNames(constraint).join(", ")}): ` +
              `rows already in ${table} break it (${e.detail ?? "duplicate values"}). ` +
              `It exists because: ${constraint.reason}. Resolve the duplicates, then start again.`,
          );
        }
      }
      await conn.query("COMMIT");
      return schema;
    } catch (err) {
      try {
        await conn.query("ROLLBACK");
      } catch {
        destroy = true;
      }
      throw err;
    }
  } finally {
    conn.release(destroy);
  }
}

export async function createPostgresDatabase(sql: SqlClient): Promise<Database> {
  if (typeof sql?.connect !== "function") {
    throw new Error(
      "createPostgresDatabase needs a client that can check out a dedicated connection (connect()). " +
        "Transactions issued through a shared pool query run on a different connection per statement. Use createPgClient().",
    );
  }
  const schema = await ensureSchema(sql);

  const ambient = new AsyncLocalStorage<Ambient<PgTx>>();
  const mutex = new KeyedMutex();
  // Advisory locks are database-wide; two schemas in one database must not share them.
  const advisoryId = (key: string): string =>
    createHash("sha256").update(`${schema}\u0000${key}`).digest().readBigInt64BE(0).toString();

  const ambientTx = (): PgTx | null => {
    let tx = ambient.getStore()?.tx ?? null;
    while (tx && tx.closed) tx = tx.parent;
    return tx;
  };
  /** Same rule as the in-memory adapter: the bound transaction while it is open, else the call chain's. */
  const resolve = (bound: PgTx | null): PgTx | null => {
    const current = ambientTx();
    if (!bound || bound.closed) return current;
    for (let tx = current; tx; tx = tx.parent) {
      if (tx === bound) return current;
    }
    return bound;
  };

  const handle = (bound: PgTx | null): Database => {
    const executor = (): SqlExecutor => resolve(bound)?.conn ?? sql;
    const repos: Record<string, unknown> = {};
    for (const [collection, { table, idCol }] of Object.entries(TABLES)) {
      repos[collection] = new PgRepo(executor, table, idCol);
    }
    const db = repos as unknown as Database;
    db.transaction = (fn, opts) => transaction(bound, fn, opts);
    db.withLock = (key, fn, opts) => withLock(db, key, fn, opts);
    db.reset = async () => {
      const tables = Object.values(TABLES).map((t) => t.table).join(", ");
      await executor().query(`TRUNCATE ${tables} RESTART IDENTITY`);
    };
    db.close = async () => {
      await sql.end?.();
    };
    return db;
  };

  /** Poll for an advisory lock: no session settings to restore, and immune to statement timeouts. */
  async function acquireAdvisory(
    conn: SqlExecutor,
    fn: "pg_try_advisory_lock" | "pg_try_advisory_xact_lock",
    lockKey: string,
    label: string,
    deadline: number,
    timeoutMs: number,
  ): Promise<void> {
    const id = advisoryId(lockKey);
    let wait = 5;
    for (;;) {
      const { rows } = await conn.query(`SELECT ${fn}($1::bigint) AS locked`, [id]);
      if (rows[0]?.locked === true) return;
      const left = deadline - Date.now();
      if (left <= 0) throw new LockTimeoutError(label, timeoutMs);
      await sleep(Math.min(wait, left));
      wait = Math.min(wait * 2, 100);
    }
  }

  /** Take a transaction lock: the in-process queue first, then Postgres on the transaction's own connection. */
  async function lockTransaction(tx: PgTx, key: string, timeoutMs: number, deadline: number): Promise<void> {
    const lockKey = transactionLockKey(key);
    const { root } = tx;
    if (!root.queued.has(lockKey)) {
      root.onEnd.push(await mutex.acquire(lockKey, timeoutMs));
      root.queued.add(lockKey);
    }
    if (!root.locked.has(lockKey)) {
      await acquireAdvisory(tx.conn, "pg_try_advisory_xact_lock", lockKey, key, deadline, timeoutMs);
      root.locked.add(lockKey);
    }
  }

  async function transaction<R>(
    bound: PgTx | null,
    fn: (db: Database) => Promise<R>,
    opts: TransactionOptions = {},
  ): Promise<R> {
    const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const parent = resolve(bound);
    const locks = ambient.getStore()?.locks ?? NO_LOCKS;

    if (parent) {
      // Nested: a savepoint on the same connection.
      const { conn, root } = parent;
      root.savepoints += 1;
      const savepoint = `sp_${root.savepoints}`;
      try {
        await conn.query(`SAVEPOINT ${savepoint}`);
      } catch (err) {
        throw translate(err);
      }
      const tx: PgTx = { conn, closed: false, parent, root };
      const lockedBefore = new Set(root.locked);
      try {
        if (opts.lock !== undefined) await lockTransaction(tx, opts.lock, timeoutMs, deadline);
        const result = await ambient.run({ tx, locks }, () => fn(handle(tx)));
        tx.closed = true;
        // Fails if a statement inside failed and its error was swallowed.
        await conn.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        tx.closed = true;
        // Rolling back to the savepoint also drops the locks Postgres granted since.
        root.locked = lockedBefore;
        try {
          await conn.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await conn.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // The connection is gone; the enclosing transaction fails on its next statement.
        }
        throw translate(err);
      }
    }

    const root: PgTxRoot = { savepoints: 0, queued: new Set(), locked: new Set(), onEnd: [] };
    try {
      // Wait in the in-process queue BEFORE taking a connection, so callers queued on one
      // key hold one connection between them, not one each.
      if (opts.lock !== undefined) {
        const lockKey = transactionLockKey(opts.lock);
        root.onEnd.push(await mutex.acquire(lockKey, timeoutMs));
        root.queued.add(lockKey);
      }
      const conn = await sql.connect();
      const tx: PgTx = { conn, closed: false, parent: null, root };
      let destroy = false;
      try {
        await conn.query("BEGIN");
        if (opts.lock !== undefined) await lockTransaction(tx, opts.lock, timeoutMs, deadline);
        const result = await ambient.run({ tx, locks }, () => fn(handle(tx)));
        tx.closed = true;
        const committed = await conn.query("COMMIT");
        // COMMIT on an aborted transaction "succeeds" as a ROLLBACK. Never report that as success.
        if (committed.command === "ROLLBACK") throw new TransactionAbortedError();
        return result;
      } catch (err) {
        tx.closed = true;
        try {
          await conn.query("ROLLBACK");
        } catch {
          destroy = true;
        }
        throw translate(err);
      } finally {
        conn.release(destroy);
      }
    } finally {
      for (const end of root.onEnd) end();
    }
  }

  async function withLock<R>(
    db: Database,
    key: string,
    fn: (db: Database) => Promise<R>,
    opts: LockOptions = {},
  ): Promise<R> {
    const state = ambient.getStore();
    const lockKey = sessionLockKey(key);
    if (holds(state?.locks, lockKey)) return fn(db);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const releaseQueue = await mutex.acquire(lockKey, timeoutMs);
    try {
      const conn = await (sql.lockConnect ? sql.lockConnect() : sql.connect());
      let destroy = false;
      try {
        await acquireAdvisory(conn, "pg_try_advisory_lock", lockKey, key, deadline, timeoutMs);
        const held: HeldLock = { released: false };
        try {
          return await ambient.run({ tx: state?.tx ?? null, locks: withHeld(state?.locks, lockKey, held) }, () => fn(db));
        } finally {
          held.released = true;
          try {
            const { rows } = await conn.query("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [advisoryId(lockKey)]);
            // Not held any more: the session was lost. Drop the connection rather than reuse it.
            if (rows[0]?.unlocked !== true) destroy = true;
          } catch {
            destroy = true; // closing the session releases the lock
          }
        }
      } finally {
        conn.release(destroy);
      }
    } finally {
      releaseQueue();
    }
  }

  return handle(null);
}
