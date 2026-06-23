import type { DiscoveryQuery } from "./ports.js";

/**
 * Discovery query strategy (Section 8.1). Turns a merchant's ICP — niche,
 * competitors, keywords, channels — into a PRIORITIZED, deduped, capped set of SERP
 * queries. Order is the strategy: competitor-affiliate mining first (the warmest,
 * strongest-signal source — people already promoting a rival), then buyer-intent
 * listicles, then merchant keywords, then platform-targeted queries that surface
 * creators on YouTube / newsletters / podcasts directly via SERP (so we reach the
 * walled platforms without their hostile APIs — the identity graph + enrichers take
 * over from there). The cap bounds SERP spend per run.
 */

export interface PlannedQuery {
  q: string;
  /** Which channel this query targets — carried onto candidates for source-yield. */
  channel: "blog" | "youtube" | "newsletter" | "podcast" | "community" | "social";
}

export function buildDiscoveryQueries(query: DiscoveryQuery, opts?: { max?: number }): PlannedQuery[] {
  const niche = (query.niche || "products").trim();
  const competitors = query.competitors.map((c) => c.trim()).filter(Boolean);
  const keywords = query.keywords.map((k) => k.trim()).filter(Boolean);
  const channels = new Set(query.channels);
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();
  const add = (raw: string, channel: PlannedQuery["channel"]) => {
    const q = raw.trim().replace(/\s+/g, " ");
    const key = q.toLowerCase();
    if (!q || seen.has(key)) return;
    seen.add(key);
    out.push({ q, channel });
  };

  // 1) Competitor-affiliate mining — warmest source, so it goes first.
  for (const c of competitors.slice(0, 5)) {
    add(`${c} review`, "blog");
    add(`${c} alternative`, "blog");
    add(`${c} vs`, "blog");
    add(`${c} coupon`, "blog");
  }

  // 2) Buyer-intent listicles / comparisons (high commercial intent).
  if (channels.has("serp") || channels.has("blog")) {
    add(`best ${niche}`, "blog");
    add(`${niche} review`, "blog");
    add(`top ${niche}`, "blog");
    add(`${niche} vs`, "blog");
    add(`${niche} comparison`, "blog");
    add(`${niche} buying guide`, "blog");
  }

  // 3) Merchant-provided keywords.
  for (const kw of keywords.slice(0, 6)) add(`${kw} review`, "blog");

  // 4) Platform-targeted creator discovery (multi-platform via SERP).
  if (channels.has("youtube")) {
    add(`${niche} review youtube`, "youtube");
    add(`site:youtube.com ${niche} review`, "youtube");
  }
  if (channels.has("newsletter")) {
    add(`site:substack.com ${niche}`, "newsletter");
    add(`best ${niche} newsletter`, "newsletter");
  }
  if (channels.has("podcast")) add(`${niche} podcast`, "podcast");
  if (channels.has("community")) add(`site:reddit.com ${niche} recommendations`, "community");

  return out.slice(0, opts?.max ?? 14);
}
