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
  InMemorySecretStore,
  DEFAULT_DISCOVERY_SOURCES,
  type MailboxSender,
  type EmailFinder,
  type Embedder,
  type LlmClient,
  type SecretStore,
  type DiscoverySource,
} from "@affiliate/integrations";
import { loadConfig, type AppConfig } from "./config.js";

/**
 * AppContext is the dependency container wired once at startup. Everything is an
 * interface with a default in-process implementation, so the whole platform runs
 * with no external services; production swaps any field for a real adapter.
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
  clock: Clock;
}

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    config: overrides.config ?? loadConfig(),
    db: overrides.db ?? createMemoryDatabase(),
    engines: overrides.engines ?? defaultEngineRegistry,
    rails: overrides.rails ?? new PayoutRailRegistry(),
    mailer: overrides.mailer ?? new MockMailboxSender(),
    emailFinder: overrides.emailFinder ?? new StubEmailFinder(),
    embedder: overrides.embedder ?? new HashingEmbedder(),
    llm: overrides.llm ?? new DeterministicLlm(),
    secrets: overrides.secrets ?? new InMemorySecretStore(),
    discoverySources: overrides.discoverySources ?? DEFAULT_DISCOVERY_SOURCES,
    clock: overrides.clock ?? systemClock,
  };
}
