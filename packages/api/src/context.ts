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
  HunterFinder,
  HashingEmbedder,
  DeterministicLlm,
  AnthropicLlmClient,
  InMemorySecretStore,
  CompetitorAffiliateSource,
  CreatorDiscoverySource,
  SerpDiscoverySource,
  SerpApiProvider,
  DeterministicSerpProvider,
  BacklinkDiscoverySource,
  DataForSEOBacklinkProvider,
  DeterministicBacklinkProvider,
  CompetitorProgramResolver,
  DbCustomerMiningSource,
  ProxyHttpFetcher,
  DeterministicFetcher,
  FetchJsonClient,
  staticProxyPool,
  FetchRedirectResolver,
  MxEmailVerifier,
  YouTubeEnricher,
  ScrapeMetricsEnricher,
  OnPageSubscriberEnricher,
  EnricherRegistry,
  CachingEnricher,
  StubCalendarBooking,
  ConsoleTransactionalMailer,
  type MailboxSender,
  type EmailFinder,
  type EmailVerifier,
  type Embedder,
  type LlmClient,
  type SecretStore,
  type DiscoverySource,
  type RedirectResolver,
  type HttpFetcher,
  type AccountEnricher,
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
  /** Follows redirects so generic affiliate links can be trusted (real network). Optional. */
  redirectResolver?: RedirectResolver;
  /** Real MX/SMTP deliverability check for extracted emails. Optional. */
  emailVerifier?: EmailVerifier;
  /** Page fetcher for following contact-bearing links during enrichment. Optional. */
  fetcher?: HttpFetcher;
  /** Fills reach + engagement for identity-graph accounts (YouTube/scrape/on-page). Optional. */
  enricher?: AccountEnricher;
  calendar: CalendarBooking;
  /** Transactional mail (magic links, payout notices) — routed via an ESP, never the box IP. */
  transactionalMailer: TransactionalMailer;
  clock: Clock;
}

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const db = overrides.db ?? createMemoryDatabase();
  const config = overrides.config ?? loadConfig();

  // --- Real discovery wiring (Section 8.1). The headline SERP source is REAL when
  // a SERP API key is present: a SerpApiProvider + a proxy/direct page fetcher,
  // feeding actually-scraped HTML through the affiliate-link detector. With no key
  // it falls back to deterministic providers (which mark their output `synthetic`).
  const proxyUrls = (process.env.PROXY_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const jsonHttp = new FetchJsonClient();
  const hasSerp = !!process.env.SERPAPI_KEY;
  const realDiscovery = hasSerp || proxyUrls.length > 0;

  const serpProvider = hasSerp
    ? new SerpApiProvider({ apiKey: process.env.SERPAPI_KEY!, http: jsonHttp })
    : new DeterministicSerpProvider();
  // A real page fetcher (proxy pool, or direct fetch when only a SERP key is set)
  // whenever we have real SERP results; deterministic (no network) otherwise.
  const pageFetcher = realDiscovery ? new ProxyHttpFetcher(staticProxyPool(proxyUrls)) : new DeterministicFetcher();
  const serpSource = new SerpDiscoverySource(serpProvider, pageFetcher);
  // Page fetcher for following contact links + reading competitor sites — real
  // discovery only, so dev/test never make secondary network calls.
  const fetcher = overrides.fetcher ?? (realDiscovery ? pageFetcher : undefined);

  // Synthetic generators fabricate demo prospects — only included when allowed
  // (never in production). The SERP source, first-party customer mining, and the
  // (real-or-empty) backlink source are always present.
  const syntheticSources = config.allowSyntheticDiscovery
    ? [new CompetitorAffiliateSource(), new CreatorDiscoverySource()]
    : [];
  // Competitor-affiliate mining — the warmest source. Real via DataForSEO (pay-as-you-go
  // backlinks) when keyed; a deterministic generator in dev (labeled synthetic); nothing
  // in production without a key (honest empty, never fabricated).
  const backlinkProvider =
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD
      ? new DataForSEOBacklinkProvider({ login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD })
      : config.allowSyntheticDiscovery
        ? new DeterministicBacklinkProvider()
        : undefined;
  // Resolves each competitor's affiliate program (network + merchant id) by reading
  // their site, so backlink mining queries the RIGHT links. Needs a fetcher.
  const programResolver = fetcher ? new CompetitorProgramResolver({ fetcher }) : undefined;
  const discoverySources: DiscoverySource[] = overrides.discoverySources ?? [
    serpSource,
    ...syntheticSources,
    new DbCustomerMiningSource(db),
    new BacklinkDiscoverySource(backlinkProvider, programResolver),
  ];

  // Email finding: real Hunter.io when keyed, deterministic pattern stub otherwise.
  const emailFinder =
    overrides.emailFinder ??
    (process.env.HUNTER_API_KEY ? new HunterFinder({ apiKey: process.env.HUNTER_API_KEY, http: jsonHttp }) : new StubEmailFinder());

  // Real network helpers — only wired when real discovery is on, so tests/dev never
  // hit the network. When absent, generic affiliate links stay unverified and email
  // verification falls back to the finder's own check.
  const redirectResolver = overrides.redirectResolver ?? (realDiscovery ? new FetchRedirectResolver() : undefined);
  const emailVerifier = overrides.emailVerifier ?? (realDiscovery ? new MxEmailVerifier() : undefined);

  // Audience enrichment: one registry, cheapest source per platform. YouTube is free
  // (Data API); IG/TikTok/X use a scraping-API actor (public counts + engagement, no
  // demographics); Substack reads its on-page subscriber count. Each is key-gated;
  // an account with no matching wired enricher keeps reach/engagement null.
  const enrichers: AccountEnricher[] = [];
  if (process.env.YOUTUBE_API_KEY) enrichers.push(new YouTubeEnricher({ apiKey: process.env.YOUTUBE_API_KEY, http: jsonHttp }));
  if (process.env.SCRAPE_API_URL) enrichers.push(new ScrapeMetricsEnricher({ endpoint: process.env.SCRAPE_API_URL, apiKey: process.env.SCRAPE_API_KEY, http: jsonHttp }));
  if (fetcher) enrichers.push(new OnPageSubscriberEnricher(fetcher));
  // Cache results (incl. misses) so the same creator isn't paid for twice within the day.
  const enricher = overrides.enricher ?? (enrichers.length ? new CachingEnricher(new EnricherRegistry(enrichers)) : undefined);

  // Real LLM (AI-SDR + personalization) when an API key is present; deterministic
  // stub otherwise so the platform still runs with zero external services.
  const llm =
    overrides.llm ??
    (process.env.ANTHROPIC_API_KEY ? new AnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY }) : new DeterministicLlm());

  return {
    config,
    db,
    engines: overrides.engines ?? defaultEngineRegistry,
    rails: overrides.rails ?? new PayoutRailRegistry(),
    mailer: overrides.mailer ?? new MockMailboxSender(),
    emailFinder,
    embedder: overrides.embedder ?? new HashingEmbedder(),
    llm,
    secrets: overrides.secrets ?? new InMemorySecretStore(),
    discoverySources,
    redirectResolver,
    emailVerifier,
    fetcher,
    enricher,
    calendar: overrides.calendar ?? new StubCalendarBooking(),
    transactionalMailer: overrides.transactionalMailer ?? new ConsoleTransactionalMailer(),
    clock: overrides.clock ?? systemClock,
  };
}
