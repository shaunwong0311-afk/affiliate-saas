import { describe, it, expect } from "vitest";
import {
  scoreProspect,
  normalizeEngagementRate,
  ENGAGEMENT_SCALE,
  defaultWeights,
  blendWeights,
  preScoreProspect,
  type ScoringSignals,
} from "../src/index.js";

/** AUDIT-2026-10 D8 / D15 / D1 — scoring regressions. */

const base: ScoringSignals = {
  relevance: 0.8,
  runsAffiliateLinks: true,
  promotesCompetitor: true,
  commercialIntent: 0.8,
  contactable: true,
  reach: 80_000,
  domainAuthority: null,
  engagementRate: null,
  audienceOverlap: null,
};
const factor = (res: ReturnType<typeof scoreProspect>, name: string) => res.breakdown.find((b) => b.factor === name)!;

describe("D8 — engagement is normalized on a documented scale", () => {
  it("maps the scale's anchors and interpolates between them", () => {
    for (const [rate, score] of ENGAGEMENT_SCALE) expect(normalizeEngagementRate(rate)).toBeCloseTo(score, 10);
    expect(normalizeEngagementRate(0.005)).toBeCloseTo(0.25, 10); // halfway to the 1% anchor
    expect(normalizeEngagementRate(0.02)).toBeCloseTo(0.675, 10); // halfway between 1% and 3%
    expect(normalizeEngagementRate(0.2)).toBe(1); // saturates
    expect(normalizeEngagementRate(-1)).toBe(0);
    expect(normalizeEngagementRate(Number.NaN)).toBe(0);
  });

  it("a strong measured rate scores HIGH — it used to score as its raw value (6% → 0.06)", () => {
    const res = scoreProspect({ ...base, engagementRate: 0.06 });
    expect(factor(res, "quality").normalized).toBe(1);
    expect(factor(res, "quality").note).toContain("6.0%");
  });

  it("measuring a GOOD creator never scores below leaving engagement unknown", () => {
    const unknown = scoreProspect({ ...base, engagementRate: null });
    expect(unknown.unknownFactors).toContain("quality");
    for (const rate of [0.05, 0.06, 0.1]) {
      const measured = scoreProspect({ ...base, engagementRate: rate });
      expect(measured.score).toBeGreaterThanOrEqual(unknown.score);
      expect(measured.unknownFactors).not.toContain("quality");
    }
  });

  it("a genuinely weak rate still lowers the score (the scale is not a free pass)", () => {
    const unknown = scoreProspect({ ...base, engagementRate: null });
    const weak = scoreProspect({ ...base, engagementRate: 0.002 });
    expect(weak.score).toBeLessThan(unknown.score);
  });

  it("averages only the KNOWN halves of quality (unknown DA is not a zero)", () => {
    const engOnly = scoreProspect({ ...base, engagementRate: 0.05 });
    expect(factor(engOnly, "quality").normalized).toBe(1); // not (0 + 1) / 2
    const both = scoreProspect({ ...base, engagementRate: 0.05, domainAuthority: 40 });
    expect(factor(both, "quality").normalized).toBeCloseTo(0.7, 10); // (0.4 + 1) / 2
  });
});

describe("D8 — unknown relevance stays unknown", () => {
  it("leaves relevance out of the score and reports it, instead of scoring it as zero", () => {
    const known = scoreProspect(base);
    const unknown = scoreProspect({ ...base, relevance: null });
    expect(unknown.unknownFactors).toContain("relevance");
    expect(factor(unknown, "relevance").contribution).toBe(0);
    expect(factor(unknown, "relevance").note).toMatch(/unknown/);
    expect(unknown.confidence).toBeLessThan(known.confidence);
    // Scored as zero it would have cost ~20 points; left out, the rest is renormalized.
    const asZero = scoreProspect({ ...base, relevance: 0 });
    expect(unknown.score).toBeGreaterThan(asZero.score);
  });
});

describe("D8 — triage leaves unknown signals out too", () => {
  const pre = { runsAffiliateLinks: true, promotesCompetitor: false, commercialIntent: 0.2, hasContactPath: true };

  it("reports unknown domain authority and renormalizes over what is known", () => {
    const unknown = preScoreProspect({ ...pre, domainAuthority: null });
    expect(unknown.unknownFactors).toEqual(["domainAuthority"]);
    // (0.25 + 0.02 + 0.1) / 0.85 — not / 1.0, which silently scored the missing DA as 0.
    expect(unknown.preScore).toBeCloseTo(0.37 / 0.85, 10);
    expect(preScoreProspect({ ...pre, domainAuthority: 50 }).unknownFactors).toEqual([]);
  });

  it("an unmeasured prospect is never ranked below an identical one that measured poorly", () => {
    const unknown = preScoreProspect({ ...pre, domainAuthority: null });
    const poor = preScoreProspect({ ...pre, domainAuthority: 3 });
    expect(unknown.preScore).toBeGreaterThanOrEqual(poor.preScore);
  });
});

describe("D15 — content freshness is a real, nullable scoring factor", () => {
  it("is excluded and reported when unknown, and changes nothing about the score", () => {
    const res = scoreProspect(base);
    expect(res.unknownFactors).toContain("activity");
    expect(factor(res, "activity").contribution).toBe(0);
    // Same known signals, freshness merely omitted vs explicitly null → identical.
    expect(scoreProspect({ ...base, activityRecency: null }).score).toBe(res.score);
  });

  it("a dormant property scores lower than an active one, all else equal", () => {
    const active = scoreProspect({ ...base, activityRecency: 1 });
    const dormant = scoreProspect({ ...base, activityRecency: 0.02 });
    expect(active.unknownFactors).not.toContain("activity");
    expect(dormant.score).toBeLessThan(active.score);
    expect(factor(dormant, "activity").note).toMatch(/dormant/);
    expect(factor(active, "activity").note).toMatch(/recently active/);
  });

  it("has a weight and blends like the others", () => {
    expect(defaultWeights.activity).toBeGreaterThan(0);
    expect(blendWeights(defaultWeights, { activity: 0.2 }, 1).activity).toBe(0.2);
  });
});

describe("D1 — the contact note never claims a verification that did not happen", () => {
  it("says 'verified' only when the contact was verified", () => {
    expect(factor(scoreProspect({ ...base, contactable: true, contactVerified: true }), "contactability").note).toBe("verified contact path");
    const unverified = factor(scoreProspect({ ...base, contactable: true, contactVerified: false }), "contactability");
    expect(unverified.note).toMatch(/NOT verified/);
    expect(unverified.note).not.toMatch(/^verified/);
    expect(factor(scoreProspect({ ...base, contactable: false }), "contactability").note).toBe("no verified contact");
  });
});
