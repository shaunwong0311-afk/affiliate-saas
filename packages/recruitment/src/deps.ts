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
  RedirectResolver,
  RelevanceScorer,
  CalendarBooking,
} from "@affiliate/integrations";

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
   * adapter). Optional — absent → the default `mailer` is used (the dev/test mock).
   */
  mailboxResolver?: (mailboxId: string | null) => Promise<MailboxSender>;
  /**
   * Pulls new inbound replies for a mailbox (the SMTP-rail IMAP poll — loads the mailbox's
   * encrypted IMAP creds, fetches mail newer than its cursor WITHOUT touching flags). Optional
   * — absent → reply ingestion only happens via the inbound-parse webhook. The scheduler dedups
   * by Message-Id and routes each through `processInboundReply`. Returns [] for mailboxes it
   * can't poll (OAuth rails, missing IMAP config).
   */
  replyPoller?: (mailbox: Mailbox) => Promise<InboundReply[]>;
  /** Meeting booking for the managed (A-tier) track. Optional. */
  calendar?: CalendarBooking;
  clock: Clock;
}
