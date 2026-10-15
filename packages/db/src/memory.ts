import { AsyncLocalStorage } from "node:async_hooks";
import type { Database, LockOptions, Repo, TransactionOptions } from "./ports.js";
import { constraintFieldNames, constraintsFor, uniqueKeyOf, type CollectionName, type UniqueConstraint } from "./constraints.js";
import { DuplicateKeyError, NotFoundError, TransactionAbortedError, UniqueViolationError } from "./errors.js";
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
 * In-memory repository implementation — the DEFAULT runtime. It lets the entire
 * platform boot and run end-to-end with zero external services (no Postgres, no
 * Redis), which is what makes the demo, the tests, and local development possible.
 * The Postgres adapter (postgres.ts) satisfies the same Database port for prod.
 *
 * It is held to the same contract as Postgres so a test that passes here means
 * something there: rows come back in insertion order, the uniqueness rules in
 * constraints.ts are enforced on every write, `transaction` really rolls back, a failed
 * write aborts its transaction, and `withLock` really excludes. What it does NOT give is
 * isolation between two transactions that run at once without a lock.
 */

/** Every collection and the field that holds its primary key. */
const COLLECTIONS: Record<CollectionName, string> = {
  merchants: "id",
  merchantUsers: "id",
  users: "id",
  auditLogs: "id",
  subscriptions: "id",
  usageEvents: "id",
  entitlements: "id",
  integrations: "id",
  mailboxes: "id",
  secrets: "id",
  sendingDomains: "id",
  webhookDeliveries: "id",
  affiliates: "id",
  relationships: "id",
  payoutAccounts: "id",
  taxDocuments: "id",
  programs: "id",
  offers: "id",
  codes: "id",
  creatives: "id",
  agreements: "id",
  agreementAcceptances: "id",
  customers: "id",
  orders: "id",
  clicks: "clickId",
  conversions: "id",
  ledger: "id",
  overrides: "id",
  payoutBatches: "id",
  payouts: "id",
  payoutAdjustments: "id",
  affiliateNotes: "id",
  affiliateTasks: "id",
  affiliateMessages: "id",
  prospects: "id",
  prospectSources: "id",
  prospectSignals: "id",
  campaigns: "id",
  outreachMessages: "id",
  replies: "id",
  suppressions: "id",
  prospectOutcomes: "id",
  meetings: "id",
  automationStates: "id",
  frontierMerchants: "id",
  merchantFaqs: "id",
  handoffs: "id",
  dmTasks: "id",
  apiKeys: "id",
  webhookSubscriptions: "id",
};

/** One open transaction, or a nested one (the equivalent of a savepoint). */
interface Scope {
  /** How to undo each write made in this scope, oldest first. */
  undo: Array<() => void>;
  /** A statement failed here: nothing more may run and it cannot commit. */
  aborted: boolean;
  /** Committed or rolled back. Late callers fall through to the enclosing scope, or none. */
  closed: boolean;
  parent: Scope | null;
  /** Outermost scope only: transaction locks it holds, and their releases for when it ends. */
  txLocks: Set<string>;
  onEnd: Array<() => void>;
}

const rootOf = (scope: Scope): Scope => {
  let s = scope;
  while (s.parent) s = s.parent;
  return s;
};

const clone = <T>(row: T): T => structuredClone(row);

/** The rows of one collection plus the lookup that enforces its uniqueness rules. */
class Store<T> {
  readonly rows = new Map<string, T>();
  private readonly uniques: Array<{ constraint: UniqueConstraint; owners: Map<string, string> }>;

  constructor(
    readonly collection: string,
    private readonly idField: string,
  ) {
    this.uniques = constraintsFor(collection).map((constraint) => ({ constraint, owners: new Map() }));
  }

  idOf(row: T): string {
    return (row as Record<string, unknown>)[this.idField] as string;
  }

  /** Throws when storing `row` under `id` would collide with a DIFFERENT row. */
  assertUnique(id: string, row: T): void {
    for (const { constraint, owners } of this.uniques) {
      const key = uniqueKeyOf(constraint, row);
      if (key === null) continue;
      const owner = owners.get(key);
      if (owner !== undefined && owner !== id) {
        throw new UniqueViolationError(constraint.name, this.collection, constraintFieldNames(constraint));
      }
    }
  }

  /** Store `row` under `id`. A replaced row keeps its place in the insertion order. */
  put(id: string, row: T): void {
    const previous = this.rows.get(id);
    if (previous !== undefined) this.unindex(id, previous);
    this.rows.set(id, row);
    this.index(id, row);
  }

