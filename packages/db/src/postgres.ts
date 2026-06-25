import type { Database, Repo } from "./ports.js";

/**
 * Postgres adapter for the Database port.
 *
 * It is intentionally decoupled from any specific driver: pass any client that
 * satisfies `SqlClient` (node-postgres `Pool`, `postgres.js`, Neon serverless,
 * etc.). It persists each entity as a row in a per-entity JSONB document table —
 * a pragmatic durable store that satisfies the same contract as the in-memory
 * adapter without a full ORM mapping.
 *
 * The normalized relational schema in `schema.sql` (Section 10) is the target for
 * the reporting/analytics surface and for production deployments that want typed
 * columns and SQL-level constraints; this adapter is the operational store the
 * application services read and write through.
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const TABLES: Record<string, { table: string; idCol: string }> = {
  merchants: { table: "kv_merchants", idCol: "id" },
  merchantUsers: { table: "kv_merchant_users", idCol: "id" },
  users: { table: "kv_users", idCol: "id" },
  auditLogs: { table: "kv_audit_logs", idCol: "id" },
  subscriptions: { table: "kv_subscriptions", idCol: "id" },
  usageEvents: { table: "kv_usage_events", idCol: "id" },
  entitlements: { table: "kv_entitlements", idCol: "id" },
  integrations: { table: "kv_integrations", idCol: "id" },
  mailboxes: { table: "kv_mailboxes", idCol: "id" },
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
  apiKeys: { table: "kv_api_keys", idCol: "id" },
  webhookSubscriptions: { table: "kv_webhook_subscriptions", idCol: "id" },
};

/** DDL that creates the operational document tables this adapter reads/writes. */
export function operationalDdl(): string {
  return Object.values(TABLES)
    .map(({ table }) => `CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, doc jsonb NOT NULL);`)
    .join("\n");
}

class PgRepo<T> implements Repo<T> {
  constructor(
    private readonly sql: SqlClient,
    private readonly table: string,
    private readonly idCol: string,
  ) {}

  private idOf(row: T): string {
    return (row as Record<string, unknown>)[this.idCol] as string;
  }

  async get(id: string): Promise<T | null> {
    const { rows } = await this.sql.query(`SELECT doc FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? (rows[0].doc as T) : null;
  }

  async require(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) throw new Error(`row not found: ${id}`);
    return row;
  }

  async insert(row: T): Promise<T> {
    await this.sql.query(`INSERT INTO ${this.table} (id, doc) VALUES ($1, $2)`, [this.idOf(row), row]);
    return row;
  }

  async insertMany(rows: T[]): Promise<T[]> {
    for (const r of rows) await this.insert(r);
    return rows;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = await this.require(id);
    const updated = { ...existing, ...patch } as T;
    await this.sql.query(`UPDATE ${this.table} SET doc = $2 WHERE id = $1`, [id, updated]);
    return updated;
  }

  async upsert(row: T): Promise<T> {
    await this.sql.query(
      `INSERT INTO ${this.table} (id, doc) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`,
      [this.idOf(row), row],
    );
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async all(): Promise<T[]> {
    const { rows } = await this.sql.query(`SELECT doc FROM ${this.table}`);
    return rows.map((r) => r.doc as T);
  }

  async find(predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async findOne(predicate: (row: T) => boolean): Promise<T | null> {
    return (await this.find(predicate))[0] ?? null;
  }

  async count(predicate?: (row: T) => boolean): Promise<number> {
    if (!predicate) {
      const { rows } = await this.sql.query(`SELECT count(*)::int AS n FROM ${this.table}`);
      return rows[0]?.n ?? 0;
    }
    return (await this.find(predicate)).length;
  }
}

export async function createPostgresDatabase(sql: SqlClient): Promise<Database> {
  await sql.query(operationalDdl());

  const repos: Record<string, Repo<unknown>> = {};
  for (const [key, { table, idCol }] of Object.entries(TABLES)) {
    repos[key] = new PgRepo(sql, table, idCol);
  }

  const db = repos as unknown as Database;
  db.transaction = async <R>(fn: (d: Database) => Promise<R>): Promise<R> => {
    await sql.query("BEGIN");
    try {
      const result = await fn(db);
      await sql.query("COMMIT");
      return result;
    } catch (err) {
      await sql.query("ROLLBACK");
      throw err;
    }
  };
  db.reset = async () => {
    for (const { table } of Object.values(TABLES)) {
      await sql.query(`TRUNCATE ${table}`);
    }
  };
  return db;
}
