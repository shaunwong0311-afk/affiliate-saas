import { createHash } from "node:crypto";
import {
  detectAffiliateLinksInHtml,
  detectAffiliateUrl,
  identifyProgram,
  backlinkTargetsFor,
  type AffiliateSignal,
  type BacklinkTarget,
  type ResolvedProgram,
} from "@affiliate/core";
import type { Database } from "@affiliate/db";
import type { DiscoveryQuery, DiscoverySource, RawCandidate } from "./ports.js";
import { DeterministicFetcher, type HttpFetcher } from "./http.js";
import { buildDiscoveryQueries } from "./query-strategy.js";
import { extractHrefs } from "./web-evidence.js";

/**
 * Production-shaped discovery sources (Section 8.1). These are the real "find
 * affiliates from scratch" engine: SERP mining for buyer-intent content,
 * backlink/competitor mining, and first-party customer mining — feeding scraped
 * HTML through the real affiliate-link detector. Each accepts an injected
 * SERP/HTTP provider; with the deterministic providers they run end-to-end with
 * no network (so the autonomous loop is exercisable in dev/test), and swap to a
 * real SERP API + proxy fetcher in production with no pipeline change.
 */

export interface SerpHit {
  title: string;
  url: string;
  snippet: string;
}

/** A SERP provider — real adapter (SerpApi/Serper) or a deterministic generator. */
export interface SerpProvider {
  readonly kind: string;
  search(query: string, limit: number): Promise<SerpHit[]>;
}

/** Real SERP adapter skeleton (SerpApi-style). Requires an API key + HTTP client. */
export class SerpApiProvider implements SerpProvider {
  readonly kind = "serpapi";
  constructor(private readonly opts: { apiKey: string; http?: { get(url: string): Promise<{ status: number; json: any }> } }) {}
  async search(query: string, limit: number): Promise<SerpHit[]> {
    if (!this.opts.http) throw new Error("serpapi not configured (no HTTP client)");
    const res = await this.opts.http.get(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${limit}&api_key=${this.opts.apiKey}`,
    );
    const organic = (res.json?.organic_results ?? []) as Array<{ title: string; link: string; snippet: string }>;
    return organic.slice(0, limit).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "" }));
  }
}

/**
 * DataForSEO SERP adapter (Google Organic, live) — reuses the SAME DataForSEO account
 * as backlink mining, so a merchant with only a DataForSEO key still gets REAL SERP
 * discovery (no separate SerpApi subscription). Live organic is ~$0.002/query — cheaper
 * than SerpApi — and returns the ranking URLs we then fetch + run the affiliate detector
 * over. Drops straight into SerpDiscoverySource (same SerpProvider port).
 */
export class DataForSEOSerpProvider implements SerpProvider {
  readonly kind = "dataforseo-serp";
  constructor(private readonly opts: { login: string; password: string; locationCode?: number; languageCode?: string; http?: PostJson }) {}
  async search(query: string, limit: number): Promise<SerpHit[]> {
    const auth = Buffer.from(`${this.opts.login}:${this.opts.password}`).toString("base64");
    const url = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
    const task = {
      keyword: query,
      location_code: this.opts.locationCode ?? 2840, // 2840 = United States
      language_code: this.opts.languageCode ?? "en",
      depth: Math.min(Math.max(1, limit), 100),
    };
    const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
    const res = this.opts.http ? await this.opts.http.post(url, [task], headers) : await postJson(url, [task], headers);
    const items = (res.json?.tasks?.[0]?.result?.[0]?.items ?? []) as Array<{ type?: string; title?: string; url?: string; description?: string }>;
    return items
      .filter((i) => i.type === "organic" && i.url)
      .slice(0, limit)
      .map((i) => ({ title: i.title ?? "", url: i.url!, snippet: i.description ?? "" }));
  }
}

/** Deterministic SERP generator — stable buyer-intent results from the query. */
export class DeterministicSerpProvider implements SerpProvider {
  readonly kind = "deterministic-serp";
  async search(query: string, limit: number): Promise<SerpHit[]> {
    const seed = parseInt(createHash("md5").update(query).digest("hex").slice(0, 8), 16);
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const out: SerpHit[] = [];
    for (let i = 0; i < limit; i++) {
      const host = `${slug}-${(seed + i) % 97}.com`.replace(/^-/, "site-");
      out.push({
        title: `${query} — review ${i + 1}`,
        url: `https://${host}/best-${slug}`,
        snippet: `In-depth ${query} comparison and review.`,
      });
    }
    return out;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Platforms whose identity lives in the PATH (or subdomain), so the host alone does
