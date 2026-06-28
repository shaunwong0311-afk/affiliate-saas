import { describe, it, expect } from "vitest";
import { buildProfile, mergeProfiles, identitySignalsFromProfile, identitiesOverlap, hasIdentitySignal } from "../src/index.js";

describe("identitySignalsFromProfile + identitiesOverlap", () => {
  it("matches two prospects that share a social handle (same creator, different surface)", () => {
    // A: a website that links the creator's YouTube. B: that YouTube channel on its own.
    const a = buildProfile("https://creator.com", [{ url: "https://creator.com", links: ["https://youtube.com/@trailgeek"] }]);
    const b = buildProfile("https://youtube.com/@trailgeek", []);
    const sa = identitySignalsFromProfile(a, []);
    const sb = identitySignalsFromProfile(b, []);
    expect(identitiesOverlap(sa, sb)).toBe(true); // youtube:@trailgeek in both
  });

  it("matches on a shared website domain", () => {
    const a = identitySignalsFromProfile(buildProfile("https://shop.com", []), []);
    const b = identitySignalsFromProfile(buildProfile("https://shop.com/blog", []), []);
    expect(identitiesOverlap(a, b)).toBe(true);
  });

  it("matches on a shared contact email", () => {
    const a = identitySignalsFromProfile(buildProfile("https://a-site.com", []), ["hi@studio.com"]);
    const b = identitySignalsFromProfile(buildProfile("https://b-site.com", []), ["HI@studio.com"]);
    expect(identitiesOverlap(a, b)).toBe(true); // email match, case-insensitive
  });

  it("does NOT match two unrelated creators", () => {
    const a = identitySignalsFromProfile(buildProfile("https://one.com", []), ["a@one.com"]);
    const b = identitySignalsFromProfile(buildProfile("https://two.com", []), ["b@two.com"]);
    expect(identitiesOverlap(a, b)).toBe(false);
  });

  it("reports when a profile carries no hard identifier", () => {
    expect(hasIdentitySignal(identitySignalsFromProfile(null, []))).toBe(false);
    expect(hasIdentitySignal(identitySignalsFromProfile(buildProfile("https://x.com", []), []))).toBe(true);
  });
});

describe("mergeProfiles", () => {
  it("unions accounts across two surfaces of one creator and keeps audience data", () => {
    const a = buildProfile("https://creator.com", [{ url: "https://creator.com", links: ["https://youtube.com/@cg"] }]);
    const b = buildProfile("https://twitter.com/cg", []);
    b.audience.reach = 12000;
    const merged = mergeProfiles(a, b);
    const platforms = merged.accounts.map((x) => x.platform).sort();
    expect(platforms).toContain("website");
    expect(platforms).toContain("youtube");
    expect(platforms).toContain("twitter");
    expect(merged.audience.reach).toBe(12000); // pulled from b
  });
});
