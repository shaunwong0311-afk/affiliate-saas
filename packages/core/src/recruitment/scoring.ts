/**
 * Prospect scoring (Section 8.3). A composite fit + propensity score that ranks
 * prospects so the best are contacted first and with the most effort. Starts
 * heuristic; the weights are designed to evolve toward a learned model that
 * targets "will drive sales" rather than "will reply" as outcome labels
 * accumulate (closed-loop learning, Section 8.6). Pure and explainable: every
 * point of the score is attributable to a named factor for the explainability UX.
 */

import { audienceQualityFlag } from "./audience-quality.js";

export type Tier = "A" | "B" | "C";

export interface ScoringSignals {
  /**
   * Topical match between prospect content and the merchant's product (0..1). `null` =
   * unknown — the relevance scorer was unavailable (model/transport failure). Excluded
   * from the score like any other unknown; never scored as "irrelevant".
   */
  relevance: number | null;
  /** Already runs affiliate links anywhere — proven monetizer. */
  runsAffiliateLinks: boolean;
  /** Already promotes a DIRECT competitor — the strongest predictor. */
  promotesCompetitor: boolean;
  /** Produces reviews / comparisons / "best of" — high commercial intent (0..1). */
  commercialIntent: number;
  /** A contact path is on file (an email we can write to). */
  contactable: boolean;
  /**
   * Whether that contact was confirmed by a real deliverability check. `false` = on file
   * but unverified (merchant-imported, or a demo pattern-guess) — the score note says so
   * instead of claiming "verified". Omitted = verified (the pre-existing meaning).
   */
  contactVerified?: boolean;
  // ---- Signals that REQUIRE a real data provider. `null` = unknown (a provider
  // isn't wired). Unknown signals are EXCLUDED from the score and lower confidence
  // — they are never invented. ----------------------------------------------
  /** Audience size (raw count; log-normalized internally). null if unknown. */
  reach: number | null;
  /** Domain authority 0..100. null if no SEO provider (Ahrefs/Similarweb) is wired. */
  domainAuthority: number | null;
  /**
   * Engagement rate as a FRACTION (0.03 = 3%), normalized on {@link ENGAGEMENT_SCALE}.
   * null if no creator-analytics provider is wired.
   */
  engagementRate: number | null;
  /** Geo / language / demographic alignment 0..1. null if no audience data. */
  audienceOverlap: number | null;
  /**
   * Content freshness 0..1 from the most recent content date (see `activityRecency`).
   * null/omitted when no provider exposed a date — unknown never penalizes.
   */
  activityRecency?: number | null;
}

export interface ScoringWeights {
  relevance: number;
  affiliatePropensity: number; // heaviest weight per Section 8.3
  reach: number;
  quality: number; // domain authority + engagement
  commercialIntent: number;
  contactability: number;
  audienceOverlap: number;
  /** Content freshness — a dead property is worth less than an active one. */
  activity: number;
}

/**
 * Heuristic starting weights. They are RELATIVE: the score renormalizes over whichever
 * factors are known, so the sum need not be 1 (it is 1.05). Affiliate-propensity is
 * weighted heaviest.
 */