// not identify a creator — dedup and seed URLs must keep the handle.
const SOCIAL_HOSTS = ["youtube.com", "youtu.be", "twitter.com", "x.com", "instagram.com", "tiktok.com"];
const PATH_PLATFORM_HOSTS = [...SOCIAL_HOSTS, "medium.com", "reddit.com"];

// A youtube.com/watch URL — the identity is the `v` param, not the path.
function youtubeWatchVideoId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "youtube.com" || u.pathname.replace(/\/$/, "") !== "/watch") return null;
  return u.searchParams.get("v");
}

function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    // A watch URL is nothing without its video id — keep ?v= (everything else —
    // tracking params, playlist/timestamp params — is still stripped).
    const videoId = youtubeWatchVideoId(u);
    u.search = "";
    u.hash = "";
    if (videoId) u.search = `?v=${videoId}`;
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * A stable identity key for dedup. For path-based platforms (youtube.com/@a vs
 * youtube.com/@b) the first path segment is part of the key, so distinct creators on
 * the same host are NOT collapsed; ordinary sites key on host. YouTube watch URLs
 * (youtube.com/watch?v=…, youtu.be/…) key on the VIDEO id — the first path segment
 * is "watch" for every result, which would collapse a whole SERP to one candidate.
 */
function candidateKey(url: string): string | null {
  const host = safeHost(url);
  if (!host) return null;
  if (!PATH_PLATFORM_HOSTS.includes(host)) return host;
  try {
    const u = new URL(url);
    const videoId = youtubeWatchVideoId(u);
    if (videoId) return `${host}/watch/${videoId}`; // video ids are case-sensitive
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (host === "youtu.be") return seg ? `youtube.com/watch/${seg}` : host; // the path segment IS the video id
    return seg ? `${host}/${seg.toLowerCase()}` : host;
  } catch {
    return host;
  }
}

/**
 * SERP discovery: buyer-intent queries → result pages → affiliate-link detection.
 * This is the headline "find from scratch" source. Real in production (SERP API +
 * proxy fetcher); deterministic providers make it runnable offline.
 */
