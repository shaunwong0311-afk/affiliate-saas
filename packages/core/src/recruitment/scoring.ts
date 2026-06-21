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
  /** Produces reviews / comparisons / "best of" — high commercial intent (0..1). */
  commercialIntent: number;
  /** Verified email or a clear contact path. */
  contactable: boolean;
  // ---- Signals that REQUIRE a real data provider. `null` = unknown (a provider
  // isn't wired). Unknown signals are EXCLUDED from the score and lower confidence
  // — they are never invented. ----------------------------------------------
  /** Audience size (raw count; log-normalized internally). null if unknown. */
  reach: number | null;
  /** Domain authority 0..100. null if no SEO provider (Ahrefs/Similarweb) is wired. */
  domainAuthority: number | null;
  /** Engagement rate 0..1. null if no creator-analytics provider is wired. */
  engagementRate: number | null;
  /** Geo / language / demographic alignment 0..1. null if no audience data. */
  audienceOverlap: number | null;
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
  score: number; // 0..100, computed over the KNOWN signals only
  tier: Tier;
  breakdown: ScoreContribution[];
  /** Human-readable reasons for the explainability UX (Section 8.8). */
  explanation: string[];
  /**
   * 0..1 — share of the scoring weight backed by REAL signals (not unknown). Low
   * confidence means most signals are missing (no SEO/audience data wired), so the
   * tier is provisional. The UI should surface this, not just the tier.
   */
  confidence: number;
  /** Factors that could not be scored because their data provider isn't wired. */
  unknownFactors: string[];
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

  // `normalized: null` means the signal is UNKNOWN (no provider). Unknown factors
  // are dropped from the weighted sum and the weights renormalized over what's
  // known — the score is never inflated by invented data.
  const da = signals.domainAuthority;
  const eng = signals.engagementRate;
  const quality =
    da == null && eng == null
      ? null
      : clamp01(((da != null ? clamp01(da / 100) : 0) + (eng != null ? clamp01(eng) : 0)) / ((da != null ? 1 : 0) + (eng != null ? 1 : 0)));

  const factors: Array<{ factor: string; weight: number; normalized: number | null; note: string }> = [
    { factor: "relevance", weight: weights.relevance, normalized: clamp01(signals.relevance), note: "topical match (embedding similarity)" },
    { factor: "affiliatePropensity", weight: weights.affiliatePropensity, normalized: propensity.value, note: propensity.note },
    { factor: "reach", weight: weights.reach, normalized: signals.reach == null ? null : normalizeReach(signals.reach), note: signals.reach == null ? "reach unknown (no provider)" : `audience ≈ ${signals.reach.toLocaleString()}` },
    { factor: "quality", weight: weights.quality, normalized: quality, note: quality == null ? "DA/engagement unknown (no provider)" : `DA ${da ?? "?"}, engagement ${eng != null ? (eng * 100).toFixed(0) + "%" : "?"}` },
    { factor: "commercialIntent", weight: weights.commercialIntent, normalized: clamp01(signals.commercialIntent), note: "produces reviews/comparisons/best-of" },
    { factor: "contactability", weight: weights.contactability, normalized: signals.contactable ? 1 : 0, note: signals.contactable ? "verified contact path" : "no verified contact" },
    { factor: "audienceOverlap", weight: weights.audienceOverlap, normalized: signals.audienceOverlap == null ? null : clamp01(signals.audienceOverlap), note: signals.audienceOverlap == null ? "audience overlap unknown (no provider)" : "geo/language/demographic alignment" },
  ];

  const known = factors.filter((f) => f.normalized != null);
  const knownWeight = known.reduce((s, f) => s + f.weight, 0) || 1;
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0) || 1;

  const breakdown: ScoreContribution[] = factors.map((f) => {
    const contribution = f.normalized == null ? 0 : (f.weight / knownWeight) * f.normalized * 100;
    return { factor: f.factor, weight: f.weight, normalized: f.normalized ?? 0, contribution, note: f.note };
  });

  const score = Math.round(breakdown.reduce((s, b) => s + b.contribution, 0));
  const confidence = knownWeight / totalWeight;

  // Contactability gate: an un-contactable prospect cannot be reached, so it can
  // never be A-tier regardless of fit.
  let tier: Tier = score >= thresholds.a ? "A" : score >= thresholds.b ? "B" : "C";
  if (!signals.contactable && tier === "A") tier = "B";

  const unknownFactors = factors.filter((f) => f.normalized == null).map((f) => f.factor);
  const explanation = breakdown
    .filter((b) => b.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .map((b) => `${b.factor}: ${b.note} (+${b.contribution.toFixed(1)})`);
  if (unknownFactors.length) explanation.push(`unknown (no data provider): ${unknownFactors.join(", ")}`);

  return { score, tier, breakdown, explanation, confidence, unknownFactors };
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
