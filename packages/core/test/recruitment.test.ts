import { describe, it, expect } from "vitest";
import {
  scoreProspect,
  defaultWeights,
  blendWeights,
  type ScoringSignals,
  canTransition,
  transition,
  isTerminal,
  IllegalTransitionError,
  detectAffiliateUrl,
  detectAffiliateLinksInHtml,
  hasProvenAffiliateSignal,
  promotesCompetitor,
  assessFraud,
  hasSponsorCycle,
} from "../src/index.js";

const strongProspect: ScoringSignals = {
  relevance: 0.9,
  runsAffiliateLinks: true,
  promotesCompetitor: true,
  reach: 500_000,
  domainAuthority: 70,
  engagementRate: 0.08,
  commercialIntent: 0.9,
  contactable: true,
  audienceOverlap: 0.8,
};

describe("scoring", () => {
  it("ranks a competitor-promoting, contactable creator as A-tier", () => {
    const res = scoreProspect(strongProspect);
    expect(res.tier).toBe("A");
    expect(res.score).toBeGreaterThanOrEqual(70);
    expect(res.explanation[0]).toContain("affiliatePropensity");
  });

  it("caps an un-contactable prospect below A-tier", () => {
    const res = scoreProspect({ ...strongProspect, contactable: false });
    expect(res.tier).not.toBe("A");
  });

  it("scores a weak prospect as C-tier", () => {
    const weak: ScoringSignals = {
      relevance: 0.1, runsAffiliateLinks: false, promotesCompetitor: false, reach: 200,
      domainAuthority: 5, engagementRate: 0.005, commercialIntent: 0.1, contactable: false, audienceOverlap: 0.1,
    };
    expect(scoreProspect(weak).tier).toBe("C");
  });

  it("blends heuristic and learned weights", () => {
    const learned = blendWeights(defaultWeights, { affiliatePropensity: 0.5 }, 1);
    expect(learned.affiliatePropensity).toBe(0.5);
    const half = blendWeights(defaultWeights, { affiliatePropensity: 0.5 }, 0.5);
    expect(half.affiliatePropensity).toBeCloseTo((0.3 + 0.5) / 2);
  });
});

describe("scoring with unknown (un-provided) signals", () => {
  // reach / domainAuthority / engagement / audienceOverlap are null — no SEO,
  // creator-analytics, or audience provider is wired. They must be EXCLUDED, not
  // invented, and confidence must drop accordingly.
  const partial: ScoringSignals = {
    relevance: 0.8,
    runsAffiliateLinks: true,
    promotesCompetitor: true,
    commercialIntent: 0.7,
    contactable: true,
    reach: null,
    domainAuthority: null,
    engagementRate: null,
    audienceOverlap: null,
  };

  it("reports the unknown factors and lowers confidence below 1", () => {
    const res = scoreProspect(partial);
    expect(res.unknownFactors).toEqual(expect.arrayContaining(["reach", "quality", "audienceOverlap"]));
    expect(res.confidence).toBeGreaterThan(0);
    expect(res.confidence).toBeLessThan(1);
  });

  it("never invents values — unknown factors contribute exactly 0 points", () => {
    const res = scoreProspect(partial);
    const unknownPts = res.breakdown
      .filter((b) => ["reach", "quality", "audienceOverlap"].includes(b.factor))
      .reduce((s, b) => s + b.contribution, 0);
    expect(unknownPts).toBe(0);
  });

  it("still ranks a strong prospect well on the KNOWN signals alone", () => {
    // High relevance + competitor promotion + intent + contactable should clear B-tier
    // even with all provider signals missing.
    const res = scoreProspect(partial);
    expect(res.score).toBeGreaterThan(0);
    expect(["A", "B"]).toContain(res.tier);
  });

  it("reaches full confidence only when every signal is known", () => {
    const res = scoreProspect({ ...partial, reach: 100_000, domainAuthority: 60, engagementRate: 0.05, audienceOverlap: 0.7 });
    expect(res.confidence).toBe(1);
    expect(res.unknownFactors).toEqual([]);
  });
});

describe("prospect state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("discovered", "enriched")).toBe(true);
    expect(canTransition("scored", "queued")).toBe(true);
    expect(transition("queued", "contacted")).toBe("contacted");
  });

  it("allows suppression from any active state", () => {
    expect(canTransition("in_sequence", "suppressed")).toBe(true);
    expect(canTransition("contacted", "bounced")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("discovered", "converted")).toBe(false);
    expect(() => transition("discovered", "converted")).toThrow(IllegalTransitionError);
  });

  it("knows terminal states", () => {
    expect(isTerminal("converted")).toBe(true);
    expect(isTerminal("scored")).toBe(false);
  });
});

