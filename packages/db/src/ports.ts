import type {
  Affiliate,
  AffiliateRelationship,
  PayoutAccount,
  TaxDocument,
  Program,
  Offer,
  AffiliateCode,
  Order,
  Click,
  Conversion,
  LedgerEntry,
  Merchant,
  MerchantUser,
  User,
  AuditLog,
  BillingSubscription,
  UsageEvent,
  Entitlement,
  MerchantIntegration,
  Mailbox,
  SendingDomain,
  WebhookDelivery,
  Customer,
  PayoutBatch,
  Payout,
  PayoutAdjustment,
  Creative,
  Override,
  AffiliateNote,
  AffiliateTask,
  AffiliateMessage,
  Agreement,
  AgreementAcceptance,
  Prospect,
  ProspectSource,
  ProspectSignal,
  OutreachCampaign,
  OutreachMessage,
  Reply,
  Suppression,
  ProspectOutcome,
  Meeting,
  AutomationState,
  FrontierMerchant,
  MerchantFaq,
  Handoff,
  DmTask,
  SecretRow,
  ApiKey,
  WebhookSubscription,
} from "./entities.js";

/**
 * A minimal repository port. Implementations: in-memory (default runtime, zero
 * external services) and Postgres (production). All methods are async so the
 * Postgres adapter is a drop-in. The ports are the persistence *contract* that
 * the substrate services, the tracking edge, the recruitment workers, and the API
 * all build against — defined once so every consumer agrees on the same shape.
 */
export interface Repo<T> {
  get(id: string): Promise<T | null>;
  /** Like `get`, but throws NotFoundError. */
  require(id: string): Promise<T>;
  /** Throws DuplicateKeyError on an existing id, UniqueViolationError on a declared uniqueness rule. */
  insert(row: T): Promise<T>;
  /** All rows or none. */
  insertMany(rows: T[]): Promise<T[]>;
  /**
   * Shallow-merges `patch` into the stored row in ONE atomic step (a key set to `undefined`
   * is removed). Throws NotFoundError when the row does not exist.
   */
  update(id: string, patch: Partial<T>): Promise<T>;
  upsert(row: T): Promise<T>;
  delete(id: string): Promise<void>;
  /** Rows in insertion order — the same order in both adapters. */
  all(): Promise<T[]>;
  find(predicate: (row: T) => boolean): Promise<T[]>;
  /** The first match in insertion order. */
  findOne(predicate: (row: T) => boolean): Promise<T | null>;
  count(predicate?: (row: T) => boolean): Promise<number>;
}

export interface TransactionOptions {
  /**
   * Serialize this transaction with every other transaction that names the same key — in
   * this process and across processes. On Postgres it is a transaction-scoped advisory lock
   * taken on the transaction's own connection, so the lock and the writes share one fate:
   * if the connection dies, both go. Released at commit or rollback.
   *
   * This is a separate namespace from `withLock` keys: the two never block each other.
   */
  lock?: string;
  /** How long to wait for `lock` before failing with LockTimeoutError. Default 30 s. */
  lockTimeoutMs?: number;
}

export interface LockOptions {
  /** How long to wait for the lock before failing with LockTimeoutError. Default 30 s. */
  timeoutMs?: number;
}

export interface Database {
  // Tenancy
  merchants: Repo<Merchant>;
  merchantUsers: Repo<MerchantUser>;
  users: Repo<User>;
  auditLogs: Repo<AuditLog>;

  // Billing
  subscriptions: Repo<BillingSubscription>;
  usageEvents: Repo<UsageEvent>;
  entitlements: Repo<Entitlement>;

  // Integrations
  integrations: Repo<MerchantIntegration>;
  mailboxes: Repo<Mailbox>;
  secrets: Repo<SecretRow>;
  sendingDomains: Repo<SendingDomain>;
  webhookDeliveries: Repo<WebhookDelivery>;