export const defaultWeights: ScoringWeights = {
  relevance: 0.2,
  affiliatePropensity: 0.3,
  reach: 0.1,
  quality: 0.15,
  commercialIntent: 0.1,
  contactability: 0.1,
  audienceOverlap: 0.05,
  activity: 0.05,
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
  /** "suspicious" when reach+engagement show a bought/inactive-audience shape; null when unknown. */
  audienceQuality: "suspicious" | "ok" | null;
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

/**
 * The engagement scale: `[rate, score]` anchors, linear in between. A rate is a FRACTION
 * of the audience (or of views) that engaged — 0.03 means 3%.
 *
 *     0%  → 0.00
 *     1%  → 0.50   the credibility floor (below it a large audience looks inorganic)
 *     3%  → 0.85   solid for a creator of any size
 *     5%+ → 1.00   strong — saturates
 *
 * Raw rates live in a narrow band near zero (a superb creator measures 0.06), so using
 * the rate itself as a 0..1 score made a MEASURED strong rate drag the score down while
 * "unknown" left it alone. On this scale a strong rate scores high and only a genuinely
 * weak one scores low.
 */
export const ENGAGEMENT_SCALE: ReadonlyArray<readonly [rate: number, score: number]> = [
  [0, 0],
  [0.01, 0.5],
  [0.03, 0.85],
  [0.05, 1],
];

/** Normalize an engagement rate (fraction) to 0..1 on {@link ENGAGEMENT_SCALE}. */
export function normalizeEngagementRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  for (let i = 1; i < ENGAGEMENT_SCALE.length; i++) {
    const [r0, s0] = ENGAGEMENT_SCALE[i - 1]!;
    const [r1, s1] = ENGAGEMENT_SCALE[i]!;
    if (rate <= r1) return s0 + ((rate - r0) / (r1 - r0)) * (s1 - s0);
  }
  return 1;
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
  // Quality = the mean of whichever of its two measurements are KNOWN, each on its own
  // 0..1 scale (DA/100; engagement on ENGAGEMENT_SCALE). Unknown halves are left out,
  // not averaged in as zero.
  const qualityParts: number[] = [];
  if (da != null) qualityParts.push(clamp01(da / 100));
  if (eng != null) qualityParts.push(normalizeEngagementRate(eng));
  const quality = qualityParts.length ? qualityParts.reduce((a, b) => a + b, 0) / qualityParts.length : null;

  // Audience-quality discount: a bought/inactive audience shouldn't earn full reach credit.
  // Derived from the reach + engagement we already measure; null (no adjustment) when unknown.
  const qualityFlag = audienceQualityFlag(signals.reach, signals.engagementRate);
  const reachDiscount = qualityFlag?.suspicious ? 1 - 0.6 * qualityFlag.severity : 1; // up to −60%
  const reachNormalized = signals.reach == null ? null : normalizeReach(signals.reach) * reachDiscount;

  const relevance = signals.relevance == null || !Number.isFinite(signals.relevance) ? null : clamp01(signals.relevance);
  const activity = signals.activityRecency == null || !Number.isFinite(signals.activityRecency) ? null : clamp01(signals.activityRecency);
  const contactNote = !signals.contactable
    ? "no verified contact"
    : signals.contactVerified === false
      ? "contact path on file — NOT verified"
      : "verified contact path";

  const factors: Array<{ factor: string; weight: number; normalized: number | null; note: string }> = [
    { factor: "relevance", weight: weights.relevance, normalized: relevance, note: relevance == null ? "relevance unknown (scorer unavailable)" : "topical match with the merchant's niche" },
    { factor: "affiliatePropensity", weight: weights.affiliatePropensity, normalized: propensity.value, note: propensity.note },
    { factor: "reach", weight: weights.reach, normalized: reachNormalized, note: signals.reach == null ? "reach unknown (no provider)" : qualityFlag?.suspicious ? `audience ≈ ${signals.reach.toLocaleString()} — DISCOUNTED (${qualityFlag.reason})` : `audience ≈ ${signals.reach.toLocaleString()}` },
    { factor: "quality", weight: weights.quality, normalized: quality, note: quality == null ? "DA/engagement unknown (no provider)" : `DA ${da ?? "?"}, engagement ${eng != null ? (eng * 100).toFixed(1) + "%" : "?"}` },
    { factor: "commercialIntent", weight: weights.commercialIntent, normalized: clamp01(signals.commercialIntent), note: "produces reviews/comparisons/best-of" },
    { factor: "contactability", weight: weights.contactability, normalized: signals.contactable ? 1 : 0, note: contactNote },
    { factor: "audienceOverlap", weight: weights.audienceOverlap, normalized: signals.audienceOverlap == null ? null : clamp01(signals.audienceOverlap), note: signals.audienceOverlap == null ? "audience overlap unknown (no provider)" : "geo/language/demographic alignment" },
    { factor: "activity", weight: weights.activity, normalized: activity, note: activity == null ? "content freshness unknown (no provider)" : activity >= 0.75 ? "recently active" : activity >= 0.2 ? "posting has slowed" : "likely dormant — little or no recent content" },
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
  if (qualityFlag?.suspicious) explanation.push(`⚠ audience credibility: ${qualityFlag.reason}`);

  const audienceQuality = qualityFlag == null ? null : qualityFlag.suspicious ? "suspicious" : "ok";
  return { score, tier, breakdown, explanation, confidence, unknownFactors, audienceQuality };
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
    activity: blend(heuristic.activity, learned.activity),
  };
}
