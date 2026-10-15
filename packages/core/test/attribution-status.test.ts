import { describe, it, expect } from "vitest";
import { resolveAttribution, type AttributionInputs, type Click, type CodeMatch, type Offer } from "../src/index.js";
import { makeOffer, makeOrder, makeRelationship } from "./fixtures.js";

const offerA: Offer = makeOffer({ id: "offer_a", programId: "prog_a" });
const offerB: Offer = makeOffer({ id: "offer_b", programId: "prog_b" });

const click = (overrides: Partial<Click> = {}): Click => ({
  clickId: "click_1",
  merchantId: "merch_1",
  affiliateId: "aff_link",
  offerId: "offer_a",
  ts: "2026-05-20T00:00:00Z",
  ip: null,
  ua: null,
  landingUrl: null,
  ...overrides,
});

const codeFor = (affiliateId: string, programId: string, status: "active" | "banned" | "paused" = "active"): CodeMatch => ({
  code: { id: `code_${affiliateId}`, affiliateId, merchantId: "merch_1", code: "SAVE10", kind: "discount", discountValue: 10, usageCap: null, usageCount: 0, expiresAt: null },
  relationship: makeRelationship({ id: `rel_${affiliateId}`, affiliateId, programId, status }),
});

const inputs = (overrides: Partial<AttributionInputs> = {}): AttributionInputs => ({
  order: makeOrder({ ts: "2026-06-01T00:00:00Z" }),
  candidateClicks: [],
  matchedCodes: [],
  offersById: new Map([
    [offerA.id, offerA],
    [offerB.id, offerB],
  ]),
  lookupRelationship: (affiliateId, offerId) => makeRelationship({ id: `rel_${affiliateId}`, affiliateId, programId: offerId === "offer_a" ? "prog_a" : "prog_b" }),
  priority: "last_touch",
  now: new Date("2026-06-01T00:00:00Z"),
  ...overrides,
});

// AUDIT-2026-10 M11: link attribution ignored relationship, affiliate and offer status.
describe("attribution enforces status", () => {
  it("a banned, paused, pending or rejected relationship earns nothing through a link", () => {
    for (const status of ["banned", "paused", "pending", "rejected"] as const) {
      const res = resolveAttribution(
        inputs({
          clickIdFromPostback: "click_1",
          postbackClick: click(),
          lookupRelationship: (affiliateId) => makeRelationship({ id: "rel_x", affiliateId, programId: "prog_a", status }),
        }),
      );
      expect(res.attribution).toBeNull();
      expect(res.reason).toContain(`${status} relationship`);
    }
  });

  it("an affiliate who is not active earns nothing, by link or by code", () => {
    const isAffiliateActive = (id: string) => id !== "aff_link" && id !== "aff_code";
    expect(resolveAttribution(inputs({ postbackClick: click(), clickIdFromPostback: "click_1", isAffiliateActive })).attribution).toBeNull();
    expect(resolveAttribution(inputs({ matchedCodes: [codeFor("aff_code", "prog_a")], isAffiliateActive })).attribution).toBeNull();
    // Others are unaffected.
    expect(resolveAttribution(inputs({ postbackClick: click({ affiliateId: "aff_ok" }), clickIdFromPostback: "click_1", isAffiliateActive })).attribution?.affiliateId).toBe("aff_ok");
  });

  it("a paused offer earns nothing — not through its links, not as a code's fallback offer", () => {
    const paused = new Map<string, Offer>([[offerA.id, { ...offerA, status: "paused" }]]);
    const viaLink = resolveAttribution(inputs({ offersById: paused, postbackClick: click(), clickIdFromPostback: "click_1" }));
    expect(viaLink.attribution).toBeNull();
    expect(viaLink.reason).toContain("paused offer");
    const viaCode = resolveAttribution(inputs({ offersById: paused, matchedCodes: [codeFor("aff_code", "prog_a")] }));
    expect(viaCode.attribution).toBeNull();
    expect(viaCode.reason).toContain("no active offer");
  });

  it("falls back to an earlier eligible click when the newest one cannot earn", () => {
    const res = resolveAttribution(
      inputs({
        candidateClicks: [click({ clickId: "old", affiliateId: "aff_good", ts: "2026-05-10T00:00:00Z" }), click({ clickId: "new", affiliateId: "aff_banned", ts: "2026-05-28T00:00:00Z" })],
        lookupRelationship: (affiliateId) => makeRelationship({ id: `rel_${affiliateId}`, affiliateId, programId: "prog_a", status: affiliateId === "aff_banned" ? "banned" : "active" }),
      }),
    );
    expect(res.attribution?.affiliateId).toBe("aff_good");
    expect(res.attribution?.clickId).toBe("old");
  });
});

// AUDIT-2026-10 M9: precedence came from whichever program the merchant's FIRST offer was in.
describe("attribution priority is per program", () => {
  const both = { postbackClick: click(), clickIdFromPostback: "click_1" };

  it("uses the program's own setting when link and code are in the same program", () => {
    const sameProgram = { ...both, matchedCodes: [codeFor("aff_code", "prog_a")] };
    expect(resolveAttribution(inputs({ ...sameProgram, priority: "code_first", priorityByProgram: new Map([["prog_a", "link_first"]]) })).attribution?.mechanism).toBe("link");
    expect(resolveAttribution(inputs({ ...sameProgram, priority: "link_first", priorityByProgram: new Map([["prog_a", "code_first"]]) })).attribution?.mechanism).toBe("code");
  });

  it("falls back to last touch when the link's and the code's programs disagree", () => {
    const twoPrograms = { ...both, matchedCodes: [codeFor("aff_code", "prog_b")] };
    const disagree = new Map([
      ["prog_a", "link_first"],
      ["prog_b", "code_first"],
    ] as const);
    // The code is the latest touch (used at checkout), so it wins.
    expect(resolveAttribution(inputs({ ...twoPrograms, priorityByProgram: disagree })).attribution?.mechanism).toBe("code");
    const agree = new Map([
      ["prog_a", "link_first"],
      ["prog_b", "link_first"],
    ] as const);
    expect(resolveAttribution(inputs({ ...twoPrograms, priorityByProgram: agree })).attribution?.mechanism).toBe("link");
  });

  it("with a single candidate the other program's setting is irrelevant", () => {
    expect(resolveAttribution(inputs({ ...both, priorityByProgram: new Map([["prog_b", "code_first"]]) })).attribution?.mechanism).toBe("link");
  });
});
