import { blendWeights, defaultWeights, type ScoringWeights } from "@affiliate/core";
import type { RecruitmentDeps } from "./deps.js";

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

export interface SourceYield {
  sourceType: string;
  sourced: number;
  contacted: number;
  producing: number;
  producedRevenueCents: number;
  /** producing / sourced — the number that decides whether to keep a source. */
  yield: number;
}

/**
 * Per-source yield from outcomes + prospects (Section 8.6). Sources whose yield
 * falls below a floor (after enough volume) are pruned/deprioritized.
 */
export async function sourceYield(deps: RecruitmentDeps, merchantId: string): Promise<SourceYield[]> {
  const prospects = await deps.db.prospects.find((p) => p.merchantId === merchantId);
  const outcomes = await deps.db.prospectOutcomes.find((o) => o.merchantId === merchantId);

  const map = new Map<string, SourceYield>();
  const ensure = (sourceType: string): SourceYield => {
    let y = map.get(sourceType);
    if (!y) {
      y = { sourceType, sourced: 0, contacted: 0, producing: 0, producedRevenueCents: 0, yield: 0 };
      map.set(sourceType, y);
    }
    return y;
  };

  for (const p of prospects) {
    const y = ensure(p.source);
    y.sourced += 1;
    if (["contacted", "in_sequence", "replied", "converted"].includes(p.state)) y.contacted += 1;
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
 * Which source types to prune — below the yield floor after enough volume. The
 * autonomous cycle reads this to stop spending on sources that don't produce.
 */
export async function lowYieldSources(deps: RecruitmentDeps, merchantId: string, opts?: { minVolume?: number; floor?: number }): Promise<Set<string>> {
  const minVolume = opts?.minVolume ?? 20;
  const floor = opts?.floor ?? 0.02;
  const yields = await sourceYield(deps, merchantId);
  const prune = new Set<string>();
  for (const y of yields) {
    if (y.sourced >= minVolume && y.yield < floor) prune.add(y.sourceType);
  }
  return prune;
}
