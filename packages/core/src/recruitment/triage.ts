/**
 * Prospect triage (Section 8.3) — a CHEAP pre-score computed from signals we already
 * have at discovery time (before any paid enrichment): is it a proven affiliate, does
 * it promote a competitor, its free domain authority, commercial intent, and whether
 * any contact path exists. Discovery can surface thousands of prospects per merchant;
 * enrichment (fetches + API calls) is the expensive stage, so we rank by this pre-score
 * and spend enrichment effort PROPORTIONALLY — deep on the hot band, shallow on cold —
 * rather than treating every prospect identically. Pure + explainable.
 *
 * This is deliberately distinct from {@link scoreProspect}: the full score runs AFTER
 * enrichment over the complete (provider-backed) signal set. The pre-score is the
 * triage that decides who EARNS that enrichment first.
 */

export type TriageBand = "hot" | "warm" | "cold";

export interface PreScoreSignals {
  /** Has a HIGH-confidence (named-network) affiliate link — a proven monetizer. */
  runsAffiliateLinks: boolean;
  /** Promotes a direct competitor (confirmed) — the strongest predictor. */
  promotesCompetitor: boolean;
  /** Free domain authority 0..100 (e.g. backlink mining's referring-domain rank). null = unknown. */
  domainAuthority: number | null;
  /** Commercial intent 0..1 from the evidence summary (reviews/best-of/comparisons). */
  commercialIntent: number;
  /** Any reachable contact path already known (email / contact page / form / channel / site). */
  hasContactPath: boolean;
}

export interface PreScoreResult {
  /** 0..1 triage score — higher = enrich first, enrich deeper. */
  preScore: number;
  band: TriageBand;
  /**
   * Recommended max billable (paid) enrichment lookups for this prospect — the real
   * cost lever. NOTE: contact-finding fetches (homepage, Linktree) are NOT tiered down:
   * they're cheap (cached/rate-limited) and are what make a prospect contactable in the
   * first place, so cutting them would defeat discovery. Only the PAID audience-enricher
   * calls scale with the band.
   */
  enrichDepth: number;
  /** Short human reasons, best first (explainability). */
  reasons: string[];
}

export interface TriageThresholds {
  hot: number;
  warm: number;
}

export const defaultTriageThresholds: TriageThresholds = { hot: 0.55, warm: 0.3 };

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Pre-score weights (sum = 1). Competitor promotion dominates — it's the warmest signal
// and the one most predictive of "will drive sales", same ordering as full scoring.
const W = {
  promotesCompetitor: 0.4,
  runsAffiliateLinks: 0.25,
  domainAuthority: 0.15,
  commercialIntent: 0.1,
  contactPath: 0.1,
};

/** Cheap pre-enrichment triage score from discovery-time signals only. */
export function preScoreProspect(s: PreScoreSignals, thresholds: TriageThresholds = defaultTriageThresholds): PreScoreResult {
  const da = s.domainAuthority != null ? clamp01(s.domainAuthority / 100) : 0;
  const intent = clamp01(s.commercialIntent);

  const parts: Array<{ v: number; w: number; reason: string }> = [
    { v: s.promotesCompetitor ? 1 : 0, w: W.promotesCompetitor, reason: "promotes a direct competitor" },
    { v: s.runsAffiliateLinks ? 1 : 0, w: W.runsAffiliateLinks, reason: "runs affiliate links (proven monetizer)" },
    { v: da, w: W.domainAuthority, reason: s.domainAuthority != null ? `domain authority ${s.domainAuthority}` : "" },
    { v: intent, w: W.commercialIntent, reason: intent > 0.5 ? "high commercial intent" : "" },
    { v: s.hasContactPath ? 1 : 0, w: W.contactPath, reason: "has a contact path" },
  ];

  const preScore = clamp01(parts.reduce((sum, p) => sum + p.v * p.w, 0));
  const band: TriageBand = preScore >= thresholds.hot ? "hot" : preScore >= thresholds.warm ? "warm" : "cold";
  const enrichDepth = band === "hot" ? 5 : band === "warm" ? 3 : 1;
  const reasons = parts
    .filter((p) => p.v > 0 && p.reason)
    .sort((a, b) => b.v * b.w - a.v * a.w)
    .map((p) => p.reason);

  return { preScore, band, enrichDepth, reasons };
}
