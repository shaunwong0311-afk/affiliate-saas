import { describe, it, expect } from "vitest";
import { buildProfile, mergeProfiles, identitySignalsFromProfile, IdentityKeyIndex, hasIdentitySignal, type IdentitySignals, type Profile } from "../src/index.js";

/** "Would these two prospects be merged?" — through the one implementation the pipeline uses. */
function overlap(a: IdentitySignals, b: IdentitySignals): boolean {
  const forward = new IdentityKeyIndex();
  forward.add("a", a);
  const backward = new IdentityKeyIndex();
  backward.add("b", b);
  // The rule is symmetric; assert it both ways round so ingest ORDER cannot change the answer.
  expect(forward.lookup(b) !== null).toBe(backward.lookup(a) !== null);
  return forward.lookup(b) !== null;
}

describe("identitySignalsFromProfile + IdentityKeyIndex", () => {
  it("matches two prospects that share a social handle (same creator, different surface)", () => {
    // A: a website that links the creator's YouTube. B: that YouTube channel on its own.
    const a = buildProfile("https://creator.com", [{ url: "https://creator.com", links: ["https://youtube.com/@trailgeek"] }]);
    const b = buildProfile("https://youtube.com/@trailgeek", []);
    const sa = identitySignalsFromProfile(a, []);
    const sb = identitySignalsFromProfile(b, []);
    expect(overlap(sa, sb)).toBe(true); // youtube:@trailgeek in both
  });

  it("matches on a shared website domain", () => {
    const a = identitySignalsFromProfile(buildProfile("https://shop.com", []), []);
    const b = identitySignalsFromProfile(buildProfile("https://shop.com/blog", []), []);
    expect(overlap(a, b)).toBe(true);
  });

  it("matches on a shared contact email AT THE CREATOR'S OWN DOMAIN (case-insensitive)", () => {
    // Two surfaces of one business on different hosts; both print the address at its domain.
    const a = identitySignalsFromProfile(buildProfile("https://studio.com", []), ["hi@studio.com"]);
    const b = identitySignalsFromProfile(buildProfile("https://blog.studio.com", []), ["HI@studio.com"]);
    expect(a.emails.has("hi@studio.com")).toBe(true);
    expect(b.emails.has("hi@studio.com")).toBe(true);
    expect(overlap(a, b)).toBe(true);
  });

  it("does NOT merge two unrelated sites that print the same THIRD-PARTY address (AUDIT-2026-10 D6)", () => {
    // An ad network's sales address in two footers is not evidence the two blogs are one
    // creator. Previously any shared on-page email was a hard identifier and the second
    // blog was silently folded into the first.
    const a = identitySignalsFromProfile(buildProfile("https://blog-one.com", []), ["sales@bigadnetwork.com"]);
    const b = identitySignalsFromProfile(buildProfile("https://blog-two.com", []), ["sales@bigadnetwork.com", "jane@blog-two.com"]);
    expect(a.emails.size).toBe(0); // not at blog-one.com → not an identifier at all
    expect([...b.emails]).toEqual(["jane@blog-two.com"]); // only the own-domain address is kept
    expect(overlap(a, b)).toBe(false);
  });

  it("does NOT treat a shared personal mailbox as a merge key", () => {
    // The same gmail address in two places is usually a web designer or a guest, and a
    // free mailbox is nobody's "own domain".
    const a = identitySignalsFromProfile(buildProfile("https://site-a.com", []), ["someone@gmail.com"]);
    const b = identitySignalsFromProfile(buildProfile("https://site-b.com", []), ["someone@gmail.com"]);
    expect(overlap(a, b)).toBe(false);
  });

  it("does NOT match two unrelated creators", () => {
    const a = identitySignalsFromProfile(buildProfile("https://one.com", []), ["a@one.com"]);
    const b = identitySignalsFromProfile(buildProfile("https://two.com", []), ["b@two.com"]);
    expect(overlap(a, b)).toBe(false);
  });

  it("does NOT merge two unrelated blogs that both LINK the same brand's Instagram (weak↔weak)", () => {
    // Each blog merely one-directionally links instagram.com/nike (a page_link, 0.5) — that
    // is not evidence either blog IS that account. Merging them would be the over-merge bug.
    const a = identitySignalsFromProfile(buildProfile("https://blog1.com", [{ url: "https://blog1.com", links: ["https://instagram.com/nike"] }]), []);
    const b = identitySignalsFromProfile(buildProfile("https://blog2.com", [{ url: "https://blog2.com", links: ["https://instagram.com/nike"] }]), []);
    expect(a.weakAccountKeys.has("instagram:@nike")).toBe(true); // present, but only as a WEAK key
    expect(overlap(a, b)).toBe(false);
  });

  it("does NOT merge two unrelated blogs that embed the same YouTube VIDEO (no channel identity)", () => {
    // A /watch URL carries no channel handle, so it never becomes an account/merge key at all.
    const a = identitySignalsFromProfile(buildProfile("https://b1.com", [{ url: "https://b1.com", links: ["https://youtube.com/watch?v=POPULAR"] }]), []);
    const b = identitySignalsFromProfile(buildProfile("https://b2.com", [{ url: "https://b2.com", links: ["https://youtube.com/watch?v=POPULAR"] }]), []);
    expect([...a.weakAccountKeys, ...a.accountKeys].some((k) => k.startsWith("youtube:"))).toBe(false);
    expect(overlap(a, b)).toBe(false);
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
    expect(overlap(a, b)).toBe(true);
  });

  it("reports when a profile carries no hard identifier", () => {
    expect(hasIdentitySignal(identitySignalsFromProfile(null, []))).toBe(false);
    expect(hasIdentitySignal(identitySignalsFromProfile(buildProfile("https://trailgeek.blog", []), []))).toBe(true);
  });
});

