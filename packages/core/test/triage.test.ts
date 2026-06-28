import { describe, it, expect } from "vitest";
import { preScoreProspect } from "../src/index.js";

const base = {
  runsAffiliateLinks: false,
  promotesCompetitor: false,
  domainAuthority: null as number | null,
  commercialIntent: 0,
  hasContactPath: false,
};

describe("preScoreProspect", () => {
  it("ranks a confirmed competitor-promoter with a contact path as HOT and deep", () => {
    const r = preScoreProspect({ ...base, promotesCompetitor: true, runsAffiliateLinks: true, domainAuthority: 70, commercialIntent: 0.8, hasContactPath: true });
    expect(r.band).toBe("hot");
    expect(r.enrichDepth).toBe(5);
    expect(r.reasons[0]).toMatch(/competitor/);
  });

  it("ranks a bare SERP page (intent only, no signals) as COLD and shallow (fewer PAID lookups)", () => {
    const r = preScoreProspect({ ...base, commercialIntent: 0.8 });
    expect(r.band).toBe("cold");
    expect(r.enrichDepth).toBe(1); // minimal paid audience lookups; contact-finding still runs
  });

  it("orders by the dominant signal: competitor-promoter outranks a plain affiliate", () => {
    const promoter = preScoreProspect({ ...base, promotesCompetitor: true, hasContactPath: true });
    const affiliate = preScoreProspect({ ...base, runsAffiliateLinks: true, hasContactPath: true });
    expect(promoter.preScore).toBeGreaterThan(affiliate.preScore);
  });

  it("treats unknown domain authority as neutral (no penalty, no invented credit)", () => {
    const withDa = preScoreProspect({ ...base, runsAffiliateLinks: true, domainAuthority: 90 });
    const noDa = preScoreProspect({ ...base, runsAffiliateLinks: true, domainAuthority: null });
    expect(withDa.preScore).toBeGreaterThan(noDa.preScore); // DA adds when known
    expect(noDa.preScore).toBeGreaterThan(0); // but its absence doesn't zero the score
  });

  it("keeps the score in 0..1", () => {
    const max = preScoreProspect({ runsAffiliateLinks: true, promotesCompetitor: true, domainAuthority: 100, commercialIntent: 1, hasContactPath: true });
    expect(max.preScore).toBeLessThanOrEqual(1);
    expect(max.preScore).toBeCloseTo(1, 5);
  });
});
