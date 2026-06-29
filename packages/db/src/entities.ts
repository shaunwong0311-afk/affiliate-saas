/**
 * Persistence entities that are not part of the pure domain core (tenancy,
 * billing, integrations, recruitment, CRM, governance). Domain entities
 * (Affiliate, Offer, Order, Conversion, LedgerEntry, ...) are imported from
 * @affiliate/core and re-exported so the db package is a single source of types.
 */
import type {
  Id,
  Timestamp,
  CurrencyCode,
  ProspectState,
  Tier,
} from "@affiliate/core";

export type {
  Affiliate,
  AffiliateRelationship,
  PayoutAccount,
  TaxDocument,
  Program,
  Offer,
  CommissionTier,
  Bonus,
  OverridePolicy,
  AffiliateCode,
  Order,
  OrderLineItem,
  Click,
  Conversion,
  LedgerEntry,
  Attribution,
} from "@affiliate/core";

// ---- Tenancy ----------------------------------------------------------------
export interface Merchant {
  id: Id;
  name: string;
  status: "trial" | "active" | "suspended" | "cancelled";
  niche: string | null;
  competitors: string[];
  billingStatus: "trialing" | "active" | "past_due" | "cancelled";
  defaultCurrency: CurrencyCode;
  /** Per-merchant secret for HMAC postback verification (Section 6). */
  postbackSecret: string;
  physicalAddress: string | null; // CAN-SPAM compliance
  /** Outreach personalization plan (billed differently). Default "hybrid" when unset:
   *  template = tokens only · hybrid = LLM for A-tier, tokens otherwise · llm = LLM for all. */
  personalizationPlan?: "template" | "hybrid" | "llm";
  createdAt: Timestamp;
}

export type MerchantRole = "owner" | "admin" | "manager" | "analyst" | "viewer";

export interface MerchantUser {
  id: Id;
  merchantId: Id;
  userId: Id;
  email: string;
  name: string;
  role: MerchantRole;
  status: "active" | "invited" | "disabled";
}

export interface User {
  id: Id;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Timestamp;
}

export interface AuditLog {
  id: Id;
  merchantId: Id;
  actorId: Id | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  metadata: Record<string, unknown>;
  ts: Timestamp;
}

// ---- Billing and entitlements ----------------------------------------------
export type PlanKind = "track_export" | "managed_payouts" | "done_for_you";

export interface BillingSubscription {
  id: Id;
  merchantId: Id;
  plan: PlanKind;
  status: "trialing" | "active" | "past_due" | "cancelled";
  trialEndsAt: Timestamp | null;
  renewsAt: Timestamp | null;
}

export interface UsageEvent {
  id: Id;
  merchantId: Id;
  kind: "enrichment" | "send" | "active_affiliate" | "recruitment_credit" | "conversion" | "personalization";
  quantity: number;
  sourceId: string | null;
  ts: Timestamp;
}

export interface Entitlement {
  id: Id;
  merchantId: Id;
  feature: string;
  limitValue: number | null; // null = unlimited
  sourcePlan: PlanKind;
}

// ---- Integrations -----------------------------------------------------------
export interface MerchantIntegration {
  id: Id;
  merchantId: Id;
  kind: "shopify" | "woocommerce" | "stripe" | "s2s" | "klaviyo" | "hubspot" | "chargebee" | "recurly";
  status: "connected" | "error" | "disconnected";
  credentialsRef: string; // pointer into secret store; never the secret itself
  config: Record<string, unknown>;
  lastSyncAt: Timestamp | null;
}

export interface Mailbox {
  id: Id;
  merchantId: Id;
  provider: "gmail" | "microsoft" | "smtp";
  email: string;
  status: "connected" | "warming" | "error" | "disconnected";
  dailyCap: number;
  warmupStatus: "not_started" | "warming" | "ready";
  credentialsRef: string;
}

export interface SendingDomain {
  id: Id;
  merchantId: Id;
  domain: string;
  spfStatus: DnsStatus;
  dkimStatus: DnsStatus;
  dmarcStatus: DnsStatus;
  warmupStatus: "not_started" | "warming" | "ready";
}

export type DnsStatus = "pending" | "verified" | "failed";

export interface WebhookDelivery {
  id: Id;
  merchantId: Id;
  eventType: string;
  targetUrl: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  ts: Timestamp;
}

export interface Customer {
  id: Id;
  merchantId: Id;
  externalCustomerId: string | null;
  emailHash: string | null;
  country: string | null;
  firstSeenAt: Timestamp;
}

// ---- Payouts ----------------------------------------------------------------
export interface PayoutBatch {
  id: Id;
  merchantId: Id;
  rail: string;
  currency: CurrencyCode;
  status: "draft" | "approved" | "processing" | "paid" | "failed";
  approvedBy: Id | null;
  ts: Timestamp;
}

export interface Payout {
  id: Id;
  batchId: Id | null;
  merchantId: Id;
  affiliateId: Id;
  amountCents: number;
  currency: CurrencyCode;
  method: string;
  status: "pending" | "processing" | "paid" | "failed" | "held";
  failureReason: string | null;
  ts: Timestamp;
}

