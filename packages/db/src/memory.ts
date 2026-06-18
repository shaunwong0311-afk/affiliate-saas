import type { Database, Repo } from "./ports.js";

/**
 * In-memory repository implementation — the DEFAULT runtime. It lets the entire
 * platform boot and run end-to-end with zero external services (no Postgres, no
 * Redis), which is what makes the demo, the tests, and local development possible.
 * The Postgres adapter (postgres.ts) satisfies the same Database port for prod.
 */

class InMemoryRepo<T> implements Repo<T> {
  private readonly rows = new Map<string, T>();

  constructor(private readonly idOf: (row: T) => string) {}

  private clone(row: T): T {
    return structuredClone(row);
  }

  async get(id: string): Promise<T | null> {
    const row = this.rows.get(id);
    return row ? this.clone(row) : null;
  }

  async require(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError(id);
    return row;
  }

  async insert(row: T): Promise<T> {
    const id = this.idOf(row);
    if (this.rows.has(id)) throw new DuplicateKeyError(id);
    this.rows.set(id, this.clone(row));
    return this.clone(row);
  }

  async insertMany(rows: T[]): Promise<T[]> {
    const out: T[] = [];
    for (const r of rows) out.push(await this.insert(r));
    return out;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError(id);
    const updated = { ...existing, ...patch } as T;
    this.rows.set(id, this.clone(updated));
    return this.clone(updated);
  }

  async upsert(row: T): Promise<T> {
    const id = this.idOf(row);
    this.rows.set(id, this.clone(row));
    return this.clone(row);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async all(): Promise<T[]> {
    return [...this.rows.values()].map((r) => this.clone(r));
  }

  async find(predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async findOne(predicate: (row: T) => boolean): Promise<T | null> {
    for (const row of this.rows.values()) {
      if (predicate(row)) return this.clone(row);
    }
    return null;
  }

  async count(predicate?: (row: T) => boolean): Promise<number> {
    if (!predicate) return this.rows.size;
    return (await this.find(predicate)).length;
  }
}

export class NotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`row not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class DuplicateKeyError extends Error {
  constructor(public readonly id: string) {
    super(`duplicate key: ${id}`);
    this.name = "DuplicateKeyError";
  }
}

const byId = <T extends { id: string }>() => new InMemoryRepo<T>((r) => r.id);

export function createMemoryDatabase(): Database {
  const repos = {
    merchants: byId(),
    merchantUsers: byId(),
    users: byId(),
    auditLogs: byId(),
    subscriptions: byId(),
    usageEvents: byId(),
    entitlements: byId(),
    integrations: byId(),
    mailboxes: byId(),
    sendingDomains: byId(),
    webhookDeliveries: byId(),
    affiliates: byId(),
    relationships: byId(),
    payoutAccounts: byId(),
    taxDocuments: byId(),
    programs: byId(),
    offers: byId(),
    codes: byId(),
    creatives: byId(),
    agreements: byId(),
    agreementAcceptances: byId(),
    customers: byId(),
    orders: byId(),
    clicks: new InMemoryRepo<import("./entities.js").Click>((r) => r.clickId),
    conversions: byId(),
    ledger: byId(),
    overrides: byId(),
    payoutBatches: byId(),
    payouts: byId(),
    payoutAdjustments: byId(),
    affiliateNotes: byId(),
    affiliateTasks: byId(),
    affiliateMessages: byId(),
    prospects: byId(),
    prospectSources: byId(),
    prospectSignals: byId(),
    campaigns: byId(),
    outreachMessages: byId(),
    replies: byId(),
    suppressions: byId(),
    apiKeys: byId(),
    webhookSubscriptions: byId(),
  } as unknown as Database;

  const db: Database = {
    ...repos,
    async transaction<R>(fn: (db: Database) => Promise<R>): Promise<R> {
      // In-memory has no isolation; this is a passthrough that preserves the
      // contract. The Postgres adapter wraps a real BEGIN/COMMIT.
      return fn(db);
    },
    async reset(): Promise<void> {
      Object.assign(db, createMemoryDatabase());
    },
  };

  return db;
}
