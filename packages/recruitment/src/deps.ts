import type { Clock } from "@affiliate/core";
import type { Database } from "@affiliate/db";
import type {
  DiscoverySource,
  EmailFinder,
  EmailVerifier,
  Embedder,
  LlmClient,
  MailboxSender,
  RedirectResolver,
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
  /** Meeting booking for the managed (A-tier) track. Optional. */
  calendar?: CalendarBooking;
  clock: Clock;
}
