import type { Id } from "../types/common.js";
import type { Click, Conversion, Order } from "../types/orders.js";
import type { AffiliateRelationship } from "../types/identity.js";

/**
 * Fraud + anti-abuse (Section 4). A bundle of cheap, explainable heuristics that
 * produce a risk score and reasons; high risk routes a conversion to the
 * human-review queue rather than auto-approving. This is intentionally rule-based
 * and transparent — money-path code you can reason about beats a black box.
 */

export interface FraudSignals {
  /** Clicks from the same IP in the velocity window. */
  ipClickCountInWindow: number;
  /** True if the click IP is a known datacenter / VPN range. */
  ipIsDatacenter: boolean;
  /** Seconds between the attributed click and the conversion. */
  clickToConversionSeconds: number | null;
  /** The affiliate's rolling reversal rate (0..1). */
  affiliateReversalRate: number;
  /** True if the converting customer is the affiliate themselves (self-referral). */
  isSelfReferral: boolean;
  /** True if attribution would create a sponsorship cycle. */
  isCircularSponsorship: boolean;
  /** Conversion amount in cents (for high-value manual-review thresholds). */
  amountCents: number;
  /** Per-offer manual-review threshold, if configured. */
  manualReviewOverCents: number | null;
}

export interface FraudAssessment {
  score: number; // 0..100, higher = riskier
  decision: "approve" | "review" | "reject";
  reasons: string[];
}

export interface FraudThresholds {
  ipVelocityLimit: number; // clicks/IP/window before flagging
  minClickToConversionSeconds: number; // faster than this is suspicious
  maxReversalRate: number; // above this, flag the affiliate
  reviewScore: number; // score ≥ this → review
  rejectScore: number; // score ≥ this → reject outright
}

export const defaultThresholds: FraudThresholds = {
  ipVelocityLimit: 20,
  minClickToConversionSeconds: 3,
  maxReversalRate: 0.3,
  reviewScore: 40,
  rejectScore: 80,
};

export function assessFraud(
  signals: FraudSignals,
  thresholds: FraudThresholds = defaultThresholds,
): FraudAssessment {
  const reasons: string[] = [];
  let score = 0;

  // Hard rejects — structural abuse.
  if (signals.isSelfReferral) {
    reasons.push("self-referral: customer is the attributed affiliate");
    score += 100;
  }
  if (signals.isCircularSponsorship) {
    reasons.push("circular sponsorship detected");
    score += 100;
  }

  // Velocity & infrastructure signals.
  if (signals.ipClickCountInWindow > thresholds.ipVelocityLimit) {
    reasons.push(`ip velocity ${signals.ipClickCountInWindow} > ${thresholds.ipVelocityLimit}`);
    score += 30;
  }
  if (signals.ipIsDatacenter) {
    reasons.push("click from datacenter/VPN IP");
    score += 20;
  }

  // Timing: implausibly fast click→conversion suggests forged or cookie-stuffed.
  if (
    signals.clickToConversionSeconds != null &&
    signals.clickToConversionSeconds >= 0 &&
    signals.clickToConversionSeconds < thresholds.minClickToConversionSeconds
  ) {
    reasons.push(`click→conversion ${signals.clickToConversionSeconds}s is implausibly fast`);
    score += 25;
  }

  // Affiliate-level reversal rate.
  if (signals.affiliateReversalRate > thresholds.maxReversalRate) {
    reasons.push(
      `affiliate reversal rate ${(signals.affiliateReversalRate * 100).toFixed(0)}% > ${(
        thresholds.maxReversalRate * 100
      ).toFixed(0)}%`,
    );
    score += 20;
  }

  // High-value manual review threshold.
  if (signals.manualReviewOverCents != null && signals.amountCents >= signals.manualReviewOverCents) {
    reasons.push(`high-value conversion ≥ ${signals.manualReviewOverCents} cents`);
    score = Math.max(score, thresholds.reviewScore);
  }

  score = Math.min(100, score);

  let decision: FraudAssessment["decision"] = "approve";
  if (score >= thresholds.rejectScore) decision = "reject";
  else if (score >= thresholds.reviewScore) decision = "review";

  return { score, decision, reasons };
}

/**
 * Detect whether crediting `affiliateId` whose sponsor chain is `sponsorOf` would
 * create a cycle (A sponsors B sponsors A). Pure graph walk with a visited set.
 */
export function hasSponsorCycle(
  affiliateId: Id,
  sponsorOf: (id: Id) => Id | null,
  maxDepth = 64,
): boolean {
  const seen = new Set<Id>();
  let current: Id | null = affiliateId;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = sponsorOf(current);
    depth += 1;
  }
  return false;
}

export function isSelfReferral(order: Order, relationship: AffiliateRelationship, affiliateEmailHash: string | null): boolean {
  // A real implementation matches hashed customer email / payment fingerprint to
  // the affiliate. Here we expose the comparison the substrate feeds in.
  void order;
  void relationship;
  return affiliateEmailHash != null && affiliateEmailHash === (order.customerId ?? null);
}

/** Count clicks sharing an IP within a window (helper for velocity signal). */
export function ipClickVelocity(clicks: readonly Click[], ip: string, windowMs: number, now: Date): number {
  const cutoff = now.getTime() - windowMs;
  return clicks.filter((c) => c.ip === ip && new Date(c.ts).getTime() >= cutoff).length;
}

/** Rolling reversal rate for an affiliate from their conversions. */
export function reversalRate(conversions: readonly Conversion[]): number {
  if (conversions.length === 0) return 0;
  const reversed = conversions.filter((c) => c.status === "reversed").length;
  return reversed / conversions.length;
}