export class SerpDiscoverySource implements DiscoverySource {
  readonly sourceType = "serp_mining";
  /** True when wired with deterministic providers (no real web data). */
  readonly synthetic: boolean;
  constructor(
    private readonly serp: SerpProvider = new DeterministicSerpProvider(),
    private readonly fetcher: HttpFetcher = new DeterministicFetcher(),
    private readonly opts: { maxQueries?: number } = {},
  ) {
    this.synthetic = serp.kind === "deterministic-serp" || fetcher.kind === "deterministic";
  }

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    // Prioritized, deduped, capped query set from the merchant ICP (competitor mining
    // first, then buyer-intent, then platform-targeted creator discovery).
    const plans = buildDiscoveryQueries(query, { max: this.opts.maxQueries });
    const perQuery = Math.max(1, Math.ceil(query.limit / Math.max(1, plans.length)));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];

    // Budget guard (Section 8.1): the platform-targeted creator queries (YouTube /
    // Substack / Reddit / podcast) sit at the TAIL of the priority list, so without a
    // reservation the competitor + buyer-intent queries up front eat the whole limit and
    // those creator channels never run. Reserve up to ~40% of the limit for platform
    // channels; once primary (blog) queries hit their cap we SKIP the rest (saving their
    // SERP cost too) and let the platform queries fill the reserved room.
    const PLATFORM_CHANNELS = new Set(["youtube", "newsletter", "podcast", "community", "social"]);
    const platformPlanCount = plans.filter((p) => PLATFORM_CHANNELS.has(p.channel)).length;
    const reserve = Math.min(platformPlanCount * perQuery, Math.floor(query.limit * 0.4));
    const primaryCap = Math.max(perQuery, query.limit - reserve);
    let primaryCount = 0;

    for (const plan of plans) {
      if (out.length >= query.limit) break;
      const isPlatform = PLATFORM_CHANNELS.has(plan.channel);
      if (!isPlatform && primaryCount >= primaryCap) continue; // hold room for platform queries
      let hits: SerpHit[];
      try {
        hits = await this.serp.search(plan.q, perQuery);
      } catch {
        continue; // isolate source failures (Section 8.1)
      }
      for (const hit of hits) {
        if (out.length >= query.limit) break;
        const host = safeHost(hit.url);
        if (!host) continue;
        const key = candidateKey(hit.url) ?? host;
        if (seen.has(key)) continue; // platform-aware: distinct creators on a host survive
        seen.add(key);

        // For path-based platforms (youtube.com/@x, …) the profile URL — not the bare
        // host — is the creator; social hits become channelUrl so the graph/enricher
        // can resolve the handle.
        const isSocial = SOCIAL_HOSTS.includes(host);
        const isPathPlatform = PATH_PLATFORM_HOSTS.includes(host);
        const siteUrl = isSocial ? null : isPathPlatform ? cleanUrl(hit.url) : `https://${host}`;
        const channelUrl = isSocial ? cleanUrl(hit.url) : null;

        // Fetch the page and run the REAL affiliate-link detector over it. On a
        // failed/short fetch we record ZERO affiliate links — we never fabricate
        // them (fabrication would create false positives even with a real SERP).
        let signals: AffiliateSignal[] = [];
        let pageHtml: string | null = null;
        let fetched = false;
        try {
          const page = await this.fetcher.get(hit.url);
          if (page.status >= 200 && page.status < 300 && page.html && page.html.length > 200) {
            pageHtml = page.html;
            signals = detectAffiliateLinksInHtml(page.html);
            fetched = true;
          }
        } catch {
          /* leave fetched=false, no links */
        }

        out.push({
          identity: hit.title.replace(/ — .*/, "").slice(0, 80),
          siteUrl,
          channelUrl,
          sourceType: this.sourceType,
          evidenceUrl: hit.url,
          evidenceSummary: fetched
            ? `Ranks for "${plan.q}" [${plan.channel}]; ${signals.length} affiliate link(s) detected on page. ${hit.snippet}`
            : `Ranks for "${plan.q}" [${plan.channel}] — page not fetched (no affiliate evidence collected). ${hit.snippet}`,
          outboundLinks: signals.map((s) => s.url),
          pageHtml,
          synthetic: this.synthetic,
        });
        if (!isPlatform) primaryCount++;
      }
    }
    return out;
  }
}

/** One referring link: a page (`urlFrom`) that links to a target (`urlTo`). */
export interface BacklinkRow {
  urlFrom: string;
  urlTo: string;
  anchor: string | null;
  /** Referring DOMAIN authority on a 0..100 scale (DataForSEO `domain_from_rank`,
   *  requested with `rank_scale: one_hundred`). null when the provider didn't supply it. */
  domainFromRank?: number | null;
}

/** A backlink data provider — real (DataForSEO) or a deterministic generator. */
export interface BacklinkProvider {
  readonly kind: string;
  /**
   * Pages that link AT the target domain. Server-side filters:
   *  - `urlToContains` — destination contains a substring (a `m=56789` merchant id) →
   *    the competitor's slice of a shared network domain.
   *  - `urlToContainsAny` — destination matches ANY of these (the apex path: common
   *    affiliate markers like `ref=`, `/go/`), so `one_per_domain` picks an AFFILIATE
   *    link, not a plain one, on a domain that has both.
   */
  referringLinks(
    targetDomain: string,
    limit: number,
    opts?: { urlToContains?: string; urlToContainsAny?: string[] },
  ): Promise<BacklinkRow[]>;
}

/** Common affiliate URL markers for the apex-domain server filter. */
export const AFFILIATE_MARKERS = ["ref=", "aff=", "affiliate", "via=", "partner=", "/go/", "/recommend", "/aff/"];

/**
 * Exact merchant-param check for network-targeted backlink rows. The provider-side
 * `url_to` filter is a substring LIKE (`%m=1234%` also matches `m=12345`), so a row
 * is only trusted once the destination URL carries the EXACT id.
 */