export interface PayoutAdjustment {
  id: Id;
  merchantId: Id;
  affiliateId: Id;
  amountCents: number;
  currency: CurrencyCode;
  reason: string;
  createdBy: Id;
  ts: Timestamp;
}

// ---- Program mechanics extras ----------------------------------------------
export interface Creative {
  id: Id;
  merchantId: Id;
  programId: Id;
  type: "banner" | "swipe_copy" | "product_feed" | "video" | "qr" | "landing_page";
  name: string;
  assetRef: string;
  metadata: Record<string, unknown>;
  status: "active" | "archived";
}

export interface Override {
  id: Id;
  conversionId: Id;
  beneficiaryAffiliateId: Id;
  level: number;
  amountCents: number;
}

// ---- CRM --------------------------------------------------------------------
export interface AffiliateNote {
  id: Id;
  relationshipId: Id;
  authorId: Id;
  body: string;
  ts: Timestamp;
}

export interface AffiliateTask {
  id: Id;
  relationshipId: Id;
  ownerUserId: Id;
  title: string;
  dueAt: Timestamp | null;
  status: "open" | "done";
}

export interface AffiliateMessage {
  id: Id;
  relationshipId: Id;
  direction: "inbound" | "outbound";
  channel: "email" | "in_app" | "other";
  subject: string | null;
  bodyRef: string;
  ts: Timestamp;
}

export interface Agreement {
  id: Id;
  merchantId: Id;
  programId: Id;
  version: string;
  bodyRef: string;
  effectiveAt: Timestamp;
}

export interface AgreementAcceptance {
  id: Id;
  agreementId: Id;
  affiliateId: Id;
  relationshipId: Id;
  acceptedAt: Timestamp;
  ip: string | null;
}

