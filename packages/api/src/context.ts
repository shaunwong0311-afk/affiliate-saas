import {
  EngineRegistry,
  defaultEngineRegistry,
  systemClock,
  type Clock,
} from "@affiliate/core";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import {
  PayoutRailRegistry,
  MockMailboxSender,
  StubEmailFinder,
  HashingEmbedder,
  DeterministicLlm,
  AnthropicLlmClient,
  InMemorySecretStore,
  CompetitorAffiliateSource,
  CreatorDiscoverySource,
  SerpDiscoverySource,
  DbCustomerMiningSource,
  StubCalendarBooking,
  ConsoleTransactionalMailer,
  type MailboxSender,
  type EmailFinder,
  type Embedder,
  type LlmClient,
  type SecretStore,
  type DiscoverySource,
  type CalendarBooking,
  type TransactionalMailer,
} from "@affiliate/integrations";
import { loadConfig, type AppConfig } from "./config.js";

/**
 * AppContext is the dependency container wired once at startup. Everything is an
 * interface with a default in-process implementation, so the whole platform runs
 * with no external services; production swaps any field for a real adapter.
 *
 * It is also a structural superset of the recruitment engine's `RecruitmentDeps`,
 * so it can be passed straight to the autonomous recruitment functions.
 */
export interface AppContext {
  config: AppConfig;
  db: Database;
  engines: EngineRegistry;
  rails: PayoutRailRegistry;
  mailer: MailboxSender;
  emailFinder: EmailFinder;
  embedder: Embedder;
  llm: LlmClient;
  secrets: SecretStore;
  discoverySources: DiscoverySource[];
  calendar: CalendarBooking;
  /** Transactional mail (magic links, payout notices) — routed via an ESP, never the box IP. */
  transactionalMailer: TransactionalMailer;
  clock: Clock;
}

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const db = overrides.db ?? createMemoryDatabase();

  // The autonomous "from-scratch" discovery sources: SERP mining (the headline
  // source) + competitor-affiliate + creator + first-party customer mining. The
  // SERP source uses deterministic providers by default (runs offline); production
  // injects a real SERP API + proxy fetcher with no pipeline change.
  const discoverySources: DiscoverySource[] = overrides.discoverySources ?? [
    new SerpDiscoverySource(),
    new CompetitorAffiliateSource(),
    new CreatorDiscoverySource(),
    new DbCustomerMiningSource(db),
  ];

  // Real LLM (AI-SDR + personalization) when an API key is present; deterministic
  // stub otherwise so the platform still runs with zero external services.
  const llm =
    overrides.llm ??
    (process.env.ANTHROPIC_API_KEY ? new AnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY }) : new DeterministicLlm());

  return {
    config: overrides.config ?? loadConfig(),
    db,
    engines: overrides.engines ?? defaultEngineRegistry,
    rails: overrides.rails ?? new PayoutRailRegistry(),
    mailer: overrides.mailer ?? new MockMailboxSender(),
    emailFinder: overrides.emailFinder ?? new StubEmailFinder(),
    embedder: overrides.embedder ?? new HashingEmbedder(),
    llm,
    secrets: overrides.secrets ?? new InMemorySecretStore(),
    discoverySources,
    calendar: overrides.calendar ?? new StubCalendarBooking(),
    transactionalMailer: overrides.transactionalMailer ?? new ConsoleTransactionalMailer(),
    clock: overrides.clock ?? systemClock,
  };
}