describe("affiliate-link detection", () => {
  it("detects Amazon Associates tag", () => {
    const s = detectAffiliateUrl("https://amzn.to/3abc?tag=mysite-20");
    expect(s[0]!.network).toBe("Amazon Associates");
  });

  it("detects generic ?ref= params but marks them LOW confidence", () => {
    const s = detectAffiliateUrl("https://competitor.com/buy?ref=joe123");
    expect(s.some((x) => x.network.includes("Generic"))).toBe(true);
    expect(s.every((x) => x.confidence === "low")).toBe(true);
  });

  it("marks named networks HIGH confidence", () => {
    const s = detectAffiliateUrl("https://amzn.to/3abc?tag=mysite-20");
    expect(s[0]!.confidence).toBe("high");
    expect(hasProvenAffiliateSignal(s)).toBe(true);
  });

  it("detects ShareASale and Impact", () => {
    expect(detectAffiliateUrl("https://shareasale.com/r.cfm?u=123&m=456").length).toBeGreaterThan(0);
    expect(detectAffiliateUrl("https://goto.7eer.net/c/123/456/789").length).toBeGreaterThan(0);
  });

  it("counts a link that points DIRECTLY at the competitor's domain", () => {
    // The destination is in the URL — no redirect ambiguity — so it counts even
    // though the ?ref= itself is low confidence.
    const html = `<a href="https://www.competitor.com/p?ref=abc">buy</a><a href="https://example.com">x</a>`;
    const signals = detectAffiliateLinksInHtml(html);
    expect(signals.length).toBeGreaterThan(0);
    expect(promotesCompetitor(signals, ["competitor.com"])).toBe(true);
    expect(promotesCompetitor(signals, ["other.com"])).toBe(false);
  });

  it("does NOT assume a THIRD-PARTY redirector lands on the competitor (no false positive)", () => {
    // A generic ?ref= on someone else's tracking domain — we don't know where it
    // lands. It must NOT count until a redirect resolver confirms the destination.
    const [sig] = detectAffiliateUrl("https://link.tracker.io/go/deal?ref=abc");
    expect(sig!.confidence).toBe("low");
    expect(promotesCompetitor([sig!], ["competitor.com"])).toBe(false);
    // After the redirect resolver confirms the final host → counted.
    const resolved = { ...sig!, verified: true, resolvedHost: "competitor.com" };
    expect(promotesCompetitor([resolved], ["competitor.com"])).toBe(true);
  });
});

describe("fraud", () => {
  it("approves a clean conversion", () => {
    const res = assessFraud({
      ipClickCountInWindow: 1, ipIsDatacenter: false, clickToConversionSeconds: 3600,
      affiliateReversalRate: 0.05, isSelfReferral: false, isCircularSponsorship: false,
      amountCents: 5000, manualReviewOverCents: null,
    });
    expect(res.decision).toBe("approve");
  });

  it("rejects self-referral outright", () => {
    const res = assessFraud({
      ipClickCountInWindow: 1, ipIsDatacenter: false, clickToConversionSeconds: 3600,
      affiliateReversalRate: 0, isSelfReferral: true, isCircularSponsorship: false,
      amountCents: 5000, manualReviewOverCents: null,
    });
    expect(res.decision).toBe("reject");
  });

  it("flags fast click→conversion plus datacenter IP for review", () => {
    const res = assessFraud({
      ipClickCountInWindow: 1, ipIsDatacenter: true, clickToConversionSeconds: 1,
      affiliateReversalRate: 0, isSelfReferral: false, isCircularSponsorship: false,
      amountCents: 5000, manualReviewOverCents: null,
    });
    expect(res.decision).toBe("review");
    expect(res.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("forces review for high-value conversions", () => {
    const res = assessFraud({
      ipClickCountInWindow: 1, ipIsDatacenter: false, clickToConversionSeconds: 3600,
      affiliateReversalRate: 0, isSelfReferral: false, isCircularSponsorship: false,
      amountCents: 100_000, manualReviewOverCents: 50_000,
    });
    expect(res.decision).toBe("review");
  });

  it("detects sponsor cycles", () => {
    const sponsorOf = (id: string): string | null => ({ a: "b", b: "c", c: "a" } as Record<string, string>)[id] ?? null;
    expect(hasSponsorCycle("a", sponsorOf)).toBe(true);
    const acyclic = (id: string): string | null => ({ a: "b", b: "c" } as Record<string, string>)[id] ?? null;
    expect(hasSponsorCycle("a", acyclic)).toBe(false);
  });
});