function hasExactParam(rawUrl: string, param: string, value: string): boolean {
  try {
    return new URL(rawUrl).searchParams.get(param) === value;
  } catch {
    // Unparseable URL → boundary-aware fallback: param=value ending at &, #, or end.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`[?&]${esc(param)}=${esc(value)}(?:[&#]|$)`).test(rawUrl);
  }
}

// Build a DataForSEO OR-of-LIKE filter (capped at 8, their max combined filters).
function orLikeFilter(field: string, values: string[]): unknown[] {
  const out: unknown[] = [];
  values.slice(0, 8).forEach((v, i) => {
    if (i > 0) out.push("or");
    out.push([field, "like", `%${v}%`]);
  });
  return out;
}

interface PostJson {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }>;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * DataForSEO Backlinks API adapter — pay-as-you-go, ~100× cheaper than Ahrefs.
 * Basic-auth POST to the live backlinks endpoint; maps rows to {urlFrom,urlTo,anchor}.
 */
export class DataForSEOBacklinkProvider implements BacklinkProvider {
  readonly kind = "dataforseo";
  constructor(private readonly opts: { login: string; password: string; http?: PostJson }) {}
  async referringLinks(target: string, limit: number, opts?: { urlToContains?: string; urlToContainsAny?: string[] }): Promise<BacklinkRow[]> {
    const auth = Buffer.from(`${this.opts.login}:${this.opts.password}`).toString("base64");
    const url = "https://api.dataforseo.com/v3/backlinks/backlinks/live";
    // For affiliate finding we want ONE row per referring domain (= one potential
    // affiliate), not every raw backlink — `one_per_domain` collapses a domain's
    // 100k+ links to its ~few-k referring domains, ~100× cheaper. Capped at the
    // endpoint max (1000 rows/request) and ordered by rank so the best come first.
    // No dofollow filter: affiliate links are typically rel=sponsored/nofollow.
    const task: Record<string, unknown> = {
      target,
      limit: Math.min(Math.max(1, limit), 1000),
      mode: "one_per_domain",
      backlinks_status_type: "live",
      order_by: ["rank,desc"],
      // Return ranks already on a 0..100 scale so `domain_from_rank` IS the domain
      // authority — no second call, no normalization math. (Free request parameter.)
      rank_scale: "one_hundred",
    };
    if (opts?.urlToContains) task.filters = [["url_to", "like", `%${opts.urlToContains}%`]];
    else if (opts?.urlToContainsAny?.length) task.filters = orLikeFilter("url_to", opts.urlToContainsAny);
    const body = [task];
    const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
    const res = this.opts.http ? await this.opts.http.post(url, body, headers) : await postJson(url, body, headers);
    const items = (res.json?.tasks?.[0]?.result?.[0]?.items ?? []) as Array<{ url_from?: string; url_to?: string; anchor?: string; domain_from_rank?: number }>;
    return items
      .map((i) => ({ urlFrom: i.url_from ?? "", urlTo: i.url_to ?? "", anchor: i.anchor ?? null, domainFromRank: typeof i.domain_from_rank === "number" ? i.domain_from_rank : null }))
      .filter((r) => r.urlFrom && r.urlTo);
  }
}

/** Deterministic backlink generator — affiliate links to the target, for offline/demo. */
export class DeterministicBacklinkProvider implements BacklinkProvider {
  readonly kind = "deterministic-backlink";
  async referringLinks(target: string, limit: number, _opts?: { urlToContains?: string; urlToContainsAny?: string[] }): Promise<BacklinkRow[]> {
    void _opts;
    const seed = parseInt(createHash("md5").update(target).digest("hex").slice(0, 8), 16);
    const base = target.split(".")[0] ?? "brand";
    const out: BacklinkRow[] = [];
    for (let i = 0; i < limit; i++) {
      const slug = `${base}-fan${(seed + i) % 53}`;
      // A deterministic 35..85 DA so demo prospects tier realistically (still synthetic).
      const domainFromRank = 35 + ((seed + i * 7) % 51);
      out.push({ urlFrom: `https://${slug}.com/best-${base}`, urlTo: `https://${target}/product?ref=${slug}`, anchor: `check out ${target}`, domainFromRank });
    }
    return out;
  }
}

