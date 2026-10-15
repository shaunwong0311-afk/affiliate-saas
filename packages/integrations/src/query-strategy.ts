import type { DiscoveryQuery } from "./ports.js";

/**
 * Discovery query strategy (Section 8.1). Turns a merchant's ICP — niche,
 * competitors, keywords, channels — into a PRIORITIZED, deduped, capped set of SERP
 * queries. Three groups, each with its own share of the cap so none can starve the
 * others:
 *
 *  - competitor-affiliate mining (the warmest source — people already promoting a rival);
 *  - buyer-intent listicles + the merchant's own keywords;
 *  - platform-targeted queries that surface creators on YouTube / newsletters /
 *    podcasts / Reddit / Instagram / TikTok directly via SERP (so we reach the walled
 *    platforms without their hostile APIs — the identity graph + enrichers take over
 *    from there).
 *
 * The plan is usually LONGER than the cap (the cap bounds SERP spend per run). Rather
 * than always running the same head of each list — which is how the podcast, Reddit,
 * Instagram and TikTok queries used to never run at all — each group is a WINDOW that
 * `rotation` slides along, so successive runs cover the whole plan.
 */

export interface PlannedQuery {
  q: string;
  /** Which channel this query targets — carried onto candidates for source-yield. */
  channel: "blog" | "youtube" | "newsletter" | "podcast" | "community" | "social";
}

/** Channels whose discovery happens on a walled platform (reached via `site:` SERP). */
const PLATFORM_CHANNELS = new Set<PlannedQuery["channel"]>(["youtube", "newsletter", "podcast", "community", "social"]);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * `slots` items of `list`, starting at a position that moves with `rotation`. The step
 * between runs is the largest value ≤ `slots` that is coprime with the list length, so
 * consecutive windows barely overlap AND the start visits every position — every query
 * gets to be first in its window, which matters when the caller's own budget lets only
 * the head of a window actually execute.
 */
function windowOf<T>(list: T[], slots: number, rotation: number): T[] {
  const n = list.length;
  if (slots >= n) return list;
  if (slots <= 0) return [];
  let step = slots;
  while (step > 1 && gcd(step, n) !== 1) step--;
  const start = (((rotation * step) % n) + n) % n;
  return Array.from({ length: slots }, (_, i) => list[(start + i) % n]!);
}

/** Merge two lists keeping their proportions level (`a` leads on ties), so any PREFIX holds both. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && i * b.length <= j * a.length)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

/** Take from each list in turn (first of every list, then second of every list, …). */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]!);
  }
  return out;
}

export function buildDiscoveryQueries(query: DiscoveryQuery, opts?: { max?: number; rotation?: number }): PlannedQuery[] {
  const niche = (query.niche || "products").trim();
  const competitors = query.competitors.map((c) => c.trim()).filter(Boolean);
  const keywords = query.keywords.map((k) => k.trim()).filter(Boolean);
  const channels = new Set(query.channels);
  const seen = new Set<string>();
  const make = (raw: string, channel: PlannedQuery["channel"]): PlannedQuery[] => {
    const q = raw.trim().replace(/\s+/g, " ");
    const key = q.toLowerCase();
    if (!q || seen.has(key)) return [];
    seen.add(key);
    return [{ q, channel }];
  };

  // 1) Competitor-affiliate mining — warmest source. Ordered by INTENT across
  //    competitors (every competitor's "review" before anyone's "coupon"), so a window
  //    of any size touches as many competitors as it can.
  const comps = competitors.slice(0, 5);
  const competitorQs = ["review", "alternative", "vs", "coupon"].flatMap((intent) => comps.flatMap((c) => make(`${c} ${intent}`, "blog")));

  // 2) Buyer-intent listicles / comparisons, then the merchant's own keywords.
  const intentQs: PlannedQuery[] = [];
  if (channels.has("serp") || channels.has("blog")) {
    for (const q of [`best ${niche}`, `${niche} review`, `top ${niche}`, `${niche} vs`, `${niche} comparison`, `${niche} buying guide`]) {
      intentQs.push(...make(q, "blog"));
    }
  }
  // A keyword that already asks for reviews is used as-is ("skincare review review" is not a query).
  for (const kw of keywords.slice(0, 6)) intentQs.push(...make(/\breviews?$/i.test(kw) ? kw : `${kw} review`, "blog"));

  // 3) Platform-targeted creator discovery, one list per channel, then round-robin so a
  //    window spans channels instead of being all YouTube. The `site:` form goes first.
  const perChannel: PlannedQuery[][] = [];
  if (channels.has("youtube")) perChannel.push([...make(`site:youtube.com ${niche} review`, "youtube"), ...make(`${niche} review youtube`, "youtube")]);
  if (channels.has("newsletter")) perChannel.push([...make(`site:substack.com ${niche}`, "newsletter"), ...make(`best ${niche} newsletter`, "newsletter")]);
  if (channels.has("podcast")) perChannel.push(make(`${niche} podcast`, "podcast"));
  if (channels.has("community")) perChannel.push(make(`site:reddit.com ${niche} recommendations`, "community"));
  // Reach IG/TikTok creators through SERP even without the scrape key (the zero-extra-key
  // fallback for the SocialCreatorDiscoverySource); the SERP source sets channelUrl for these.
  if (channels.has("social")) perChannel.push([...make(`site:instagram.com ${niche}`, "social"), ...make(`site:tiktok.com ${niche} review`, "social")]);
  const platformQs = roundRobin(perChannel);

  // Split the cap. Platform queries keep ~35%; of the rest buyer-intent keeps ~40% when
  // there are competitors (a long competitor list used to leave it one slot) — but never
  // the ONLY slot: with room for a single primary query it is a competitor query, the
  // warmest. Whatever a group cannot use flows to the others.
  const max = Math.max(0, opts?.max ?? 14);
  let platformSlots = Math.min(platformQs.length, Math.floor(max * 0.35));
  const primary = max - platformSlots;
  let intentSlots =
    competitorQs.length === 0 ? Math.min(intentQs.length, primary) : Math.min(intentQs.length, Math.max(primary > 1 ? 1 : 0, Math.floor(primary * 0.4)));
  const competitorSlots = Math.min(competitorQs.length, primary - intentSlots);
  intentSlots = Math.min(intentQs.length, primary - competitorSlots);
  platformSlots = Math.min(platformQs.length, max - competitorSlots - intentSlots);

  const rotation = Math.max(0, Math.floor(opts?.rotation ?? query.rotation ?? 0));
  // Competitor and buyer-intent queries are interleaved (competitors lead), so a caller
  // that stops early for budget reasons has still run some of each.
  return [
    ...interleave(windowOf(competitorQs, competitorSlots, rotation), windowOf(intentQs, intentSlots, rotation)),
    ...windowOf(platformQs, platformSlots, rotation),
  ];
}
