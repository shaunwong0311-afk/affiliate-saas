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

  it("does NOT merge two unrelated blogs that both LINK the same brand's Instagram (weak↔weak)", () => {
    // Each blog merely one-directionally links instagram.com/nike (a page_link, 0.5) — that
    // is not evidence either blog IS that account. Merging them would be the over-merge bug.
    const a = identitySignalsFromProfile(buildProfile("https://blog1.com", [{ url: "https://blog1.com", links: ["https://instagram.com/nike"] }]), []);
    const b = identitySignalsFromProfile(buildProfile("https://blog2.com", [{ url: "https://blog2.com", links: ["https://instagram.com/nike"] }]), []);
    expect(a.weakAccountKeys.has("instagram:@nike")).toBe(true); // present, but only as a WEAK key
    expect(identitiesOverlap(a, b)).toBe(false);
  });

  it("does NOT merge two unrelated blogs that embed the same YouTube VIDEO (no channel identity)", () => {
    // A /watch URL carries no channel handle, so it never becomes an account/merge key at all.
    const a = identitySignalsFromProfile(buildProfile("https://b1.com", [{ url: "https://b1.com", links: ["https://youtube.com/watch?v=POPULAR"] }]), []);
    const b = identitySignalsFromProfile(buildProfile("https://b2.com", [{ url: "https://b2.com", links: ["https://youtube.com/watch?v=POPULAR"] }]), []);
    expect([...a.weakAccountKeys, ...a.accountKeys].some((k) => k.startsWith("youtube:"))).toBe(false);
    expect(identitiesOverlap(a, b)).toBe(false);
  });

  it("STILL merges on a shared handle when it is HIGH confidence on both sides (bio_aggregator ↔ seed)", () => {
    // A: the youtube channel discovered on its own (seed, 1.0). B: a creator whose Linktree
    // (bio aggregator, 0.9) lists that same channel → both hold it as a STRONG key.
    const a = identitySignalsFromProfile(buildProfile("https://youtube.com/@trailgeek", []), []);
    const b = identitySignalsFromProfile(
      buildProfile("https://trailgeek.blog", [{ url: "https://linktr.ee/trailgeek", links: ["https://youtube.com/@trailgeek"], bioAggregator: true }]),
      [],
    );
    expect(a.accountKeys.has("youtube:@trailgeek")).toBe(true);
    expect(b.accountKeys.has("youtube:@trailgeek")).toBe(true);
    expect(identitiesOverlap(a, b)).toBe(true);
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