// Resolver cache TTLs: a wrong entry poisons every later mining run, so hits expire
// daily; empties expire within the hour (a temporarily-unreachable site gets retried).
const RESOLVER_HIT_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLVER_MISS_TTL_MS = 60 * 60 * 1000;

// Homepage-only guard: a network-shaped link counts only when its href or the
// surrounding markup says affiliate/partner — the homepage routinely carries
// shared-network links the competitor merely PUBLISHES (pointing at ANOTHER merchant).
const AFFILIATE_CONTEXT = /affiliat|partner|refer/i;

/**
 * Resolves a competitor domain to its affiliate program(s) — the network + merchant
 * id (or vanity host) needed to query the RIGHT backlinks. Tries a manual override
 * first, then reads the competitor's own site: the dedicated "Affiliates"/"Partners"
 * paths FIRST (a program link there is unambiguously theirs), the homepage only as a
 * context-guarded fallback. Cached per competitor with a TTL.
 */
export class CompetitorProgramResolver {
  private readonly cache = new Map<string, { programs: ResolvedProgram[]; expiresAt: number }>();
  constructor(private readonly opts: { fetcher?: HttpFetcher; overrides?: Record<string, ResolvedProgram[]>; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async resolve(competitor: string): Promise<ResolvedProgram[]> {
    const domain = safeHost(competitor) ?? competitor.toLowerCase();
    const cached = this.cache.get(domain);
    if (cached && cached.expiresAt > this.now()) return cached.programs;
    let programs = this.opts.overrides?.[domain] ?? [];
    if (programs.length === 0 && this.opts.fetcher) programs = await this.fromSite(domain).catch(() => []);
    const deduped = dedupePrograms(programs);
    this.cache.set(domain, { programs: deduped, expiresAt: this.now() + (deduped.length ? RESOLVER_HIT_TTL_MS : RESOLVER_MISS_TTL_MS) });
    return deduped;
  }

  private async fromSite(domain: string): Promise<ResolvedProgram[]> {
    const found: ResolvedProgram[] = [];
    const fetchHtml = async (url: string): Promise<string | null> => {
      try {
        const r = await this.opts.fetcher!.get(url);
        return r.status >= 200 && r.status < 300 && r.html ? r.html : null;
      } catch {
        return null;
      }
    };
    // On a DEDICATED program page every network link is the competitor's own program.
    const scan = async (url: string): Promise<void> => {
      const html = await fetchHtml(url);
      if (!html) return;
      for (const href of extractHrefs(html, url)) {
        const p = identifyProgram(href);
        if (p) found.push(p);
      }
    };

    // 1) Dedicated program paths FIRST — the trustworthy source.
    const PROGRAM_PATHS = ["/affiliates", "/affiliate", "/affiliate-program", "/partners", "/partner-program", "/referral", "/ambassadors"];
    for (const path of PROGRAM_PATHS) {
      if (found.length) break;
      await scan(`https://${domain}${path}`);
    }

    // 2) Homepage as a fallback — but only links whose href / surrounding ~120 chars
    //    look affiliate-ish, so a link the competitor publishes to SOMEONE ELSE'S
    //    program never resolves as theirs.
    let home: string | null = null;
    if (found.length === 0) {
      home = await fetchHtml(`https://${domain}`);
      if (home) found.push(...programsFromHomepage(home, `https://${domain}`));
    }

    // 3) Follow an on-page "affiliate/partner" link if the common paths missed.
    if (found.length === 0 && home) {
      const links = extractHrefs(home, `https://${domain}`).filter((l) => /affiliate|partner|refer|ambassador/i.test(l) && safeHost(l) === domain);
      for (const l of links.slice(0, 3)) {
        if (found.length) break;
        await scan(l);
      }
    }
    return found;
  }
}

// Extract programs from the HOMEPAGE only when the href or ~120 chars of surrounding
// HTML carry affiliate context (the window includes the href itself).
function programsFromHomepage(html: string, baseUrl: string): ResolvedProgram[] {
  const out: ResolvedProgram[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let resolved: string;
    try {
      resolved = new URL(m[1]!, baseUrl).toString();
    } catch {
      continue;
    }
    const p = identifyProgram(resolved);
    if (!p) continue;
    const context = html.slice(Math.max(0, m.index! - 120), m.index! + m[0].length + 120);
    if (AFFILIATE_CONTEXT.test(context)) out.push(p);
  }
  return out;
}

function dedupePrograms(programs: ResolvedProgram[]): ResolvedProgram[] {
  const seen = new Set<string>();
  const out: ResolvedProgram[] = [];
  for (const p of programs) {
    const key = `${p.network}|${p.merchantId ?? p.vanityHost ?? p.merchantDomain ?? ""}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * Backlink / competitor-affiliate mining (Section 8.1) — the WARMEST source. For each
 * competitor it resolves the affiliate program (network + merchant id / vanity host)
 * and queries the RIGHT backlinks: the vanity host directly, or the network domain
 * filtered by the merchant id. When a program can't be resolved it falls back to the
 * competitor's apex (catches branded `?ref=` affiliates only). With no provider wired
 * it returns nothing rather than fabricate.
 */
export class BacklinkDiscoverySource implements DiscoverySource {
  readonly sourceType = "backlink_mining";
  readonly synthetic: boolean;
  constructor(
    private readonly provider?: BacklinkProvider,
    private readonly resolver?: CompetitorProgramResolver,
  ) {
    this.synthetic = provider ? provider.kind === "deterministic-backlink" : false;
  }

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    if (!this.provider) return []; // not wired → honest empty
    const competitors = query.competitors.map((c) => safeHost(c) ?? c.toLowerCase()).filter(Boolean);
    if (competitors.length === 0) return [];

    const perCompetitor = Math.max(1, Math.ceil(query.limit / competitors.length));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];

    for (const competitor of competitors) {
      if (out.length >= query.limit) break;
      // Resolve the program → precise backlink targets. Fall back to the apex domain.
      const programs = this.resolver ? await this.resolver.resolve(competitor).catch(() => []) : [];
      const targets = programs.flatMap((p) => backlinkTargetsFor(p, competitor));
      const queries: BacklinkTarget[] = targets.length ? targets : [{ target: competitor }];

      for (const t of queries) {
        if (out.length >= query.limit) break;
        // A network-targeted query (id filter / vanity host) is, by construction, the
        // competitor's affiliates — confirmed. An apex query filters to affiliate-marker
        // links server-side (so one_per_domain picks an affiliate link) and still runs the
        // per-link check below.
        const networkTargeted = safeHost(t.target) !== competitor;
        let rows: BacklinkRow[];
        try {
          rows = await this.provider.referringLinks(
            t.target,
            perCompetitor * 4,
            networkTargeted ? { urlToContains: t.urlToContains } : { urlToContainsAny: AFFILIATE_MARKERS },
          );
        } catch {
          continue;
        }
        for (const row of rows) {
          if (out.length >= query.limit) break;
          if (networkTargeted) {
            // The server-side merchant-id filter is a substring LIKE, so a shared-network
            // row must carry the EXACT id before it earns `confirmedCompetitor` — a row
            // failing this provably belongs to ANOTHER merchant on the network → drop it.
            if (t.param && t.value && !hasExactParam(row.urlTo, t.param, t.value)) continue;
          } else {
            // Apex fallback: require an affiliate signature pointing at the competitor.
            if (detectAffiliateUrl(row.urlTo).length === 0) continue;
            const th = safeHost(row.urlTo);
            if (!th || !competitors.some((c) => th === c || th.endsWith(`.${c}`))) continue;
          }
          const host = safeHost(row.urlFrom);
          if (!host || seen.has(host)) continue;
          seen.add(host);
          out.push({
            identity: host,
            siteUrl: `https://${host}`,
            channelUrl: null,
            sourceType: this.sourceType,
            evidenceUrl: row.urlFrom,
            evidenceSummary: `Promotes ${competitor} with an affiliate link${row.anchor ? ` (anchor: "${row.anchor.slice(0, 60)}")` : ""} — a proven affiliate in your niche.`,
            outboundLinks: [row.urlTo],
            confirmedCompetitor: competitor,
            domainAuthority: row.domainFromRank ?? null, // referring-domain rank, free from the backlinks response
            pageHtml: null,
            synthetic: this.synthetic,
          });
        }
      }
    }
    return out;
  }
}

