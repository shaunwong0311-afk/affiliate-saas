import { blendWeights, defaultWeights, type ScoringWeights } from "@affiliate/core";
import type { RecruitmentDeps } from "./deps.js";
import { planDiscovery } from "./discovery-planner.js";

/**
 * Closed-loop learning (Section 8.6) — now actually wired. As producing-affiliate
 * outcomes accumulate in the append-only ProspectOutcome store, scoring shifts
 * from heuristic toward what actually drove sales, and low-yield sources are
 * pruned. This is the data moat expressed in code.
 */

/** Per-merchant scoring weights, blended toward "what produced" as labels accrue. */
export async function weightsForMerchant(deps: RecruitmentDeps, merchantId: string): Promise<ScoringWeights> {
  const outcomes = await deps.db.prospectOutcomes.find((o) => o.merchantId === merchantId);
  if (outcomes.length < 5) return defaultWeights; // not enough signal yet
  const produced = outcomes.filter((o) => o.label === "produced_sales").length;
  const alpha = Math.min(0.8, produced / outcomes.length);
  // A learned model emphasizes the factors research says predict production:
  // affiliate-propensity (already monetizing) and commercial intent.
  return blendWeights(defaultWeights, { affiliatePropensity: 0.4, commercialIntent: 0.2 }, alpha);
}

/** States a prospect can only be in after outreach has actually gone out to it. */
const CONTACTED_STATES = new Set(["contacted", "in_sequence", "replied", "converted"]);

/**
 * How long after the FIRST send a prospect has had a fair chance to become a producing
 * affiliate: a three-step sequence, a reply, signup, and a first sale take weeks. Until
 * then "has not produced" says nothing about the source that found them.
 */
export const SOURCE_MATURITY_DAYS = 30;

export interface SourceYield {
  sourceType: string;
  sourced: number;
  contacted: number;
  producing: number;
  producedRevenueCents: number;
  /** producing / sourced — the headline number shown to the operator. */
  yield: number;
  /**
   * The cohort a KEEP-OR-PRUNE decision may be based on: prospects that were actually
   * contacted at least {@link SOURCE_MATURITY_DAYS} ago (plus any that already produced —
   * a quick win is evidence the moment it happens).
   */
  matureContacted: number;
  /** How many of that cohort produced sales. */
  matureProducing: number;
}

/**
 * Per-source yield from outcomes + prospects (Section 8.6). Sources whose MATURE yield
 * falls below a floor (after enough mature volume) are pruned/deprioritized.
 */
export async function sourceYield(deps: RecruitmentDeps, merchantId: string, opts?: { maturityDays?: number }): Promise<SourceYield[]> {
  const prospects = await deps.db.prospects.find((p) => p.merchantId === merchantId);
  const outcomes = await deps.db.prospectOutcomes.find((o) => o.merchantId === merchantId);
  const maturityMs = (opts?.maturityDays ?? SOURCE_MATURITY_DAYS) * 86_400_000;
  const nowMs = deps.clock.now().getTime();

  const map = new Map<string, SourceYield>();
  const ensure = (sourceType: string): SourceYield => {
    let y = map.get(sourceType);
    if (!y) {
      y = { sourceType, sourced: 0, contacted: 0, producing: 0, producedRevenueCents: 0, yield: 0, matureContacted: 0, matureProducing: 0 };
      map.set(sourceType, y);
    }
    return y;
  };

  // When each prospect was FIRST actually sent to (the clock maturity runs on).
  const contactedIds = new Set(prospects.filter((p) => CONTACTED_STATES.has(p.state)).map((p) => p.id));
  const firstSentAt = new Map<string, number>();
  if (contactedIds.size) {
    for (const m of await deps.db.outreachMessages.find((x) => contactedIds.has(x.prospectId) && !!x.sentAt && (x.status === "sent" || x.status === "replied"))) {
      const t = new Date(m.sentAt!).getTime();
      if (Number.isNaN(t)) continue;
      const prev = firstSentAt.get(m.prospectId);
      if (prev == null || t < prev) firstSentAt.set(m.prospectId, t);
    }
  }
  const producers = new Set(outcomes.filter((o) => o.label === "produced_sales").map((o) => o.prospectId));

  for (const p of prospects) {
    const y = ensure(p.source);
    y.sourced += 1;
    if (!CONTACTED_STATES.has(p.state)) continue;
    y.contacted += 1;
    // No send on record (converted by hand, or history predating message rows): fall back
    // to the last time the prospect row changed — the best lower bound we have.
    const since = firstSentAt.get(p.id) ?? new Date(p.updatedAt).getTime();
    const produced = producers.has(p.id);
    if (produced || (Number.isFinite(since) && nowMs - since >= maturityMs)) {
      y.matureContacted += 1;
      if (produced) y.matureProducing += 1;
    }
  }
  for (const o of outcomes) {
    const y = ensure(o.sourceType);
    if (o.label === "produced_sales") {
      y.producing += 1;
      y.producedRevenueCents += o.producedRevenueCents;
    }
  }
  for (const y of map.values()) y.yield = y.sourced ? y.producing / y.sourced : 0;
  return [...map.values()].sort((a, b) => b.yield - a.yield);
}

/**
 * Which source types to prune — below the yield floor after enough MATURE volume. The
 * autonomous cycle reads this to stop spending on sources that don't produce.
 *
 * Two safeguards, because a wrong prune silently ends sourcing:
 *  - MATURITY. Only prospects that were actually contacted, long enough ago to have had
 *    a chance to produce, are evidence. Judging a source on everything it ever found
 *    pruned every source the cycle after it first worked: 20 prospects, none producing
 *    — because none had even been emailed yet.
 *  - NEVER THE LAST ONE. If pruning would leave the merchant with no runnable source,
 *    the best of the candidates is kept. A weak source still finds someone; no source
 *    finds no one, for ever, and can never earn its way back.
 */
export async function lowYieldSources(
  deps: RecruitmentDeps,
  merchantId: string,
  opts?: { minVolume?: number; floor?: number; maturityDays?: number },
): Promise<Set<string>> {
  const minVolume = opts?.minVolume ?? 20;
  const floor = opts?.floor ?? 0.02;
  const yields = await sourceYield(deps, merchantId, { maturityDays: opts?.maturityDays });
  const matureYield = (y: SourceYield) => (y.matureContacted ? y.matureProducing / y.matureContacted : 0);

  const prune = new Set<string>();
  for (const y of yields) {
    if (y.matureContacted >= minVolume && matureYield(y) < floor) prune.add(y.sourceType);
  }
  if (prune.size === 0) return prune;

  // What can actually run for this merchant (registered, and not ruled out by the planner
  // for reasons of its own — e.g. competitor mining with no competitors set).
  const runnable = (await planDiscovery(deps, merchantId)).steps.map((s) => s.sourceType);
  if (runnable.length > 0 && runnable.every((s) => prune.has(s))) {
    const byType = new Map(yields.map((y) => [y.sourceType, y]));
    const keep = [...runnable].sort((a, b) => {
      const ya = byType.get(a);
      const yb = byType.get(b);
      return (yb ? matureYield(yb) : 0) - (ya ? matureYield(ya) : 0) || (yb?.matureProducing ?? 0) - (ya?.matureProducing ?? 0) || (yb?.sourced ?? 0) - (ya?.sourced ?? 0);
    })[0]!;
    prune.delete(keep);
  }
  return prune;
}