// ---- Recruitment ------------------------------------------------------------
export interface Prospect {
  id: Id;
  merchantId: Id;
  source: string;
  identity: string; // resolved name / handle
  siteUrl: string | null;
  channelUrl: string | null;
  email: string | null;
  state: ProspectState;
  score: number | null;
  tier: Tier | null;
  country: string | null;
  language: string | null;
  suppressionStatus: "none" | "suppressed" | "bounced";
  scoreBreakdown: unknown | null;
  /**
   * TRUE when this prospect was produced by a deterministic/synthetic source
   * (no real web data). The dashboard must label these as demo data and they are
   * excluded from "real" counts.
   */
  synthetic: boolean;
  /** Score confidence 0..1 — share of scoring weight backed by real signals. */
  confidence: number | null;
  /** Evidence: the affiliate links found, the competitor promoted, contact source. */
  evidence: {
    affiliateLinks?: { url: string; network: string; confidence: string; verified?: boolean }[];
    competitorPromoted?: string | null;
    /** How the email was obtained: "page:mailto" | "bio_aggregator:mailto" | "pattern-guess" | null. */
    contactSource?: string | null;
    /** Contact emails extracted from the real fetched page (unverified candidates). */
    contactEmails?: { email: string; source: string }[];
    /** Contact-bearing pages the creator linked (Linktree, /contact, YouTube About). */
    contactUrls?: { url: string; kind: string }[];
    /** A contact FORM was detected (no raw email) — route to the human gate. */
    contactForm?: boolean;
    /** The page URL carrying the contact form, for the operator to open. */
    contactFormUrl?: string | null;
    /**
     * Resolved creator identity graph: the surfaces this person owns across
     * platforms, each with provenance + confidence (profile-graph plan, Phase 1).
     */
    profile?: {
      primary: { platform: string; handle: string | null; url: string; provenance: string; confidence: number } | null;
      accounts: { platform: string; handle: string | null; url: string; provenance: string; confidence: number }[];
      audience: { reach: number | null; primaryGeo: string | null; language: string | null; engagementRate: number | null; source: string | null };
      identityConfidence: number;
    } | null;
    pageUrl?: string | null;
  } | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ProspectSource {
  id: Id;
  prospectId: Id;
  sourceType: string;
  evidenceUrl: string | null;
  evidenceSummary: string | null;
  capturedAt: Timestamp;
}

export interface ProspectSignal {
  id: Id;
  prospectId: Id;
  /** Topical relevance 0..1 (embedding similarity). Real-ish. */
  relevance: number;
  /** Has a HIGH-confidence (named-network) affiliate link. */
  isAffiliate: boolean;
  /** Promotes a competitor with a TRUSTWORTHY (verified/high-confidence) link. */
  promotesCompetitor: boolean;
  /** Commercial-intent score 0..1 from real page text. */
  intent: number;
  /** Verified deliverable email on file. */
  verifiedEmail: boolean;
  // ---- Provider-required signals. null = UNKNOWN (no provider wired). Never
  // invented; excluded from scoring and lowering confidence when null. ----------
  reach: number | null;
  da: number | null;
  engagement: number | null;
  audienceOverlap: number | null;
}

export interface OutreachCampaign {
  id: Id;
  merchantId: Id;
  mailboxId: Id | null;
  sendingDomainId: Id | null;
  name: string;
  sequence: SequenceStep[];
  sendWindow: { startHour: number; endHour: number; timezone: string };
  dailyCap: number;
  status: "draft" | "active" | "paused" | "archived";
}

export interface SequenceStep {
  step: number;
  delayDays: number;
  subject: string;
  body: string; // template with {{tokens}}
  kind: "initial" | "follow_up" | "breakup";
}

export interface OutreachMessage {
  id: Id;
  prospectId: Id;
  campaignId: Id;
  step: number;
  variant: string | null;
  subject: string;
  body: string;
  sentAt: Timestamp | null;
  status: "queued" | "sent" | "bounced" | "replied" | "failed";
}

export interface Reply {
  id: Id;
  prospectId: Id;
  raw: string;
  classification: "interested" | "question" | "not_interested" | "out_of_office" | "unsubscribe" | "unknown";
  handledBy: string | null; // user id or 'ai_sdr'
  ts: Timestamp;
}

export interface Suppression {
  id: Id;
  merchantId: Id | null; // null = global
  email: string | null;
  domain: string | null;
  reason: string;
  scope: "global" | "merchant";
  ts: Timestamp;
}

// ---- Recruitment closed-loop + meetings -------------------------------------
/**
 * Append-only outcome events per prospect — the durable substrate for
 * source-yield pruning, cost-per-producing-affiliate, and the learned-weights
 * loop. recordOutcome appends here instead of overwriting a JSON field.
 */
export interface ProspectOutcome {
  id: Id;
  merchantId: Id;
  prospectId: Id;
  relationshipId: Id | null;
  sourceType: string;
  label:
    | "bad_fit"
    | "wrong_contact"
    | "not_an_affiliate"
    | "already_partnered"
    | "competitor_exclusive"
    | "high_potential"
    | "produced_sales";
  /** Realized revenue attributed to this prospect once producing (for ROI). */
  producedRevenueCents: number;
  ts: Timestamp;
}

/** A booked call with an A-tier prospect (the managed, human-closed track). */
export interface Meeting {
  id: Id;
  merchantId: Id;
  prospectId: Id;
  ownerUserId: Id | null;
  scheduledAt: Timestamp | null;
  status: "requested" | "booked" | "completed" | "no_show" | "cancelled";
  bookingRef: string | null;
  bookingUrl: string | null;
  notes: string | null;
  createdAt: Timestamp;
}

/** Per-merchant autonomous-engine control state (the scheduler reads this). */
export interface AutomationState {
  id: Id; // == merchantId (one row per merchant)
  merchantId: Id;
  status: "off" | "running" | "paused";
  /** Auto-send threshold: prospects scoring at/above this auto-advance to outreach. */
  autoSendMinScore: number;
  /** Tier at/above which a human must approve before the first send. */
  hitlTier: "A" | "B" | "C";
  /** Tier at/above which an interested reply books a meeting (managed track). */
  meetingTier: "A" | "B" | "C";
  sourcingLimitPerCycle: number;
  lastCycleAt: Timestamp | null;
  updatedAt: Timestamp;
}

/**
 * A node in the recursive discovery frontier (merchant-expansion engine). Each row
 * is a competitor domain queued to be backlink-mined; expansion promotes the
 * merchants that discovered affiliates ALSO promote (co-promotion) into new nodes,
 * so the engine snowballs across the niche. (tenant, domain) is the visited set.
 */
export interface FrontierMerchant {
  id: Id;
  merchantId: Id; // tenant
  /** Mineable host — the competitor's apex or a vanity affiliate domain. */
  domain: string;
  label: string;
  /** Hops from a seed competitor (0 = seed). */
  depth: number;
  /** How many discovered affiliates promote this merchant — the relevance signal. */
  coPromotions: number;
  status: "pending" | "mined" | "skipped";
  source: "seed" | "expansion";
  /** The affiliate/merchant whose links surfaced this node. */
  discoveredFrom: string | null;
  createdAt: Timestamp;
  processedAt: Timestamp | null;
}

// ---- API surface / webhooks -------------------------------------------------
export interface ApiKey {
  id: Id;
  merchantId: Id;
  name: string;
  prefix: string;
  hashedKey: string;
  scopes: string[];
  lastUsedAt: Timestamp | null;
  createdAt: Timestamp;
  revokedAt: Timestamp | null;
}

export interface WebhookSubscription {
  id: Id;
  merchantId: Id;
  url: string;
  events: string[];
  secret: string;
  status: "active" | "disabled";
}

// ---- Future MLM (not built) -------------------------------------------------
export interface Volume {
  id: Id;
  affiliateId: Id;
  period: string;
  pvCents: number;
  gvCents: number;
}

export interface RankRecord {
  id: Id;
  affiliateId: Id;
  period: string;
  rank: string;
  qualified: boolean;
}
