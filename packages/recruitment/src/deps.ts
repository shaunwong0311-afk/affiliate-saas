import type { Clock } from "@affiliate/core";
import type { Database, Mailbox } from "@affiliate/db";
import type {
  AccountEnricher,
  DiscoverySource,
  EmailFinder,
  EmailVerifier,
  Embedder,
  HttpFetcher,
  InboundReply,
  LlmClient,
  MailboxSender,
  Notifier,
  RedirectResolver,
  RelevanceScorer,
  CalendarBooking,
} from "@affiliate/integrations";

/** What one inbound read of a mailbox produced. */
export type ReplyPollOutcome =
  /** Read the inbox; these are the new messages (possibly none). */
  | InboundReply[]
  /** The same, plus the rail's resume position to store on the mailbox (`inboundCursor`). */
  | { replies: InboundReply[]; cursor?: string | null }
  /** This mailbox has no way to read replies, and why (shown to the operator). */
  | { unavailable: string };

/** Minimal structured logger: failures are reported here instead of being swallowed. */
export interface RecruitmentLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: RecruitmentLogger = {
  // eslint-disable-next-line no-console
  warn: (message, meta) => console.warn(`[recruitment] ${message}`, meta ?? ""),
  // eslint-disable-next-line no-console
  error: (message, meta) => console.error(`[recruitment] ${message}`, meta ?? ""),
};

/** The logger to report through (the injected one, else the console). */
export function loggerOf(deps: { logger?: RecruitmentLogger }): RecruitmentLogger {
  return deps.logger ?? consoleLogger;
}

/**
 * The recruitment engine's dependency surface. Deliberately a structural subset
 * of the API's AppContext so the API can pass its context directly, while the
 * recruitment package stays decoupled from the API (no circular dependency).
 */
export interface RecruitmentDeps {
  db: Database;
  embedder: Embedder;
  llm: LlmClient;
  emailFinder: EmailFinder;
  mailer: MailboxSender;
  discoverySources: DiscoverySource[];
  /**
   * Follows redirects to confirm where a generic (low-confidence) affiliate link
   * actually points, upgrading `?ref=`/`?via=` links to trustworthy competitor
   * evidence. Optional — when absent, low-confidence links stay unverified and
   * never count as competitor promotion (no false positives).
   */
  redirectResolver?: RedirectResolver;
  /**
   * Real deliverability check (MX/SMTP) for emails extracted from a page. Optional
   * — when absent, the EmailFinder's own verify() is used. Distinct from guessing
   * an address exists.
   */
  emailVerifier?: EmailVerifier;
  /**
   * Page fetcher for following contact-bearing links (Linktree, /contact, YouTube
   * About) during enrichment to extract more real emails. Optional — when absent,
   * enrichment uses only the primary page + the EmailFinder (no secondary fetches).
   */
  fetcher?: HttpFetcher;
  /**
   * Fills reach + engagement for the accounts in the identity graph (YouTube API,
   * scraping-API for IG/TikTok/X, on-page for Substack). Optional — when absent,
   * those signals stay unknown (null), never invented.
   */
  enricher?: AccountEnricher;
  /**
   * Max billable account lookups to spend per prospect during enrichment (cost
   * control). We enrich the highest-confidence enricher-supported accounts up to
   * this cap. Default 3. Set to 1 to enrich only the primary surface.
   */
  enrichmentMaxAccounts?: number;
  /**
   * Topical-relevance scorer. When a cheap LLM is wired it judges niche fit
   * semantically (synonyms/adjacency/intent); otherwise relevance falls back to the
   * lexical embedder similarity. Optional — absent → embedder is used directly.
   */
  relevanceScorer?: RelevanceScorer;
  /**
   * Resolves the send-as-the-merchant mailbox sender for a campaign's mailbox (loads the
   * encrypted credentials, refreshes OAuth tokens, builds the right SMTP/Graph/Gmail
   * adapter). Optional — absent → the default `mailer` is used (the dev/test mock). When it
   * IS wired and throws, the send FAILS with the reason: it never falls back to `mailer`.
   */
  mailboxResolver?: (mailboxId: string | null) => Promise<MailboxSender>;
  /**
   * Reads new inbound mail for a mailbox (IMAP for the SMTP rail, Microsoft Graph for the
   * Microsoft OAuth rail) from its stored cursor, WITHOUT touching read flags. Optional —
   * absent → replies arrive only through the inbound webhooks. The scheduler dedups by
   * Message-Id and routes each through `processInboundReply`.
   *
   * It must say so when a mailbox has NO inbound path (`{ unavailable: reason }`) and throw
   * when the path exists but the read failed — an empty array means "read the inbox, nothing
   * new". The engine holds a mailbox's follow-ups unless its last read succeeded.
   */
  replyPoller?: (mailbox: Mailbox) => Promise<ReplyPollOutcome>;
  /** Where scheduler and ingestion failures are reported. Defaults to the console. */
  logger?: RecruitmentLogger;
  /** Meeting booking for the managed (A-tier) track. Optional. */
  calendar?: CalendarBooking;
  /**
   * Push notifier for human handoffs (Slack/webhook/push). Optional — the in-app handoff
   * queue is always written; this is the extra nudge so warm A-tier replies aren't missed.
   */
  notifier?: Notifier;
  /**
   * Public web-app origin (e.g. https://app.example.com) used to build the self-serve
   * signup links the reply router hands out. Optional — absent → relative links.
   */
  publicAppUrl?: string;
  clock: Clock;
}