/**
 * First-party customer mining (Section 8.1) — the warmest source. Reads the
 * merchant's REAL orders/customers, surfaces repeat / high-AOV buyers, and emits
 * them as candidates (already-known, low-bounce). No scraping.
 */
export class DbCustomerMiningSource implements DiscoverySource {
  readonly sourceType = "customer_mining";
  constructor(private readonly db: Database) {}

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const orders = await this.db.orders.find((o) => o.merchantId === query.merchantId);
    if (orders.length === 0) return [];

    // Aggregate by customer: order count + total spend.
    const byCustomer = new Map<string, { count: number; spendCents: number }>();
    for (const o of orders) {
      if (!o.customerId) continue;
      const agg = byCustomer.get(o.customerId) ?? { count: 0, spendCents: 0 };
      agg.count += 1;
      agg.spendCents += o.amountCents;
      byCustomer.set(o.customerId, agg);
    }

    // Rank by spend, take the top buyers (warmest, highest-LTV).
    const ranked = [...byCustomer.entries()].sort((a, b) => b[1].spendCents - a[1].spendCents).slice(0, query.limit);
    const out: RawCandidate[] = [];
    for (const [customerId, agg] of ranked) {
      const customer = await this.db.customers.get(customerId);
      out.push({
        identity: customer?.externalCustomerId ?? `Customer ${customerId.slice(-6)}`,
        siteUrl: null,
        channelUrl: null,
        sourceType: this.sourceType,
        evidenceUrl: null,
        evidenceSummary: `Repeat buyer: ${agg.count} orders, $${(agg.spendCents / 100).toFixed(0)} lifetime spend — high product affinity.`,
        outboundLinks: [],
        reachHint: Math.min(50_000, agg.spendCents),
        synthetic: false, // real first-party order data
      });
    }
    return out;
  }
}