  remove(id: string): void {
    const previous = this.rows.get(id);
    if (previous === undefined) return;
    this.unindex(id, previous);
    this.rows.delete(id);
  }

  positionOf(id: string): number {
    let i = 0;
    for (const key of this.rows.keys()) {
      if (key === id) return i;
      i += 1;
    }
    return -1;
  }

  /** Put a deleted row back where it was (rolling back a delete must not reorder the table). */
  restoreAt(position: number, id: string, row: T): void {
    const entries = [...this.rows.entries()];
    entries.splice(Math.min(Math.max(position, 0), entries.length), 0, [id, row]);
    this.rows.clear();
    for (const [key, value] of entries) this.rows.set(key, value);
    this.index(id, row);
  }

  clear(): void {
    this.rows.clear();
    for (const u of this.uniques) u.owners.clear();
  }

  private index(id: string, row: T): void {
    for (const { constraint, owners } of this.uniques) {
      const key = uniqueKeyOf(constraint, row);
      if (key !== null) owners.set(key, id);
    }
  }

  private unindex(id: string, row: T): void {
    for (const { constraint, owners } of this.uniques) {
      const key = uniqueKeyOf(constraint, row);
      if (key !== null && owners.get(key) === id) owners.delete(key);
    }
  }
}

class InMemoryRepo<T> implements Repo<T> {
  constructor(
    private readonly store: Store<T>,
    /** The transaction scope a call made right now belongs to, if any. */
    private readonly scope: () => Scope | null,
  ) {}

  /** The scope this call runs in. Refuses to run in one a failed statement has aborted. */
  private enter(): Scope | null {
    const scope = this.scope();
    if (scope?.aborted) throw new TransactionAbortedError();
    return scope;
  }

  /** A constraint failure aborts the transaction it happened in, as it does on Postgres. */
  private static constrained(scope: Scope | null, check: () => void): void {
    try {
      check();
    } catch (err) {
      if (scope) scope.aborted = true;
      throw err;
    }
  }

  private insertNow(scope: Scope | null, row: T): T {
    const id = this.store.idOf(row);
    InMemoryRepo.constrained(scope, () => {
      if (this.store.rows.has(id)) throw new DuplicateKeyError(id);
      this.store.assertUnique(id, row);
    });
    this.store.put(id, clone(row));
    scope?.undo.push(() => this.store.remove(id));
    return clone(row);
  }

  async get(id: string): Promise<T | null> {
    this.enter();
    const row = this.store.rows.get(id);
    return row !== undefined ? clone(row) : null;
  }

  async require(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError(id);
    return row;
  }

  async insert(row: T): Promise<T> {
    return this.insertNow(this.enter(), row);
  }

  async insertMany(rows: T[]): Promise<T[]> {
    const scope = this.enter();
    const undoMark = scope ? scope.undo.length : 0;
    const inserted: string[] = [];
    try {
      const out: T[] = [];
      for (const row of rows) {
        out.push(this.insertNow(scope, row));
        inserted.push(this.store.idOf(row));
      }
      return out;
    } catch (err) {
      // All or nothing, inside a transaction or not.
      for (const id of inserted.reverse()) this.store.remove(id);
      if (scope) scope.undo.length = undoMark;
      throw err;
    }
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const scope = this.enter();
    const existing = this.store.rows.get(id);
    if (existing === undefined) throw new NotFoundError(id);
    const updated = clone({ ...existing, ...patch } as T);
    InMemoryRepo.constrained(scope, () => this.store.assertUnique(id, updated));
    this.store.put(id, updated);
    scope?.undo.push(() => this.store.put(id, existing));
    return clone(updated);
  }

  async upsert(row: T): Promise<T> {
    const scope = this.enter();
    const id = this.store.idOf(row);
    const existing = this.store.rows.get(id);
    InMemoryRepo.constrained(scope, () => this.store.assertUnique(id, row));
    this.store.put(id, clone(row));
    scope?.undo.push(() => (existing === undefined ? this.store.remove(id) : this.store.put(id, existing)));
    return clone(row);
  }

  async delete(id: string): Promise<void> {
    const scope = this.enter();
    const existing = this.store.rows.get(id);
    if (existing === undefined) return;
    const position = this.store.positionOf(id);
    this.store.remove(id);
    scope?.undo.push(() => this.store.restoreAt(position, id, existing));
  }

