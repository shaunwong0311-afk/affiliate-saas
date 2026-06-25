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
  require(id: string): Promise<T>;
  insert(row: T): Promise<T>;
  insertMany(rows: T[]): Promise<T[]>;
  update(id: string, patch: Partial<T>): Promise<T>;
  upsert(row: T): Promise<T>;
  delete(id: string): Promise<void>;
  all(): Promise<T[]>;
  find(predicate: (row: T) => boolean): Promise<T[]>;
  findOne(predicate: (row: T) => boolean): Promise<T | null>;
  count(predicate?: (row: T) => boolean): Promise<number>;
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

  // API surface
  apiKeys: Repo<ApiKey>;
  webhookSubscriptions: Repo<WebhookSubscription>;

  /** Run work in a transaction. In-memory is a no-op passthrough. */
  transaction<R>(fn: (db: Database) => Promise<R>): Promise<R>;
  /** Drop all data (test/dev convenience). */
  reset(): Promise<void>;
}
