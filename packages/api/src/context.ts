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
  buildMailboxSender,
  type MailboxCredentials,
  StubEmailFinder,
  HunterFinder,
  HashingEmbedder,
  DeterministicLlm,
  AnthropicLlmClient,
  OpenAiCompatibleLlmClient,
  EmbeddingRelevanceScorer,
  LlmRelevanceScorer,
  InMemorySecretStore,
  CompetitorAffiliateSource,
  CreatorDiscoverySource,
  SerpDiscoverySource,
  SerpApiProvider,
  DataForSEOSerpProvider,
  DeterministicSerpProvider,
  BacklinkDiscoverySource,
  DataForSEOBacklinkProvider,
  DeterministicBacklinkProvider,
  CompetitorProgramResolver,
  DbCustomerMiningSource,
  YouTubeDiscoverySource,
  PodcastDiscoverySource,
  ProxyHttpFetcher,
  DeterministicFetcher,
  PlaywrightFetcher,
  EscalatingFetcher,
  CachingFetcher,
  RateLimitedFetcher,
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
  type RelevanceScorer,
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
  /** Resolves the per-campaign send-as-the-merchant sender from the connected mailbox's
   * encrypted credentials (SMTP/Graph/Gmail). Falls back to `mailer` when none is connected. */
  mailboxResolver: (mailboxId: string | null) => Promise<MailboxSender>;
  emailFinder: EmailFinder;
  embedder: Embedder;
  llm: LlmClient;
  /** Topical-relevance scorer (LLM-backed when keyed; lexical embedder otherwise). */
  relevanceScorer: RelevanceScorer;
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
  // DataForSEO doubles as a real SERP provider (Google Organic live, ~$0.002/query),
  // so a merchant with only a DataForSEO key still gets real SERP discovery — no
  // separate SerpApi subscription. SerpApi wins when both are set.
  const hasDfs = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  const realDiscovery = hasSerp || hasDfs || proxyUrls.length > 0;

  const serpProvider = hasSerp
    ? new SerpApiProvider({ apiKey: process.env.SERPAPI_KEY!, http: jsonHttp })
    : hasDfs
      ? new DataForSEOSerpProvider({ login: process.env.DATAFORSEO_LOGIN!, password: process.env.DATAFORSEO_PASSWORD! })
      : new DeterministicSerpProvider();
  // A real page fetcher (proxy pool, or direct fetch when only a SERP key is set)
  // whenever we have real SERP results; deterministic (no network) otherwise.
  const pageFetcher = realDiscovery ? new ProxyHttpFetcher(staticProxyPool(proxyUrls)) : new DeterministicFetcher();
  // Build ONE hardened fetcher used everywhere real pages are read (SERP result pages,
  // competitor program pages, contact links, frontier expansion, enrich homepages):
  //  - BROWSER_FETCH=true → escalate a JS-rendered/anti-bot-challenged page from the
  //    cheap static fetch to a real headless browser (Playwright);
  //  - RateLimitedFetcher → per-host throttle + global concurrency cap (ban-safe, polite);
  //  - CachingFetcher (outermost) → short-TTL cache + in-flight coalescing, so the
  //    resolver/frontier/enrich never re-pull the same homepage in a cycle.
  // Dev/test stays on the unwrapped DeterministicFetcher (no delays, no caching surprises),
  // and `fetcher` is left undefined there so no secondary network calls are attempted.
  const networkFetcher =
    realDiscovery && process.env.BROWSER_FETCH === "true"
      ? new EscalatingFetcher(pageFetcher, new PlaywrightFetcher({ proxies: proxyUrls }))
      : pageFetcher;
  const sharedFetcher: HttpFetcher = realDiscovery
    ? new CachingFetcher(new RateLimitedFetcher(networkFetcher, { maxConcurrent: 6, perHostIntervalMs: 1000 }))
    : pageFetcher;
  const serpSource = new SerpDiscoverySource(serpProvider, sharedFetcher);
  const fetcher = overrides.fetcher ?? (realDiscovery ? sharedFetcher : undefined);

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
  // Direct YouTube creator discovery — finds video reviewers (no website to backlink-mine).
  // Free Data API; only wired when a key is present. Reach/engagement come from YouTubeEnricher.
  const youtubeDiscovery = process.env.YOUTUBE_API_KEY
    ? new YouTubeDiscoverySource({ apiKey: process.env.YOUTUBE_API_KEY, http: jsonHttp })
    : null;
  // Podcast discovery via the free iTunes Search API — finds podcast affiliates and,
  // by reading the RSS feed, pulls the owner email + site so they're contactable. Only
  // when real discovery is on (so dev/test make no outbound calls); reuses the fetcher.
  const podcastDiscovery = realDiscovery ? new PodcastDiscoverySource({ http: jsonHttp, fetcher: sharedFetcher }) : null;
  const discoverySources: DiscoverySource[] = overrides.discoverySources ?? [
    serpSource,
    ...syntheticSources,
    new DbCustomerMiningSource(db),
    new BacklinkDiscoverySource(backlinkProvider, programResolver),
    ...(youtubeDiscovery ? [youtubeDiscovery] : []),
    ...(podcastDiscovery ? [podcastDiscovery] : []),
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

  // Relevance scoring: a cheap LLM judges topical niche fit semantically
  // (~$0.0001-0.001/prospect, cached). Precedence:
  //  1) RELEVANCE_LLM_API_KEY → any OpenAI-compatible budget model (Grok/Groq/OpenAI-mini/
  //     DeepSeek/OpenRouter). Defaults to xAI Grok-fast; override base URL + model via env.
  //  2) ANTHROPIC_API_KEY → Claude Haiku.
  //  3) neither → the lexical hashing-embedder similarity (the default `embedder` below).
  const embedder = overrides.embedder ?? new HashingEmbedder();
  const relevanceLlm: LlmClient | null = process.env.RELEVANCE_LLM_API_KEY
    ? new OpenAiCompatibleLlmClient({
        apiKey: process.env.RELEVANCE_LLM_API_KEY,
        baseUrl: process.env.RELEVANCE_LLM_BASE_URL ?? "https://api.x.ai/v1",
        model: process.env.RELEVANCE_LLM_MODEL ?? "grok-4-fast-non-reasoning",
      })
    : process.env.ANTHROPIC_API_KEY
      ? new AnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: "claude-haiku-4-5-20251001" })
      : null;
  const relevanceScorer =
    overrides.relevanceScorer ?? (relevanceLlm ? new LlmRelevanceScorer(relevanceLlm) : new EmbeddingRelevanceScorer(embedder));

  // Send-as-the-merchant: resolve the campaign's connected mailbox to the right adapter
  // (SMTP for cPanel/host + Gmail app-password; Graph/Gmail OAuth later), loading its
  // encrypted credentials from the SecretStore. Falls back to the mock when unconnected.
  const mailer = overrides.mailer ?? new MockMailboxSender();
  const secrets = overrides.secrets ?? new InMemorySecretStore();
  const mailboxResolver =
    overrides.mailboxResolver ??
    (async (mailboxId: string | null): Promise<MailboxSender> => {
      if (!mailboxId) return mailer;
      const mailbox = await db.mailboxes.get(mailboxId);
      if (!mailbox || mailbox.status === "disconnected" || !mailbox.credentialsRef) return mailer;
      const raw = await secrets.get(mailbox.credentialsRef);
      if (!raw) return mailer;
      let creds: MailboxCredentials;
      try {
        creds = JSON.parse(raw) as MailboxCredentials;
      } catch {
        return mailer;
      }
      return buildMailboxSender(creds, { http: jsonHttp });
    });

  return {
    config,
    db,
    engines: overrides.engines ?? defaultEngineRegistry,
    rails: overrides.rails ?? new PayoutRailRegistry(),
    mailer,
    mailboxResolver,
    emailFinder,
    embedder,
    llm,
    relevanceScorer,
    secrets,
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
