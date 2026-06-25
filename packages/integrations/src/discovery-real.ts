import { createHash } from "node:crypto";
import {
  detectAffiliateLinksInHtml,
  detectAffiliateUrl,
  identifyProgram,
  backlinkTargetsFor,
  type AffiliateSignal,
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
const SOCIAL_HOSTS = ["youtube.com", "twitter.com", "x.com", "instagram.com", "tiktok.com"];
const PATH_PLATFORM_HOSTS = [...SOCIAL_HOSTS, "medium.com", "reddit.com"];

function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * A stable identity key for dedup. For path-based platforms (youtube.com/@a vs
 * youtube.com/@b) the first path segment is part of the key, so distinct creators on
 * the same host are NOT collapsed; ordinary sites key on host.
 */
function candidateKey(url: string): string | null {
  const host = safeHost(url);
  if (!host) return null;
  if (!PATH_PLATFORM_HOSTS.includes(host)) return host;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
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

    for (const plan of plans) {
      if (out.length >= query.limit) break;
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
    };
    if (opts?.urlToContains) task.filters = [["url_to", "like", `%${opts.urlToContains}%`]];
    else if (opts?.urlToContainsAny?.length) task.filters = orLikeFilter("url_to", opts.urlToContainsAny);
    const body = [task];
    const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
    const res = this.opts.http ? await this.opts.http.post(url, body, headers) : await postJson(url, body, headers);
    const items = (res.json?.tasks?.[0]?.result?.[0]?.items ?? []) as Array<{ url_from?: string; url_to?: string; anchor?: string }>;
    return items
      .map((i) => ({ urlFrom: i.url_from ?? "", urlTo: i.url_to ?? "", anchor: i.anchor ?? null }))
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
      out.push({ urlFrom: `https://${slug}.com/best-${base}`, urlTo: `https://${target}/product?ref=${slug}`, anchor: `check out ${target}` });
    }
    return out;
  }
}

/**
 * Resolves a competitor domain to its affiliate program(s) — the network + merchant
 * id (or vanity host) needed to query the RIGHT backlinks. Tries a manual override
 * first, then reads the competitor's own site (their "Affiliates"/"Partners" page
 * links into the network with the id baked in). Cached per competitor.
 */
export class CompetitorProgramResolver {
  private readonly cache = new Map<string, ResolvedProgram[]>();
  constructor(private readonly opts: { fetcher?: HttpFetcher; overrides?: Record<string, ResolvedProgram[]> } = {}) {}

  async resolve(competitor: string): Promise<ResolvedProgram[]> {
    const domain = safeHost(competitor) ?? competitor.toLowerCase();
    const cached = this.cache.get(domain);
    if (cached) return cached;
    let programs = this.opts.overrides?.[domain] ?? [];
    if (programs.length === 0 && this.opts.fetcher) programs = await this.fromSite(domain).catch(() => []);
    const deduped = dedupePrograms(programs);
    this.cache.set(domain, deduped);
    return deduped;
  }

  private async fromSite(domain: string): Promise<ResolvedProgram[]> {
    const found: ResolvedProgram[] = [];
    const scan = async (url: string): Promise<string | null> => {
      try {
        const r = await this.opts.fetcher!.get(url);
        if (r.status < 200 || r.status >= 300 || !r.html) return null;
        for (const href of extractHrefs(r.html, url)) {
          const p = identifyProgram(href);
          if (p) found.push(p);
        }
        return r.html;
      } catch {
        return null;
      }
    };
    const home = await scan(`https://${domain}`);
    const PROGRAM_PATHS = ["/affiliates", "/affiliate", "/affiliate-program", "/partners", "/partner-program", "/referral", "/ambassadors"];
    for (const path of PROGRAM_PATHS) {
      if (found.length) break;
      await scan(`https://${domain}${path}`);
    }
    // Follow an on-page "affiliate/partner" link if the common paths missed.
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
      const queries = targets.length ? targets : [{ target: competitor, urlToContains: undefined as string | undefined }];

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
          if (!networkTargeted) {
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