  // Identity graph
  affiliates: Repo<Affiliate>;
  relationships: Repo<AffiliateRelationship>;
  payoutAccounts: Repo<PayoutAccount>;
  taxDocuments: Repo<TaxDocument>;

  // Programs & offers
  programs: Repo<Program>;
  offers: Repo<Offer>;
  codes: Repo<AffiliateCode>;
  creatives: Repo<Creative>;
  agreements: Repo<Agreement>;
  agreementAcceptances: Repo<AgreementAcceptance>;

  // Orders / attribution / ledger
  customers: Repo<Customer>;
  orders: Repo<Order>;
  clicks: Repo<Click>;
  conversions: Repo<Conversion>;
  ledger: Repo<LedgerEntry>;
  overrides: Repo<Override>;

  // Payouts
  payoutBatches: Repo<PayoutBatch>;
  payouts: Repo<Payout>;
  payoutAdjustments: Repo<PayoutAdjustment>;

  // CRM
  affiliateNotes: Repo<AffiliateNote>;
  affiliateTasks: Repo<AffiliateTask>;
  affiliateMessages: Repo<AffiliateMessage>;

  // Recruitment
  prospects: Repo<Prospect>;
  prospectSources: Repo<ProspectSource>;
  prospectSignals: Repo<ProspectSignal>;
  campaigns: Repo<OutreachCampaign>;
  outreachMessages: Repo<OutreachMessage>;
  replies: Repo<Reply>;
  suppressions: Repo<Suppression>;
  prospectOutcomes: Repo<ProspectOutcome>;
  meetings: Repo<Meeting>;
  automationStates: Repo<AutomationState>;
  frontierMerchants: Repo<FrontierMerchant>;
  merchantFaqs: Repo<MerchantFaq>;
  handoffs: Repo<Handoff>;
  dmTasks: Repo<DmTask>;

  // API surface
  apiKeys: Repo<ApiKey>;
  webhookSubscriptions: Repo<WebhookSubscription>;

  /**
   * Run `fn` in a transaction: everything it writes is committed together, or — when it
   * throws — rolled back together. Same behaviour in both adapters.
   *
   *  - `fn` receives a handle bound to the transaction (on Postgres: ONE dedicated
   *    connection). Use it for every read and write inside `fn`. As a safety net the
   *    transaction also follows the async call chain, so a helper that was handed the outer
   *    `db` still joins it instead of silently running outside it.
   *  - Calling `transaction` inside a transaction nests (a savepoint): a throw undoes only
   *    the inner work and the outer one may carry on.
   *  - A failed write (duplicate key, uniqueness rule) aborts the transaction it ran in:
   *    every later statement throws TransactionAbortedError and it cannot commit. Wrap a
   *    write that is allowed to fail in a nested transaction and catch outside it.
   *  - The handle outlives the transaction harmlessly: once it has ended, late calls (a
   *    fire-and-forget task started inside) run as ordinary auto-committed statements.
   *
   * Do not call external services inside `fn`; their effects cannot be rolled back.
   * The in-memory adapter gives no isolation between concurrent transactions — name a
   * `lock` when two of them must not interleave.
   */
  transaction<R>(fn: (db: Database) => Promise<R>, opts?: TransactionOptions): Promise<R>;
  /**
   * Run `fn` while holding an exclusive lock on `key`: callers on the same key run one at a
   * time, in this process and across processes (Postgres: a session advisory lock on a
   * dedicated connection held for the duration; in-memory: an async mutex).
   *
   * Re-entrant: `fn` may call `withLock` on the same key again. It is NOT a transaction —
   * writes inside commit as they happen — and it is not fenced: if the lock's connection is
   * lost mid-way the work continues unprotected, so money paths also take
   * `transaction(..., { lock })`. Do not nest locks on different keys in different orders.
   */
  withLock<R>(key: string, fn: (db: Database) => Promise<R>, opts?: LockOptions): Promise<R>;
  /** Drop all data (test/dev convenience). */
  reset(): Promise<void>;
  /** Release connections. A no-op for the in-memory adapter. */
  close(): Promise<void>;
}