  async all(): Promise<T[]> {
    this.enter();
    return [...this.store.rows.values()].map(clone);
  }

  async find(predicate: (row: T) => boolean): Promise<T[]> {
    this.enter();
    const out: T[] = [];
    for (const row of this.store.rows.values()) {
      if (predicate(row)) out.push(clone(row));
    }
    return out;
  }

  async findOne(predicate: (row: T) => boolean): Promise<T | null> {
    this.enter();
    for (const row of this.store.rows.values()) {
      if (predicate(row)) return clone(row);
    }
    return null;
  }

  async count(predicate?: (row: T) => boolean): Promise<number> {
    if (!predicate) {
      this.enter();
      return this.store.rows.size;
    }
    return (await this.find(predicate)).length;
  }
}

export function createMemoryDatabase(): Database {
  const stores = new Map<string, Store<unknown>>();
  for (const [collection, idField] of Object.entries(COLLECTIONS)) {
    stores.set(collection, new Store<unknown>(collection, idField));
  }
  // Per database, so two stores in one process (tests) never share a transaction.
  const ambient = new AsyncLocalStorage<Ambient<Scope>>();
  const mutex = new KeyedMutex();

  /** The innermost transaction still open in the current async call chain. */
  const ambientScope = (): Scope | null => {
    let scope = ambient.getStore()?.tx ?? null;
    while (scope && scope.closed) scope = scope.parent;
    return scope;
  };

  /**
   * Where a call through a handle bound to `bound` belongs: the bound transaction (or a
   * transaction nested in it that the current call chain is inside); once that has ended,
   * wherever the call chain is now.
   */
  const resolve = (bound: Scope | null): Scope | null => {
    const current = ambientScope();
    if (!bound || bound.closed) return current;
    for (let scope = current; scope; scope = scope.parent) {
      if (scope === bound) return current;
    }
    return bound;
  };

  const handle = (bound: Scope | null): Database => {
    const scope = () => resolve(bound);
    const repos: Record<string, unknown> = {};
    for (const [collection, store] of stores) repos[collection] = new InMemoryRepo(store, scope);
    const db = repos as unknown as Database;
    db.transaction = (fn, opts) => transaction(bound, fn, opts);
    db.withLock = (key, fn, opts) => withLock(db, key, fn, opts);
    db.reset = async () => {
      for (const store of stores.values()) store.clear();
    };
    db.close = async () => {};
    return db;
  };

  async function transaction<R>(
    bound: Scope | null,
    fn: (db: Database) => Promise<R>,
    opts: TransactionOptions = {},
  ): Promise<R> {
    const parent = resolve(bound);
    if (parent?.aborted) throw new TransactionAbortedError();

    const scope: Scope = { undo: [], aborted: false, closed: false, parent, txLocks: new Set(), onEnd: [] };
    const root = rootOf(scope);
    if (opts.lock !== undefined) {
      const key = transactionLockKey(opts.lock);
      // Re-entrant within one transaction; held until the OUTERMOST transaction ends.
      if (!root.txLocks.has(key)) {
        const release = await mutex.acquire(key, opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
        root.txLocks.add(key);
        root.onEnd.push(release);
      }
    }

    try {
      const state = ambient.getStore();
      const result = await ambient.run({ tx: scope, locks: state?.locks ?? NO_LOCKS }, () => fn(handle(scope)));
      // A failed statement whose error was swallowed still means the work cannot commit.
      if (scope.aborted) throw new TransactionAbortedError();
      scope.closed = true;
      // Nested: the enclosing transaction now owns these writes and can still undo them.
      if (parent) parent.undo.push(...scope.undo);
      return result;
    } catch (err) {
      scope.closed = true;
      for (let i = scope.undo.length - 1; i >= 0; i -= 1) scope.undo[i]!();
      throw err;
    } finally {
      if (!parent) for (const end of scope.onEnd) end();
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

    const release = await mutex.acquire(lockKey, opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const held: HeldLock = { released: false };
    try {
      return await ambient.run({ tx: state?.tx ?? null, locks: withHeld(state?.locks, lockKey, held) }, () => fn(db));
    } finally {
      held.released = true;
      release();
    }
  }

  return handle(null);
}

/** The collection names this adapter knows — the Postgres adapter must list the same ones. */
export const MEMORY_COLLECTIONS: readonly string[] = Object.keys(COLLECTIONS);
