import {
  EngineRegistry,
  defaultEngineRegistry,
  systemClock,
  type Clock,
} from "@affiliate/core";
import { createMemoryDatabase, type Database, type Mailbox } from "@affiliate/db";
import {
  PayoutRailRegistry,
  MockMailboxSender,
  buildMailboxSender,
  refreshAccessToken,
  ImapReplyIngestion,
  type InboundReply,
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
  DbSecretStore,
  ResendMailer,
  PostmarkMailer,
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
  SocialCreatorDiscoverySource,
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
  StubNotifier,
  SlackWebhookNotifier,
  type Notifier,
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
import { oauthProviderFor } from "./services/oauth.js";
// Outreach wiring (AUDIT-2026-10). A separate import on purpose: the discovery fix stream
// edits the block above, and two streams should not both touch the same import lines.
import { GraphReplyIngestion, unavailableMailboxSender } from "@affiliate/integrations";
import type { RecruitmentDeps } from "@affiliate/recruitment";

/** What one inbound read of a mailbox produced (the recruitment engine's contract). */
type ReplyPollOutcome = Awaited<ReturnType<NonNullable<RecruitmentDeps["replyPoller"]>>>;

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
   * encrypted credentials (SMTP/Graph/Gmail). Outside production an unconnected mailbox
   * resolves to `mailer` (the mock); in production it resolves to a sender that fails. */
  mailboxResolver: (mailboxId: string | null) => Promise<MailboxSender>;
  /** Reads new inbound mail for a mailbox from its cursor without touching read flags — IMAP
   * for the SMTP rail, Microsoft Graph for the Microsoft OAuth rail. Says `unavailable` for a
   * rail with no inbound path (Gmail OAuth, SMTP without IMAP) and throws when the read
   * fails; the scheduler dedups + routes, and holds follow-ups unless the last read worked. */
  replyPoller: (mailbox: Mailbox) => Promise<ReplyPollOutcome>;
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
  /** Push notifier for AI-SDR human handoffs (Slack when keyed; in-process stub otherwise). */
  notifier: Notifier;
  /** Public web-app origin — self-serve signup links the reply router hands out. */
  publicAppUrl: string;
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
  // The SERP provider is REAL only when a SERP-capable key is set. PROXY_URL alone
  // makes `realDiscovery` true (the shared fetcher goes real), but the deterministic
  // SERP provider fabricates domains — pairing it with a real fetcher would issue
  // real HTTP to invented hosts. So the SERP source's fetcher is chosen by whether
  // the PROVIDER is real, never by the aggregate flag; and when the provider is
  // deterministic AND synthetic discovery is disallowed (prod), the source is omitted
  // entirely — honest empty, same rule as the backlink source.
  const serpIsReal = hasSerp || hasDfs;
  const serpSource =
    serpIsReal || config.allowSyntheticDiscovery
      ? new SerpDiscoverySource(serpProvider, serpIsReal ? sharedFetcher : new DeterministicFetcher())
      : null;
  const fetcher = overrides.fetcher ?? (realDiscovery ? sharedFetcher : undefined);

  // Synthetic generators fabricate demo prospects — only included when allowed
  // (never in production). First-party customer mining and the (real-or-empty)
  // backlink source are always present; the SERP source only when its provider is
  // real or synthetic output is allowed (see above).
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
  // Instagram/TikTok creator discovery via the same scraping-API key used for enrichment.
  // Key-gated (never fabricates creators); the SERP path also emits site:instagram.com /
  // site:tiktok.com queries as the zero-extra-key fallback (see query-strategy.ts).
  const socialDiscovery = process.env.SCRAPE_API_URL
    ? new SocialCreatorDiscoverySource({ endpoint: process.env.SCRAPE_API_URL, apiKey: process.env.SCRAPE_API_KEY, http: jsonHttp })
    : null;
  const discoverySources: DiscoverySource[] = overrides.discoverySources ?? [
    ...(serpSource ? [serpSource] : []),
    ...syntheticSources,
    new DbCustomerMiningSource(db),
    new BacklinkDiscoverySource(backlinkProvider, programResolver),
    ...(youtubeDiscovery ? [youtubeDiscovery] : []),
    ...(podcastDiscovery ? [podcastDiscovery] : []),
    ...(socialDiscovery ? [socialDiscovery] : []),
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
  // (SMTP for cPanel/host + Gmail app-password; Graph/Gmail OAuth), loading its
  // encrypted credentials from the SecretStore. The DEFAULT mailer is the dev/test mock — and
  // in production it is a sender that FAILS: every "no mailbox / no resolver" path lands on it,
  // so none of them can report mail as sent that never left (AUDIT-2026-10 O4).
  const mailer = overrides.mailer ?? (config.isProduction ? unavailableMailboxSender("no connected mailbox is available for this send") : new MockMailboxSender());
  // Secrets persist WITH the database (encrypted at the app level) — an in-memory-only store
  // would orphan every connected mailbox on restart and silently degrade sends to the mock.
  const secrets = overrides.secrets ?? new DbSecretStore(db.secrets, config.secretsEncKey);
  const prod = config.isProduction;
  // A sender that refuses to send, with the reason surfaced on the message row. In production
  // a broken mailbox must FAIL — silently "sending" via the mock would fabricate sent state.
  const failingSender = (reason: string): MailboxSender => unavailableMailboxSender(reason);

  // ---- Mailbox credentials (+ OAuth access-token refresh) -----------------------------------
  // Shared by the sender resolver and the reply poller. Token refresh is SERIALIZED per mailbox
  // — in this process by a shared in-flight promise, across processes by `db.withLock` where
  // the adapter has it — and re-reads the stored credentials inside the lock: providers rotate
  // the refresh token on use, so two concurrent refreshes with the same token end with one of
  // them (and soon the mailbox) holding a dead one. A failed refresh is REPORTED, never
  // swallowed: the caller fails the send / marks the inbound path broken with the reason
  // (audit-07 #23, never fixed until now).
  type LoadedCredentials = { creds: MailboxCredentials } | { error: string };
  const readCredentials = async (mailbox: Mailbox): Promise<LoadedCredentials> => {
    const raw = await secrets.get(mailbox.credentialsRef);
    if (!raw) return { error: "mailbox credentials missing from the secret store" };
    try {
      return { creds: JSON.parse(raw) as MailboxCredentials };
    } catch {
      return { error: "mailbox credentials unreadable" };
    }
  };
  const isOAuth = (c: MailboxCredentials) => c.kind === "microsoft" || c.kind === "gmail_oauth";
  const tokenExpiring = (c: MailboxCredentials) => !!c.expiresAt && new Date(c.expiresAt).getTime() < Date.now() + 60_000;
  const refreshesInFlight = new Map<string, Promise<LoadedCredentials>>();
  const refreshCredentials = (mailbox: Mailbox): Promise<LoadedCredentials> => {
    const inFlight = refreshesInFlight.get(mailbox.id);
    if (inFlight) return inFlight;
    const refresh = async (): Promise<LoadedCredentials> => {
      const current = await readCredentials(mailbox); // re-read: someone else may just have refreshed
      if ("error" in current || !tokenExpiring(current.creds)) return current;
      const creds = current.creds;
      if (!creds.refreshToken) return { error: "the mailbox's access token has expired and no refresh token is stored — reconnect the mailbox" };
      const provider = creds.kind === "microsoft" ? "microsoft" : "google";
      const cfg = oauthProviderFor(config, provider);
      if (!cfg) return { error: `${provider} OAuth is not configured on this server, so the mailbox's token cannot be refreshed` };
      try {
        const t = await refreshAccessToken(cfg, creds.refreshToken);
        const next: MailboxCredentials = { ...creds, accessToken: t.accessToken, refreshToken: t.refreshToken ?? creds.refreshToken, expiresAt: t.expiresAt };
        await secrets.put(mailbox.credentialsRef, JSON.stringify(next));
        return { creds: next };
      } catch (e) {
        return { error: `the mailbox's access token could not be refreshed (${e instanceof Error ? e.message : String(e)}) — reconnect the mailbox`.slice(0, 300) };
      }
    };
    const lockingDb = db as Database & { withLock?: <R>(key: string, fn: () => Promise<R>) => Promise<R> };
    const run = (typeof lockingDb.withLock === "function" ? lockingDb.withLock(`mailbox-oauth:${mailbox.id}`, refresh) : refresh()).finally(() => refreshesInFlight.delete(mailbox.id));
    refreshesInFlight.set(mailbox.id, run);
    return run;
  };
  const loadCredentials = async (mailbox: Mailbox): Promise<LoadedCredentials> => {
    const loaded = await readCredentials(mailbox);
    if ("error" in loaded || !isOAuth(loaded.creds) || !tokenExpiring(loaded.creds)) return loaded;
    return refreshCredentials(mailbox);
  };

  const mailboxResolver =
    overrides.mailboxResolver ??
    (async (mailboxId: string | null): Promise<MailboxSender> => {
      if (!mailboxId) return prod ? failingSender("campaign has no connected mailbox") : mailer;
      const mailbox = await db.mailboxes.get(mailboxId);
      if (!mailbox) return prod ? failingSender("mailbox not found") : mailer;
      // An auto-paused ("error") or disconnected mailbox must never transmit — in ANY env.
      if (mailbox.status === "error" || mailbox.status === "disconnected") {
        return failingSender(`mailbox ${mailbox.status === "error" ? "auto-paused by the deliverability monitor" : "disconnected"}`);
      }
      if (!mailbox.credentialsRef) return prod ? failingSender("mailbox has no credentials connected") : mailer;
      const stored = await readCredentials(mailbox);
      if ("error" in stored) return prod ? failingSender(stored.error) : mailer;
      // OAuth rails: refresh the access token if it's expired/expiring, and persist it. A
      // refresh that fails fails the SEND, with the reason — in every environment.
      const loaded = isOAuth(stored.creds) && tokenExpiring(stored.creds) ? await refreshCredentials(mailbox) : stored;
      if ("error" in loaded) return unavailableMailboxSender(loaded.error, "auth");
      return buildMailboxSender(loaded.creds, { http: jsonHttp });
    });

  // Inbound: read replies (and bounce notifications) for a mailbox from its stored cursor,
  // WITHOUT touching read state — it is the merchant's real inbox.
  //  - SMTP rail  → IMAP (PEEK-only), resuming by UID so nothing is downloaded twice;
  //  - Microsoft  → Graph `Mail.Read` on the Inbox (the scope the connect flow already asks for);
  //  - Gmail via Google sign-in → NOT BUILT. It says so (`unavailable`) rather than returning an
  //    empty list: the engine holds that mailbox's follow-ups and the UI warns, instead of
  //    following up people whose replies and STOPs it cannot see (AUDIT-2026-10 O5).
  // A read that FAILS throws; `ingestReplies` records the mailbox's inbound path as broken.
  const replyPoller =
    overrides.replyPoller ??
    (async (mailbox: Mailbox): Promise<ReplyPollOutcome> => {
      if (!mailbox.credentialsRef) return { unavailable: "the mailbox is not connected" };
      const loaded = await loadCredentials(mailbox);
      if ("error" in loaded) throw new Error(loaded.error);
      const creds = loaded.creds;
      const since = mailbox.lastPolledAt ? new Date(mailbox.lastPolledAt) : null;
      if (creds.kind === "smtp") {
        if (!creds.imapHost || !creds.user || creds.pass == null) {
          return { unavailable: "no IMAP server is set for this mailbox, so replies and STOP requests cannot be read — add its IMAP settings to enable follow-ups" };
        }
        const poller = new ImapReplyIngestion({
          config: {
            host: creds.imapHost,
            port: creds.imapPort ?? 993,
            user: creds.user,
            pass: creds.pass,
            secure: (creds.imapPort ?? 993) === 993,
          },
          since,
          cursor: mailbox.inboundCursor ?? null,
        });
        const replies = await poller.poll();
        return { replies, cursor: poller.nextCursor };
      }
      if (creds.kind === "microsoft") {
        if (!creds.accessToken) throw new Error("the Microsoft mailbox has no access token — reconnect it");
        const poller = new GraphReplyIngestion({ accessToken: creds.accessToken, http: jsonHttp, since, cursor: mailbox.inboundCursor ?? null, mailboxEmail: mailbox.email });
        const replies = await poller.poll();
        return { replies, cursor: poller.nextCursor };
      }
      return { unavailable: "reading replies is not built yet for Gmail connected with Google sign-in — connect this mailbox with an app password (SMTP + IMAP) to enable follow-ups" };
    });

  return {
    config,
    db,
    engines: overrides.engines ?? defaultEngineRegistry,
    // No custody: there are no platform-wide rail credentials, so nothing is read from the
    // environment here and every real payout is MANUAL (the merchant pays from their own
    // account) until a merchant-owned connection is wired in as a factory + credential
    // source. The mock rail marks payouts paid without moving money — outside production only.
    rails: overrides.rails ?? new PayoutRailRegistry({ allowMock: !prod }),
    mailer,
    mailboxResolver,
    replyPoller,
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
    transactionalMailer: overrides.transactionalMailer ?? buildTransactionalMailer(prod, jsonHttp),
    notifier:
      overrides.notifier ??
      (process.env.SLACK_WEBHOOK_URL ? new SlackWebhookNotifier({ webhookUrl: process.env.SLACK_WEBHOOK_URL, http: jsonHttp }) : new StubNotifier()),
    publicAppUrl: overrides.publicAppUrl ?? config.corsOrigins[0] ?? "",
    clock: overrides.clock ?? systemClock,
  };
}

/**
 * Transactional mail (activation welcomes, magic links, payout notices) — env-gated ESP:
 * RESEND_API_KEY → Resend, POSTMARK_SERVER_TOKEN → Postmark (ESP_PROVIDER breaks ties when
 * both are set). TRANSACTIONAL_FROM is the sending address — it must be on a domain verified
 * with that ESP; there is no built-in default, because a hard-coded address on a domain the
 * deployment does not own is rejected by the ESP (or worse, spoofs someone).
 *
 * Without a key this mail never leaves the process. Outside production the console mailer
 * records it; IN production the console mailer reports `failed`, so nothing is stamped as
 * delivered that was not (AUDIT-2026-10 O13) — and boot warns loudly.
 */
function buildTransactionalMailer(prod: boolean, http: FetchJsonClient): TransactionalMailer {
  const resendKey = process.env.RESEND_API_KEY;
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  const preferred = (process.env.ESP_PROVIDER ?? "").toLowerCase();
  const from = process.env.TRANSACTIONAL_FROM?.trim() || undefined;
  if ((resendKey || postmarkToken) && !from) {
    // eslint-disable-next-line no-console
    console.warn("[boot] TRANSACTIONAL_FROM is not set — activation + magic-link emails will FAIL until it names an address on a domain verified with the ESP.");
  }
  if (resendKey && (preferred !== "postmark" || !postmarkToken)) return new ResendMailer({ apiKey: resendKey, http, from });
  if (postmarkToken) return new PostmarkMailer({ serverToken: postmarkToken, http, from });
  if (prod) {
    // eslint-disable-next-line no-console
    console.warn("[boot] No transactional ESP configured (RESEND_API_KEY / POSTMARK_SERVER_TOKEN) — activation + magic-link emails will NOT be delivered.");
  }
  return new ConsoleTransactionalMailer({ production: prod });
}