interface SearchJsonHttp {
  get(url: string): Promise<{ status: number; json: any }>;
}

/**
 * Direct YouTube creator discovery (Section 8.1). Competitor backlink mining finds the
 * affiliates who run WEBSITES; this finds the other half — video creators who review
 * products in the niche but often have no site to backlink-mine. One `search.list`
 * (type=video, 100 quota) per query returns niche-review videos; we collapse them to
 * the distinct CHANNELS behind them. Reach / engagement / country are filled later for
 * free by {@link YouTubeEnricher} (the channel id flows through the identity graph).
 * Real source, key-gated; with no key it isn't wired at all (honest absence, not synthetic).
 */
export class YouTubeDiscoverySource implements DiscoverySource {
  readonly sourceType = "youtube_discovery";
  constructor(private readonly opts: { apiKey: string; http: SearchJsonHttp; maxQueries?: number }) {}

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const niche = (query.niche || "products").trim();
    const queries = [`${niche} review`, `best ${niche}`, ...query.competitors.slice(0, 2).map((c) => `${safeHost(c) ?? c} review`)]
      .filter(Boolean)
      .slice(0, this.opts.maxQueries ?? 3);

    const perQuery = Math.min(50, Math.max(1, Math.ceil(query.limit / Math.max(1, queries.length))));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];
    const base = "https://www.googleapis.com/youtube/v3";

    for (const q of queries) {
      if (out.length >= query.limit) break;
      let res: { status: number; json: any };
      try {
        res = await this.opts.http.get(
          `${base}/search?part=snippet&type=video&order=relevance&maxResults=${perQuery}&q=${encodeURIComponent(q)}&key=${this.opts.apiKey}`,
        );
      } catch {
        continue; // isolate source failures (Section 8.1)
      }
      const items = (res.json?.items ?? []) as Array<{
        id?: { videoId?: string };
        snippet?: { channelId?: string; channelTitle?: string; title?: string };
      }>;
      for (const it of items) {
        if (out.length >= query.limit) break;
        const channelId = it.snippet?.channelId;
        if (!channelId || seen.has(channelId)) continue; // distinct channels only
        seen.add(channelId);
        const channelUrl = `https://www.youtube.com/channel/${channelId}`;
        const videoUrl = it.id?.videoId ? `https://www.youtube.com/watch?v=${it.id.videoId}` : channelUrl;
        out.push({
          identity: it.snippet?.channelTitle ?? channelId,
          siteUrl: null,
          channelUrl,
          sourceType: this.sourceType,
          evidenceUrl: videoUrl,
          evidenceSummary: `YouTube creator surfacing for "${q}"${it.snippet?.title ? ` — e.g. "${it.snippet.title.slice(0, 70)}"` : ""}.`,
          outboundLinks: [],
          pageHtml: null,
          synthetic: false,
        });
      }
    }
    return out;
  }
}

