import { newId, competitorHostsFromLinks } from "@affiliate/core";
import type { FrontierMerchant, Merchant, Prospect } from "@affiliate/db";
import { extractHrefs, type DiscoveryQuery, type RawCandidate } from "@affiliate/integrations";
import type { RecruitmentDeps } from "./deps.js";
import { ingestExclusionsFor } from "./guards.js";
import { ingestCandidate, buildIdentityIndex } from "./pipeline.js";

/**
 * Recursive discovery — the merchant-expansion frontier engine (Section 8.1). The
 * snowball: backlink-mine a competitor → ingest its affiliates → read THOSE
 * affiliates' other affiliate links → the merchants they ALSO promote are de-facto
 * competitors → promote the frequently co-promoted ones into the frontier → mine
 * them next cycle. From a few seed competitors it maps the whole niche's affiliate
 * ecosystem. Every step is HARD-CAPPED (seeds, expansions, new seeds, depth, a
 * co-promotion threshold) so it can't run away; the frontier persists across cycles,
 * so it's genuinely continuous.
 *
 * WHAT COUNTS AS "ALSO PROMOTES" is deliberately narrow, because each promoted host
 * becomes a seed that real backlink budget is spent on: only a host the affiliate-
 * network registry identifies as a merchant (a vanity tracking domain, the destination
 * of a shared-network link, a network-specific self-hosted marker). A link that merely
 * carries `?ref=`, `?via=` or sits under `/go/` promotes nothing — twitter.com and
 * bluehost.com both match those shapes. See `competitorHostsFromLinks`.
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
  // One identity-key index for the whole expansion so per-candidate ingest is O(1), not O(N);
  // and the domains to keep away from (competitors' own + the merchant's own), read once.
  const identityIndex = await buildIdentityIndex(deps, merchantId);
  const exclusions = await ingestExclusionsFor(deps, merchant);

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

  // 3) Mine each → ingest affiliates, kept PER NODE so the expansion step can
  //    attribute each co-promotion to the node whose affiliates produced it.
  const mined: string[] = [];
  let discovered = 0;
  const minedNodes: { node: FrontierMerchant; affiliates: Prospect[] }[] = [];
  for (const node of pending) {
    const affiliates: Prospect[] = [];
    if (backlink) {
      const query: DiscoveryQuery = { merchantId, niche: merchant.niche ?? "general", competitors: [node.domain], keywords: [], channels: ["serp"], limit: 20 };
      let cands: RawCandidate[] = [];
      try {
        cands = await backlink.discover(query);
      } catch {
        cands = [];
      }
      for (const cand of cands) {
        const p = await ingestCandidate(deps, merchant, cand, { identityIndex, exclusions });
        if (p) {
          affiliates.push(p);
          discovered++;
        }
      }
    }
    await deps.db.frontierMerchants.update(node.id, { status: "mined", processedAt: now() });
    mined.push(node.domain);
    minedNodes.push({ node, affiliates });
  }

  // 4) Expand: scan each node's affiliates for the OTHER merchants they promote. The
  //    tally is per node — a co-promoted host inherits depth from the node whose
  //    affiliates surfaced it (the MINIMUM across nodes when several promote the same
  //    host, keeping that node as discoveredFrom) — so maxDepth bounds REAL hops and
  //    the Niche Map edge points at the true parent, even on a mixed-depth batch.
  // Never a new seed: what is already on the frontier, the declared competitors, and the
  // merchant's OWN domains (an affiliate who also promotes the merchant is not pointing at a rival).
  const exclude = new Set<string>([...known, ...merchant.competitors.map(normDomain), ...exclusions.merchantDomains].filter(Boolean));
  const tally = new Map<string, { count: number; depth: number; discoveredFrom: string }>();
  let expanded = 0;
  for (const { node, affiliates } of minedNodes) {
    if (expanded >= b.maxExpand) break;
    for (const aff of affiliates.filter((p) => p.siteUrl)) {
      if (expanded >= b.maxExpand) break;
      expanded++;
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
      for (const host of competitorHostsFromLinks(links, exclude)) {
        const entry = tally.get(host) ?? { count: 0, depth: node.depth + 1, discoveredFrom: node.domain };
        entry.count += 1;
        if (node.depth + 1 < entry.depth) {
          entry.depth = node.depth + 1;
          entry.discoveredFrom = node.domain;
        }
        tally.set(host, entry);
      }
    }
  }

  // 5) Promote the frequently co-promoted merchants into new (deeper) frontier nodes.
  const promoted: ExpansionReport["promoted"] = [];
  const ranked = [...tally.entries()].filter(([, e]) => e.count >= b.minCo).sort((x, y) => y[1].count - x[1].count);
  for (const [domain, entry] of ranked) {
    if (promoted.length >= b.maxNew) break;
    if (known.has(domain)) continue;
    if (entry.depth > b.maxDepth) continue; // depth cap — bounds real hops from the seed
    known.add(domain);
    await deps.db.frontierMerchants.insert({
      id: newId("front"), merchantId, domain, label: domain, depth: entry.depth, coPromotions: entry.count,
      status: "pending", source: "expansion", discoveredFrom: entry.discoveredFrom, createdAt: now(), processedAt: null,
    });
    promoted.push({ domain, coPromotions: entry.count, depth: entry.depth });
  }

  const frontierPending = await deps.db.frontierMerchants.count((f) => f.merchantId === merchantId && f.status === "pending");
  return { mined, discovered, promoted, frontierPending };
}
