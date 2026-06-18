/**
 * Prospect scoring (Section 8.3). A composite fit + propensity score that ranks
 * prospects so the best are contacted first and with the most effort. Starts
 * heuristic; the weights are designed to evolve toward a learned model that
 * targets "will drive sales" rather than "will reply" as outcome labels
 * accumulate (closed-loop learning, Section 8.6). Pure and explainable: every
 * point of the score is attributable to a named factor for the explainability UX.
 */

export type Tier = "A" | "B" | "C";

export interface ScoringSignals {
  /** Topical match between prospect content and the merchant's product (0..1). */
  relevance: number;
  /** Already runs affiliate links anywhere — proven monetizer. */
  runsAffiliateLinks: boolean;
  /** Already promotes a DIRECT competitor — the strongest predictor. */
  promotesCompetitor: boolean;
  /** Audience size (raw count; log-normalized internally). */
  reach: number;
  /** Domain authority 0..100. */
  domainAuthority: number;
  /** Engagement rate 0..1 (weighted over raw follower count). */
  engagementRate: number;
  /** Produces reviews / comparisons / "best of" — high commercial intent (0..1). */
  commercialIntent: number;
  /** Verified email or a clear contact path. */
  contactable: boolean;
  /** Geo / language / demographic alignment with the merchant's customers (0..1). */
  audienceOverlap: number;
}

export interface ScoringWeights {
  relevance: number;
  affiliatePropensity: number; // heaviest weight per Section 8.3
  reach: number;
  quality: number; // domain authority + engagement
  commercialIntent: number;
  contactability: number;
  audienceOverlap: number;
}

/** Heuristic starting weights (sum ≈ 1). Affiliate-propensity is weighted heaviest. */
export const defaultWeights: ScoringWeights = {
  relevance: 0.2,
  affiliatePropensity: 0.3,
  reach: 0.1,
  quality: 0.15,
  commercialIntent: 0.1,
  contactability: 0.1,
  audienceOverlap: 0.05,
};

export interface ScoreContribution {
  factor: string;
  weight: number;
  normalized: number; // 0..1
  contribution: number; // points out of 100
  note: string;
}

export interface ScoreResult {
  score: number; // 0..100
  tier: Tier;
  breakdown: ScoreContribution[];
  /** Human-readable reasons for the explainability UX (Section 8.8). */
  explanation: string[];
}

export interface TierThresholds {
  a: number;
  b: number;
}

export const defaultTierThresholds: TierThresholds = { a: 70, b: 45 };

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Log-normalize an audience size to 0..1, saturating around 10M. */
function normalizeReach(reach: number): number {
  if (reach <= 0) return 0;
  return clamp01(Math.log10(reach) / 7); // 10^7 = 10M → 1.0
}

function affiliatePropensity(s: ScoringSignals): { value: number; note: string } {
  if (s.promotesCompetitor) return { value: 1, note: "promotes a direct competitor (strongest signal)" };
  if (s.runsAffiliateLinks) return { value: 0.6, note: "runs affiliate links (proven monetizer)" };
  return { value: 0.1, note: "no affiliate activity detected" };
}

export function scoreProspect(
  signals: ScoringSignals,
  weights: ScoringWeights = defaultWeights,
  thresholds: TierThresholds = defaultTierThresholds,
): ScoreResult {
  const propensity = affiliatePropensity(signals);
  const quality = clamp01((clamp01(signals.domainAuthority / 100) + clamp01(signals.engagementRate)) / 2);

  const factors: Array<{ factor: string; weight: number; normalized: number; note: string }> = [
    { factor: "relevance", weight: weights.relevance, normalized: clamp01(signals.relevance), note: "topical match (embedding similarity)" },
    { factor: "affiliatePropensity", weight: weights.affiliatePropensity, normalized: propensity.value, note: propensity.note },
    { factor: "reach", weight: weights.reach, normalized: normalizeReach(signals.reach), note: `audience ≈ ${signals.reach.toLocaleString()}` },
    { factor: "quality", weight: weights.quality, normalized: quality, note: `DA ${signals.domainAuthority}, engagement ${(signals.engagementRate * 100).toFixed(0)}%` },
    { factor: "commercialIntent", weight: weights.commercialIntent, normalized: clamp01(signals.commercialIntent), note: "produces reviews/comparisons/best-of" },
    { factor: "contactability", weight: weights.contactability, normalized: signals.contactable ? 1 : 0, note: signals.contactable ? "verified contact path" : "no verified contact" },
    { factor: "audienceOverlap", weight: weights.audienceOverlap, normalized: clamp01(signals.audienceOverlap), note: "geo/language/demographic alignment" },
  ];

  const weightSum = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const breakdown: ScoreContribution[] = factors.map((f) => {
    const contribution = (f.weight / weightSum) * f.normalized * 100;
    return { factor: f.factor, weight: f.weight, normalized: f.normalized, contribution, note: f.note };
  });

  let score = Math.round(breakdown.reduce((s, b) => s + b.contribution, 0));

  // Contactability gate: an un-contactable prospect cannot be reached, so it can
  // never be A-tier regardless of fit.
  let tier: Tier = score >= thresholds.a ? "A" : score >= thresholds.b ? "B" : "C";
  if (!signals.contactable && tier === "A") tier = "B";

  const explanation = breakdown
    .filter((b) => b.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .map((b) => `${b.factor}: ${b.note} (+${b.contribution.toFixed(1)})`);

  return { score, tier, breakdown, explanation };
}

/**
 * Closed-loop learning hook (Section 8.6). As outcome labels accumulate
 * (recruited → produced sales → how much), blend the heuristic weights toward
 * learned weights. `alpha` is the learned model's confidence (0 = pure heuristic,
 * 1 = fully learned). This is the mechanism by which the engine improves the more
 * it runs — the direct expression of the data moat.
 */
export function blendWeights(heuristic: ScoringWeights, learned: Partial<ScoringWeights>, alpha: number): ScoringWeights {
  const a = clamp01(alpha);
  const blend = (h: number, l: number | undefined) => (l == null ? h : h * (1 - a) + l * a);
  return {
    relevance: blend(heuristic.relevance, learned.relevance),
    affiliatePropensity: blend(heuristic.affiliatePropensity, learned.affiliatePropensity),
    reach: blend(heuristic.reach, learned.reach),
    quality: blend(heuristic.quality, learned.quality),
    commercialIntent: blend(heuristic.commercialIntent, learned.commercialIntent),
    contactability: blend(heuristic.contactability, learned.contactability),
    audienceOverlap: blend(heuristic.audienceOverlap, learned.audienceOverlap),
  };
}
