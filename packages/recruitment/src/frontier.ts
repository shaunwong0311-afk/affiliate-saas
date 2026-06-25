import { newId, competitorHostsFromLinks } from "@affiliate/core";
import type { Merchant, Prospect } from "@affiliate/db";
import { extractHrefs, type DiscoveryQuery, type RawCandidate } from "@affiliate/integrations";
import type { RecruitmentDeps } from "./deps.js";
import { ingestCandidate } from "./pipeline.js";

/**
 * Recursive discovery — the merchant-expansion frontier engine (Section 8.1). The
 * snowball: backlink-mine a competitor → ingest its affiliates → read THOSE
 * affiliates' other affiliate links → the merchants they ALSO promote are de-facto
 * competitors → promote the frequently co-promoted ones into the frontier → mine
 * them next cycle. From a few seed competitors it maps the whole niche's affiliate
 * ecosystem. Every step is HARD-CAPPED (seeds, expansions, new seeds, depth, a
 * co-promotion threshold) so it can't run away; the frontier persists across cycles,
 * so it's genuinely continuous.
 */

export interface FrontierBudget {
  /** Frontier nodes to mine this cycle. */
  maxSeedsPerCycle?: number;
  /** Discovered affiliates to scan for the merchants they ALSO promote. */
  maxAffiliatesToExpand?: number;
  /** New seeds to promote this cycle. */
  maxNewSeeds?: number;
  /** Hops from a seed competitor before we stop expanding. */
  maxDepth?: number;
  /** A merchant must be co-promoted by at least this many affiliates to be promoted. */
  minCoPromotions?: number;
}

export interface ExpansionReport {
  mined: string[];
  discovered: number;
  promoted: { domain: string; coPromotions: number; depth: number }[];
  frontierPending: number;
}

function normDomain(raw: string): string {
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^www\./, "");
  }
}

/** Run one bounded expansion step for a merchant. Idempotent + safe to call on a cadence. */
export async function expandFrontier(deps: RecruitmentDeps, merchantId: string, budget: FrontierBudget = {}): Promise<ExpansionReport> {
  const merchant: Merchant = await deps.db.merchants.require(merchantId);
  const b = {
    maxSeeds: budget.maxSeedsPerCycle ?? 2,
    maxExpand: budget.maxAffiliatesToExpand ?? 10,
    maxNew: budget.maxNewSeeds ?? 5,
    maxDepth: budget.maxDepth ?? 2,
    minCo: budget.minCoPromotions ?? 2,
  };
  const backlink = deps.discoverySources.find((s) => s.sourceType === "backlink_mining");
  const now = () => deps.clock.now().toISOString();

  // 1) Seed the frontier with the merchant's competitors (depth 0).
  const existing = await deps.db.frontierMerchants.find((f) => f.merchantId === merchantId);
  const known = new Set(existing.map((f) => f.domain.toLowerCase()));
  for (const comp of merchant.competitors.map(normDomain).filter(Boolean)) {
    if (known.has(comp)) continue;
    known.add(comp);
    await deps.db.frontierMerchants.insert({
      id: newId("front"), merchantId, domain: comp, label: comp, depth: 0, coPromotions: 0,
      status: "pending", source: "seed", discoveredFrom: null, createdAt: now(), processedAt: null,
    });
  }

  // 2) Pop the highest-priority pending nodes (shallowest, then most co-promoted).
  const pending = (await deps.db.frontierMerchants.find((f) => f.merchantId === merchantId && f.status === "pending"))
    .sort((x, y) => x.depth - y.depth || y.coPromotions - x.coPromotions)
    .slice(0, b.maxSeeds);

  // 3) Mine each → ingest affiliates.
  const mined: string[] = [];
  let discovered = 0;
  const newAffiliates: Prospect[] = [];
  for (const node of pending) {
    if (backlink) {
      const query: DiscoveryQuery = { merchantId, niche: merchant.niche ?? "general", competitors: [node.domain], keywords: [], channels: ["serp"], limit: 20 };
      let cands: RawCandidate[] = [];
      try {
        cands = await backlink.discover(query);
      } catch {
        cands = [];
      }
      for (const cand of cands) {
        const p = await ingestCandidate(deps, merchant, cand);
        if (p) {
          newAffiliates.push(p);
          discovered++;
        }
      }
    }
    await deps.db.frontierMerchants.update(node.id, { status: "mined", processedAt: now() });
    mined.push(node.domain);
  }

  // 4) Expand: scan affiliates' pages for the OTHER merchants they promote, and tally.
  const exclude = new Set<string>([...known, ...merchant.competitors.map(normDomain)].filter(Boolean));
  const tally = new Map<string, number>();
  for (const aff of newAffiliates.filter((p) => p.siteUrl).slice(0, b.maxExpand)) {
    let links: string[] = [];
    if (deps.fetcher) {
      try {
        const r = await deps.fetcher.get(aff.siteUrl!);
        if (r.status >= 200 && r.status < 300 && r.html) links = extractHrefs(r.html, aff.siteUrl);
      } catch {
        /* unreachable — fall back to what we already detected */
      }
    }
    if (links.length === 0) links = (aff.evidence?.affiliateLinks ?? []).map((l) => l.url);
    for (const host of competitorHostsFromLinks(links, exclude)) tally.set(host, (tally.get(host) ?? 0) + 1);
  }

  // 5) Promote the frequently co-promoted merchants into new (deeper) frontier nodes.
  const baseDepth = pending.length ? Math.min(...pending.map((n) => n.depth)) : 0;
  const promoted: ExpansionReport["promoted"] = [];
  const ranked = [...tally.entries()].filter(([, c]) => c >= b.minCo).sort((x, y) => y[1] - x[1]);
  for (const [domain, count] of ranked) {
    if (promoted.length >= b.maxNew) break;
    if (known.has(domain)) continue;
    const depth = baseDepth + 1;
    if (depth > b.maxDepth) continue; // depth cap — stop the recursion
    known.add(domain);
    await deps.db.frontierMerchants.insert({
      id: newId("front"), merchantId, domain, label: domain, depth, coPromotions: count,
      status: "pending", source: "expansion", discoveredFrom: mined[0] ?? null, createdAt: now(), processedAt: null,
    });
    promoted.push({ domain, coPromotions: count, depth });
  }

  const frontierPending = await deps.db.frontierMerchants.count((f) => f.merchantId === merchantId && f.status === "pending");
  return { mined, discovered, promoted, frontierPending };
}