/** A creator returned by the scraping-API search actor (hashtag/keyword). */
interface ScrapedCreator {
  handle?: string;
  username?: string;
  platform?: string;
  url?: string;
  profileUrl?: string;
  displayName?: string;
  fullName?: string;
  followers?: number;
  followerCount?: number;
}

/**
 * Instagram / TikTok creator discovery (AUDIT-2026-07 #47) via the same scraping-API vendor
 * (SCRAPE_API_URL) already used for enrichment. Competitor backlink mining finds affiliates
 * who run WEBSITES + the YouTube source finds video creators; this reaches the platforms where
 * most consumer-product affiliates actually live but have no site to backlink-mine. It searches
 * the niche + competitor brand as hashtags/keywords, returns DISTINCT creator handles as
 * RawCandidates with `channelUrl` set — the identity graph, ScrapeMetricsEnricher, and the
 * compliant DM-queue path take over from there. Key-gated: with no endpoint it isn't wired at
 * all (honest absence, never fabricated creators).
 */
export class SocialCreatorDiscoverySource implements DiscoverySource {
  readonly sourceType = "social_discovery";
  constructor(private readonly opts: { endpoint?: string; apiKey?: string; http?: SearchJsonHttp; platforms?: string[]; maxQueries?: number }) {}

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    if (!this.opts.endpoint || !this.opts.http) return []; // not wired → honest empty, never invented
    const platforms = this.opts.platforms ?? ["instagram", "tiktok"];
    const niche = (query.niche || "products").trim();
    // Niche keyword + competitor brand tokens as search terms (hashtag-style).
    const terms = [niche, `best ${niche}`, ...query.competitors.slice(0, 2).map((c) => (safeHost(c) ?? c).replace(/\.[a-z.]+$/i, ""))]
      .filter(Boolean)
      .slice(0, this.opts.maxQueries ?? 3);

    const perTerm = Math.max(1, Math.ceil(query.limit / Math.max(1, terms.length * platforms.length)));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];

    for (const platform of platforms) {
      for (const term of terms) {
        if (out.length >= query.limit) break;
        let res: { status: number; json: any };
        try {
          res = await this.opts.http.get(
            `${this.opts.endpoint}?type=search&platform=${platform}&q=${encodeURIComponent(term)}&limit=${perTerm}${this.opts.apiKey ? `&token=${this.opts.apiKey}` : ""}`,
          );
        } catch {
          continue; // isolate source failures (Section 8.1)
        }
        const creators = (res.json?.data ?? res.json?.results ?? res.json ?? []) as ScrapedCreator[];
        if (!Array.isArray(creators)) continue;
        for (const c of creators) {
          if (out.length >= query.limit) break;
          const handle = (c.handle ?? c.username ?? "").replace(/^@/, "").trim();
          if (!handle) continue;
          const plat = (c.platform ?? platform).toLowerCase();
          const key = `${plat}:${handle.toLowerCase()}`;
          if (seen.has(key)) continue; // distinct creators only
          seen.add(key);
          const profileUrl = c.url ?? c.profileUrl ?? profileUrlFor(plat, handle);
          if (!profileUrl) continue;
          const followers = numOrUndef(c.followers ?? c.followerCount);
          out.push({
            identity: c.displayName ?? c.fullName ?? `@${handle}`,
            siteUrl: null,
            channelUrl: profileUrl,
            sourceType: this.sourceType,
            evidenceUrl: profileUrl,
            evidenceSummary: `${plat} creator surfacing for "${term}"${followers ? ` — ~${followers.toLocaleString()} followers` : ""}.`,
            outboundLinks: [],
            ...(followers ? { reachHint: followers } : {}),
            pageHtml: null,
            synthetic: false,
          });
        }
      }
    }
    return out;
  }
}

function profileUrlFor(platform: string, handle: string): string | null {
  switch (platform) {
    case "instagram":
      return `https://instagram.com/${handle}`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "twitter":
    case "x":
      return `https://x.com/${handle}`;
    default:
      return null;
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
