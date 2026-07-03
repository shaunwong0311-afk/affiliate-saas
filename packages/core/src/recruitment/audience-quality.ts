/**
 * Audience-quality heuristic (a "quality affiliates" differentiator). A bought or bot-inflated
 * audience shows a tell-tale shape: large reach with engagement far below the platform norm.
 * We already collect BOTH inputs (real reach + engagement rate), so a purely derived flag costs
 * nothing extra and stays honest — it's computed from measured data, never fabricated, and is
 * NULL whenever either input is unknown (no provider wired). A full third-party credibility API
 * (HypeAuditor/Modash) is enterprise noise for this product; this heuristic is the cheap 80%.
 */

export interface AudienceQuality {
  suspicious: boolean;
  /** 0..1 — how far below the healthy floor the engagement sits (0 = at/above floor). */
  severity: number;
  reason: string;
}

/** Below this engagement rate, a sizable audience looks inorganic (generic cross-platform floor). */
const ENGAGEMENT_FLOOR = 0.01; // 1%
/** Small audiences swing wildly, so the flag only applies once reach is meaningful. */
const MIN_REACH_TO_FLAG = 25_000;

/** Content is considered stale (a likely-abandoned property) past this many days of silence. */
export const STALE_AFTER_DAYS = 365;

/**
 * Activity recency 0..1 from the most recent content date: ~1.0 for the last ~30 days, decaying
 * to ~0 by ~12 months. NULL when the date is unknown (no provider exposed it) — unknown recency
 * must never penalize a prospect (honesty discipline). A future date clamps to 1.
 */
export function activityRecency(lastContentAt: string | null | undefined, now: Date): number | null {
  if (!lastContentAt) return null;
  const then = new Date(lastContentAt).getTime();
  if (Number.isNaN(then)) return null;
  const days = (now.getTime() - then) / 86_400_000;
  if (days <= 30) return 1;
  if (days >= STALE_AFTER_DAYS) return Math.max(0, 1 - days / STALE_AFTER_DAYS) * 0.1; // ~0 past a year, keeps ordering
  // Linear decay from 1.0 at 30 days to ~0.1 at 365 days.
  return Math.max(0, 1 - (days - 30) / (STALE_AFTER_DAYS - 30));
}

/** True when a property has been silent long enough to likely be abandoned (null date = not stale). */
export function isStale(lastContentAt: string | null | undefined, now: Date): boolean {
  if (!lastContentAt) return false;
  const then = new Date(lastContentAt).getTime();
  if (Number.isNaN(then)) return false;
  return (now.getTime() - then) / 86_400_000 > STALE_AFTER_DAYS;
}

/**
 * Flag a likely low-quality/inflated audience from reach + engagement. Returns null when either
 * input is unknown (honesty discipline — unknown is never a fabricated "clean" verdict either).
 */
export function audienceQualityFlag(reach: number | null | undefined, engagementRate: number | null | undefined): AudienceQuality | null {
  if (reach == null || engagementRate == null) return null;
  if (reach < MIN_REACH_TO_FLAG) return { suspicious: false, severity: 0, reason: `audience too small (${reach.toLocaleString()}) to assess credibility` };
  if (engagementRate >= ENGAGEMENT_FLOOR) return { suspicious: false, severity: 0, reason: `healthy engagement (${(engagementRate * 100).toFixed(1)}%) for a ${reach.toLocaleString()} audience` };
  const severity = Math.max(0, Math.min(1, (ENGAGEMENT_FLOOR - engagementRate) / ENGAGEMENT_FLOOR));
  return {
    suspicious: true,
    severity,
    reason: `${(engagementRate * 100).toFixed(2)}% engagement on a ${reach.toLocaleString()} audience is well below the ~1% floor — possible bought/inactive followers`,
  };
}
