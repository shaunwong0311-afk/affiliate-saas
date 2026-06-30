import type { RecruitmentDeps } from "./deps.js";

/**
 * Activation analytics (the highest-leverage recruitment metric per the research). Recruiting
 * is vanity unless recruits ACTIVATE — drive traffic/a sale. The leading indicators:
 *  - partners who drive their first visit within ~14 days are ~80% more likely to stay active;
 *  - no traffic within 30 days → only ~15% ever activate;
 *  - a "fast-start" incentive (first lead within ~7 days) sharply cuts time-to-first-referral.
 * We can compute all of it because each recruited AffiliateRelationship carries `prospectId`
 * + `joinedAt`, and clicks/conversions carry `affiliateId` + `ts`.
 */

const DAY = 86_400_000;
export const FAST_START_DAYS = 7;

export type ActivationStatus = "producing" | "activated" | "recruited";
export type FastStart = "earned" | "in_window" | "missed";

export interface RecruitActivation {
  affiliateId: string;
  relationshipId: string;
  prospectId: string | null;
  joinedAt: string;
  firstClickAt: string | null;
  firstSaleAt: string | null;
  daysToFirstClick: number | null;
  daysToFirstSale: number | null;
  /** producing = drove a sale · activated = drove a click · recruited = neither yet. */
  status: ActivationStatus;
  /** earned = first click within the fast-start window · in_window = still eligible · missed. */
  fastStart: FastStart;
}

export interface ActivationMetrics {
  recruited: number;
  activated: number;
  producing: number;
  activationRate: number;
  producingRate: number;
  fastStartEarned: number;
  /** Recruits still inside their fast-start window with no click yet — nudge with a bonus. */
  fastStartInWindow: number;
  medianDaysToFirstClick: number | null;
  medianDaysToFirstSale: number | null;
  recruits: RecruitActivation[];
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export async function activationMetrics(deps: RecruitmentDeps, merchantId: string): Promise<ActivationMetrics> {
  const nowMs = deps.clock.now().getTime();
  // Recruited = relationships traceable to a prospect (the recruitment funnel's output).
  const recruits = await deps.db.relationships.find((r) => r.merchantId === merchantId && r.prospectId != null);

  const out: RecruitActivation[] = [];
  for (const rel of recruits) {
    const clicks = await deps.db.clicks.find((c) => c.affiliateId === rel.affiliateId && c.merchantId === merchantId);
    const convs = await deps.db.conversions.find(
      (c) => c.affiliateId === rel.affiliateId && c.merchantId === merchantId && c.status !== "rejected" && c.status !== "reversed",
    );
    const firstClickAt = clicks.length ? clicks.map((c) => c.ts).sort()[0]! : null;
    const firstSaleAt = convs.length ? convs.map((c) => c.ts).sort()[0]! : null;
    const daysToFirstClick = firstClickAt ? daysBetween(rel.joinedAt, firstClickAt) : null;
    const daysToFirstSale = firstSaleAt ? daysBetween(rel.joinedAt, firstSaleAt) : null;
    const status: ActivationStatus = firstSaleAt ? "producing" : firstClickAt ? "activated" : "recruited";
    const ageDays = (nowMs - new Date(rel.joinedAt).getTime()) / DAY;
    const fastStart: FastStart =
      daysToFirstClick != null && daysToFirstClick <= FAST_START_DAYS ? "earned" : firstClickAt == null && ageDays <= FAST_START_DAYS ? "in_window" : "missed";
    out.push({ affiliateId: rel.affiliateId, relationshipId: rel.id, prospectId: rel.prospectId, joinedAt: rel.joinedAt, firstClickAt, firstSaleAt, daysToFirstClick, daysToFirstSale, status, fastStart });
  }

  const recruited = out.length;
  const activated = out.filter((r) => r.status !== "recruited").length;
  const producing = out.filter((r) => r.status === "producing").length;
  return {
    recruited,
    activated,
    producing,
    activationRate: recruited ? activated / recruited : 0,
    producingRate: recruited ? producing / recruited : 0,
    fastStartEarned: out.filter((r) => r.fastStart === "earned").length,
    fastStartInWindow: out.filter((r) => r.fastStart === "in_window").length,
    medianDaysToFirstClick: median(out.map((r) => r.daysToFirstClick).filter((x): x is number => x != null)),
    medianDaysToFirstSale: median(out.map((r) => r.daysToFirstSale).filter((x): x is number => x != null)),
    recruits: out,
  };
}
