import { createHash } from "node:crypto";
import { detectAffiliateLinksInHtml, type AffiliateSignal } from "@affiliate/core";
import type { Database } from "@affiliate/db";
import type { DiscoveryQuery, DiscoverySource, RawCandidate } from "./ports.js";
import { DeterministicFetcher, type HttpFetcher } from "./http.js";

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
  ) {
    this.synthetic = serp.kind === "deterministic-serp" || fetcher.kind === "deterministic";
  }

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const niche = query.niche || "products";
    const competitors = query.competitors.length ? query.competitors : ["competitor.com"];
    const queries = [
      `best ${niche}`,
      `${niche} review`,
      ...competitors.slice(0, 2).map((c) => `${c} review`),
      ...competitors.slice(0, 2).map((c) => `${c} alternative`),
      `${niche} vs`,
    ];

    const perQuery = Math.max(1, Math.ceil(query.limit / queries.length));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];

    for (const q of queries) {
      let hits: SerpHit[];
      try {
        hits = await this.serp.search(q, perQuery);
      } catch {
        continue; // isolate source failures (Section 8.1)
      }
      for (const hit of hits) {
        if (out.length >= query.limit) break;
        const host = safeHost(hit.url);
        if (!host || seen.has(host)) continue;
        seen.add(host);

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
          siteUrl: `https://${host}`,
          channelUrl: null,
          sourceType: this.sourceType,
          evidenceUrl: hit.url,
          evidenceSummary: fetched
            ? `Ranks for "${q}"; ${signals.length} affiliate link(s) detected on page. ${hit.snippet}`
            : `Ranks for "${q}" — page not fetched (no affiliate evidence collected). ${hit.snippet}`,
          outboundLinks: signals.map((s) => s.url),
          pageHtml,
          synthetic: this.synthetic,
        });
      }
    }
    return out;
  }
}

/** Backlink/competitor-affiliate mining (Ahrefs/SEMrush) — real-shape skeleton. */
export class BacklinkDiscoverySource implements DiscoverySource {
  readonly sourceType = "backlink_mining";
  constructor(private readonly opts: { apiKey?: string; http?: { get(url: string): Promise<{ status: number; json: any }> } } = {}) {}
  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    if (!this.opts.http || !this.opts.apiKey) {
      // No backlink API wired — defer to SERP mining; return nothing rather than fabricate.
      void query;
      return [];
    }
    // Real impl: for each competitor domain, pull referring domains, filter to
    // pages that link out with affiliate signatures, emit candidates.
    return [];
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