describe("no identity from a platform URL that names nobody (AUDIT-2026-10 D6)", () => {
  it("two YouTube VIDEO prospects are not the same creator", () => {
    // Each seed is a /watch URL. The host used to become a "website" account at youtube.com,
    // so every video prospect shared the domain key `youtube.com` and collapsed into one.
    const a = identitySignalsFromProfile(buildProfile("https://www.youtube.com/watch?v=aaa111", []), []);
    const b = identitySignalsFromProfile(buildProfile("https://www.youtube.com/watch?v=bbb222", []), []);
    expect(a.domains.size).toBe(0);
    expect(hasIdentitySignal(a)).toBe(false);
    expect(overlap(a, b)).toBe(false);
  });

  it("two Instagram POST prospects are not the same creator, and a blog embedding a post is neither", () => {
    // `/p/<id>` used to parse as the handle `@p`: a strong key on every post-URL prospect,
    // and a weak one on every blog that embedded any Instagram post.
    const postA = identitySignalsFromProfile(buildProfile("https://www.instagram.com/p/Cabc123/", []), []);
    const postB = identitySignalsFromProfile(buildProfile("https://www.instagram.com/p/Cxyz789/", []), []);
    const blog = identitySignalsFromProfile(buildProfile("https://someblog.com", [{ url: "https://someblog.com", links: ["https://www.instagram.com/p/Cqqq000/"] }]), []);
    for (const s of [postA, postB, blog]) expect([...s.accountKeys, ...s.weakAccountKeys].some((k) => k.startsWith("instagram:"))).toBe(false);
    expect(overlap(postA, postB)).toBe(false);
    expect(overlap(postA, blog)).toBe(false);
  });

  it("two authors on a shared publishing host are not the same creator", () => {
    const a = identitySignalsFromProfile(buildProfile("https://medium.com/@alice/a-post", []), []);
    const b = identitySignalsFromProfile(buildProfile("https://medium.com/@bob/another-post", []), []);
    expect(a.domains.has("medium.com")).toBe(false);
    expect(overlap(a, b)).toBe(false);
  });

  it("ignores bogus identities already stored on older profiles", () => {
    // Profiles persisted before the parser was platform-aware still carry `instagram:@p`
    // and a "website" at youtube.com. They must not match anything now either.
    const legacy = (accounts: Profile["accounts"]): Profile => ({
      primary: accounts[0] ?? null,
      accounts,
      audience: { reach: null, primaryGeo: null, language: null, engagementRate: null, source: null },
      identityConfidence: 1,
    });
    const a = identitySignalsFromProfile(
      legacy([
        { platform: "instagram", handle: "@p", url: "https://instagram.com/p/Cabc123", provenance: "seed", confidence: 1 },
        { platform: "website", handle: null, url: "https://youtube.com", provenance: "seed", confidence: 1 },
      ]),
      [],
    );
    const b = identitySignalsFromProfile(
      legacy([
        { platform: "instagram", handle: "@p", url: "https://instagram.com/p/Czzz999", provenance: "seed", confidence: 1 },
        { platform: "website", handle: null, url: "https://youtube.com", provenance: "seed", confidence: 1 },
      ]),
      [],
    );
    expect(hasIdentitySignal(a)).toBe(false);
    expect(overlap(a, b)).toBe(false);
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
