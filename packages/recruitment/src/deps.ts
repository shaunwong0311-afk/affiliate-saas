import type { Clock } from "@affiliate/core";
import type { Database } from "@affiliate/db";
import type {
  DiscoverySource,
  EmailFinder,
  Embedder,
  LlmClient,
  MailboxSender,
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
  /** Meeting booking for the managed (A-tier) track. Optional. */
  calendar?: CalendarBooking;
  clock: Clock;
}
