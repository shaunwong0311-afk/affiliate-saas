import { createHash } from "node:crypto";
import { detectAffiliateLinksInHtml, detectAffiliateUrl, type AffiliateSignal } from "@affiliate/core";
import type { Database } from "@affiliate/db";
import type { DiscoveryQuery, DiscoverySource, RawCandidate } from "./ports.js";
import { DeterministicFetcher, type HttpFetcher } from "./http.js";
import { buildDiscoveryQueries } from "./query-strategy.js";

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
  /** Pages that link AT the target domain (i.e. who already links to the competitor). */
  referringLinks(targetDomain: string, limit: number): Promise<BacklinkRow[]>;
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
  async referringLinks(target: string, limit: number): Promise<BacklinkRow[]> {
    const auth = Buffer.from(`${this.opts.login}:${this.opts.password}`).toString("base64");
    const url = "https://api.dataforseo.com/v3/backlinks/backlinks/live";
    const body = [{ target, limit, mode: "as_is", backlinks_status_type: "live" }];
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
  async referringLinks(target: string, limit: number): Promise<BacklinkRow[]> {
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
 * Backlink / competitor-affiliate mining (Section 8.1) — the WARMEST source. Pulls
 * who already links to each competitor, then keeps only the referring pages whose
 * link carries an AFFILIATE signature — that's what separates a proven affiliate
 * (promoting a rival for commission) from a mere mention. With no provider wired it
 * returns nothing rather than fabricate.
 */
export class BacklinkDiscoverySource implements DiscoverySource {
  readonly sourceType = "backlink_mining";
  readonly synthetic: boolean;
  constructor(private readonly provider?: BacklinkProvider) {
    this.synthetic = provider ? provider.kind === "deterministic-backlink" : false;
  }
  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    if (!this.provider) return []; // not wired → honest empty
    const competitors = query.competitors.map((c) => c.toLowerCase().replace(/^www\./, "")).filter(Boolean);
    if (competitors.length === 0) return [];

    const perCompetitor = Math.max(1, Math.ceil(query.limit / competitors.length));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];

    for (const competitor of competitors) {
      if (out.length >= query.limit) break;
      let rows: BacklinkRow[];
      try {
        rows = await this.provider.referringLinks(competitor, perCompetitor * 4); // over-fetch; most get filtered
      } catch {
        continue;
      }
      for (const row of rows) {
        if (out.length >= query.limit) break;
        // QUALITY FILTER: the link to the competitor must carry an affiliate signature.
        if (detectAffiliateUrl(row.urlTo).length === 0) continue;
        const targetHost = safeHost(row.urlTo);
        if (!targetHost || !competitors.some((c) => targetHost === c || targetHost.endsWith(`.${c}`))) continue;
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
          pageHtml: null,
          synthetic: this.synthetic,
        });
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
