import type { Order } from "@affiliate/core";

/**
 * Adapter ports for every external service the platform talks to. Each has a
 * deterministic stub implementation so the whole system runs with zero external
 * dependencies; production swaps in a real adapter behind the same interface.
 * This is the boundary the Section 14 risk note draws — money/compliance code is
 * only as good as these adapters, so they are explicit and individually testable.
 */

// ---- Order / event ingestion (Section 4) -----------------------------------
/** Raw inbound payload + the merchant it belongs to. */
export interface IngestionInput {
  merchantId: string;
  raw: unknown;
  /** Signature header for providers that sign webhooks (Stripe, Shopify). */
  signature?: string | null;
  secret?: string | null;
}

export interface NormalizedOrder {
  order: Order;
  /** click_id carried through the funnel, if the provider relayed it. */
  clickId: string | null;
  /** External customer ref for customer mining + dedup. */
  customerRef: string | null;
}

export interface OrderNormalizer {
  readonly source: string;
  /** Returns null when the payload is not an order event (e.g. a non-order webhook). */
  normalize(input: IngestionInput): NormalizedOrder | null;
}

// ---- Payout rails (Section 4) ----------------------------------------------
export interface PayoutRequest {
  payoutId: string;
  affiliateId: string;
  accountRef: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export interface PayoutResult {
  payoutId: string;
  status: "paid" | "processing" | "failed";
  railReference: string | null;
  failureReason: string | null;
}

/** Orchestration without custody: the rail moves money, the platform conducts. */
export interface PayoutRail {
  readonly rail: string;
  disburse(request: PayoutRequest): Promise<PayoutResult>;
  /** Verify a payout account is usable (KYC handled by the rail itself). */
  verifyAccount(accountRef: string): Promise<{ ok: boolean; reason?: string }>;
}

// ---- Mailbox / sending (Section 8.4) ---------------------------------------
export interface OutboundEmail {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  /** For threading follow-ups. */
  inReplyTo?: string | null;
}

export interface SendResult {
  messageId: string;
  status: "sent" | "bounced" | "failed";
  reason?: string;
}

export interface MailboxSender {
  readonly provider: string;
  send(email: OutboundEmail): Promise<SendResult>;
}

// ---- Email finding + verification (Section 8.2) ----------------------------
export interface EmailCandidate {
  email: string;
  confidence: number; // 0..1
  verified: boolean;
  source: string;
}

export interface EmailFinder {
  readonly name: string;
  find(input: { fullName?: string; domain?: string; siteUrl?: string }): Promise<EmailCandidate[]>;
  verify(email: string): Promise<{ deliverable: boolean; reason: string }>;
}

// ---- Discovery / scraping (Section 8.1) ------------------------------------
export interface DiscoveryQuery {
  merchantId: string;
  niche: string;
  competitors: string[];
  keywords: string[];
  channels: Array<"serp" | "youtube" | "blog" | "newsletter" | "podcast" | "community">;
  limit: number;
}

export interface RawCandidate {
  identity: string;
  siteUrl: string | null;
  channelUrl: string | null;
  sourceType: string;
  evidenceUrl: string | null;
  evidenceSummary: string | null;
  /** Outbound links found on the candidate's page, for affiliate-pattern detection. */
  outboundLinks: string[];
  /** Raw page HTML (for contact extraction), if the source fetched it. */
  pageHtml?: string | null;
  reachHint?: number;
  /**
   * Set by a source that has ALREADY CONFIRMED this candidate promotes a specific
   * competitor (e.g. backlink mining filtered by the competitor's merchant id), even
   * when the visible link points at a network domain. The pipeline trusts it instead
   * of re-deriving from the URL host.
   */
  confirmedCompetitor?: string | null;
  /**
   * TRUE when this candidate is from a deterministic/synthetic source (no real web
   * data). Real sources set false. Carried through so prospects can be labeled.
   */
  synthetic: boolean;
}

/** Follows redirects to confirm where a (possibly affiliate) link actually points. */
export interface RedirectResolver {
  readonly kind: string;
  resolve(url: string): Promise<{ finalUrl: string; finalHost: string } | null>;
}

/** Verifies an email is deliverable (MX/SMTP) — distinct from guessing it exists. */
export interface EmailVerifier {
  readonly kind: string;
  verify(email: string): Promise<{ deliverable: boolean; reason: string }>;
}

export interface DiscoverySource {
  readonly sourceType: string;
  discover(query: DiscoveryQuery): Promise<RawCandidate[]>;
}

// ---- Creator identity graph + audience (profile-graph plan) ----------------
/**
 * A per-platform collector for the identity graph. Given a seed URL/handle it
 * returns the account it describes plus cross-links to the creator's OTHER surfaces
 * (so identity resolution can unify them) and any cheap audience signals. Phase 2+
 * (e.g. a YouTube Data API adapter); deterministic stubs run offline.
 */
export interface ProfileFragment {
  platform: string;
  handle: string | null;
  url: string;
  /** Links to the creator's other platforms found on this surface. */
  links: string[];
  /** Cheap audience signals this source can provide (followers, geo, language). */
  audience?: { reach?: number | null; primaryGeo?: string | null; language?: string | null; engagementRate?: number | null };
  /** Contact emails this source exposed (e.g. a channel description). */
  emails?: string[];
}

export interface ProfileSource {
  readonly platform: string;
  /** Whether this source can collect the given URL/handle. */
  handles(url: string): boolean;
  collect(url: string): Promise<ProfileFragment | null>;
}

/** Public, per-account metrics. `source` records how they were obtained. Unknown
 * fields stay null — never invented. Demographics (audience geo/age) are a later,
 * paid add (`source: "provider"`); this seam carries reach + engagement first. */
export interface AccountMetrics {
  reach: number | null; // followers / subscribers
  engagementRate: number | null; // 0..1, from recent public posts
  primaryGeo: string | null; // the CREATOR's country, when exposed (not audience geo)
  language: string | null;
  source: "api" | "scrape" | "page" | "provider";
}

/**
 * Enriches one account in the identity graph with reach + engagement, from the
 * cheapest source for that platform: a free API (YouTube), an on-page fetch
 * (Substack), or a scraping-API actor (Instagram/TikTok/X — public counts only,
 * no demographics). Each adapter declares which platforms it `supports`; the
 * registry routes per account. Real adapters are key-gated; absent one, the
 * account's metrics stay unknown (null), never invented.
 */
export interface AccountEnricher {
  readonly kind: string;
  supports(platform: string): boolean;
  enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null>;
}

// ---- LLM + embeddings (Section 8.3 / 8.4 / 8.5) ----------------------------
export interface LlmClient {
  readonly model: string;
  /** Generate personalized outreach or classify replies. */
  complete(prompt: string, opts?: { system?: string; maxTokens?: number; json?: boolean }): Promise<string>;
}

export interface Embedder {
  readonly model: string;
  embed(text: string): Promise<number[]>;
  /** Convenience: cosine similarity of two texts in [0,1]. */
  similarity(a: string, b: string): Promise<number>;
}

// ---- Secret store (Section 11) ---------------------------------------------
/** Encrypted secret storage for OAuth/API credentials. Never store raw secrets in rows. */
export interface SecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}
