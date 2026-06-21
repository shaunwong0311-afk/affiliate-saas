import { createHash } from "node:crypto";
import type { DiscoveryQuery, DiscoverySource, RawCandidate } from "./ports.js";

/**
 * Sourcing / discovery (Section 8.1). Production uses resilient headless-browser
 * workers (Playwright) with proxy rotation and official APIs (SERP, backlinks,
 * creator data). These stubs are deterministic generators so the recruitment
 * pipeline produces realistic candidates — including outbound links carrying real
 * affiliate signatures and competitor links — which light up the pure
 * affiliate-detection + scoring logic downstream.
 */

function rng(seed: string): () => number {
  let h = parseInt(createHash("md5").update(seed).digest("hex").slice(0, 8), 16);
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 0xffffffff;
  };
}

const AFFILIATE_LINK_TEMPLATES = [
  (host: string) => `https://${host}/review?ref=creator${"X"}`,
  (host: string) => `https://amzn.to/3abc?tag=creator-20`,
  (host: string) => `https://shareasale.com/r.cfm?u=12345&m=678&urllink=${host}`,
  (host: string) => `https://${host}/go/deal`,
];

/**
 * Competitor-affiliate mining — the headline source. Generates creators who
 * already promote the merchant's competitors (the warmest, strongest-signal
 * targets), with detectable affiliate links pointing at competitor domains.
 */
export class CompetitorAffiliateSource implements DiscoverySource {
  readonly sourceType = "competitor_affiliate_mining";

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const out: RawCandidate[] = [];
    const competitors = query.competitors.length ? query.competitors : ["competitor.com"];
    const n = Math.min(query.limit, 8);
    for (let i = 0; i < n; i++) {
      const rand = rng(`${query.merchantId}:comp:${i}`);
      const competitor = competitors[i % competitors.length]!;
      const slug = `${query.niche.replace(/\s+/g, "")}creator${i + 1}`.toLowerCase();
      const host = `${slug}.com`;
      const links = [
        `https://${competitor}/buy?ref=${slug}`, // promotes a direct competitor
        AFFILIATE_LINK_TEMPLATES[i % AFFILIATE_LINK_TEMPLATES.length]!(competitor),
      ];
      out.push({
        identity: `${query.niche} reviewer ${i + 1}`,
        siteUrl: `https://${host}`,
        channelUrl: null,
        sourceType: this.sourceType,
        evidenceUrl: `https://${host}/best-${query.niche.replace(/\s+/g, "-")}`,
        evidenceSummary: `Ranks for "best ${query.niche}" and "${competitor} review"; outbound affiliate links to ${competitor}.`,
        outboundLinks: links,
        reachHint: Math.floor(2000 + rand() * 400_000),
        synthetic: true,
      });
    }
    return out;
  }
}

/** Creator discovery (YouTube/blogs/newsletters) — generic affiliate signals. */
export class CreatorDiscoverySource implements DiscoverySource {
  readonly sourceType = "creator_discovery";

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const out: RawCandidate[] = [];
    const n = Math.min(query.limit, 6);
    for (let i = 0; i < n; i++) {
      const rand = rng(`${query.merchantId}:creator:${i}`);
      const slug = `${query.niche.replace(/\s+/g, "")}tube${i + 1}`.toLowerCase();
      const promotes = rand() > 0.5;
      out.push({
        identity: `${query.niche} channel ${i + 1}`,
        siteUrl: null,
        channelUrl: `https://youtube.com/@${slug}`,
        sourceType: this.sourceType,
        evidenceUrl: `https://youtube.com/@${slug}/about`,
        evidenceSummary: `Covers ${query.niche}; description ${promotes ? "contains affiliate links" : "lists a business email"}.`,
        outboundLinks: promotes ? [`https://${slug}.com/recommends/gear?ref=yt`] : [],
        reachHint: Math.floor(500 + rand() * 200_000),
        synthetic: true,
      });
    }
    return out;
  }
}

/** Customer mining — warmest, highest-converting (Section 8.1). */
export class CustomerMiningSource implements DiscoverySource {
  readonly sourceType = "customer_mining";

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const out: RawCandidate[] = [];
    const n = Math.min(query.limit, 4);
    for (let i = 0; i < n; i++) {
      const rand = rng(`${query.merchantId}:cust:${i}`);
      out.push({
        identity: `Engaged customer ${i + 1}`,
        siteUrl: rand() > 0.5 ? `https://customer${i + 1}-blog.com` : null,
        channelUrl: null,
        sourceType: this.sourceType,
        evidenceUrl: null,
        evidenceSummary: `Repeat buyer, high NPS; ${rand() > 0.5 ? "runs a niche blog" : "active on social"}.`,
        outboundLinks: [],
        reachHint: Math.floor(100 + rand() * 20_000),
        synthetic: true,
      });
    }
    return out;
  }
}

export const DEFAULT_DISCOVERY_SOURCES: DiscoverySource[] = [
  new CompetitorAffiliateSource(),
  new CreatorDiscoverySource(),
  new CustomerMiningSource(),
];
