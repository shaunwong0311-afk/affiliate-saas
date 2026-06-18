import { describe, it, expect } from "vitest";
import {
  resolveAttribution,
  type AttributionInputs,
  type Click,
  type Offer,
} from "../src/index.js";
import { makeOffer, makeOrder, makeRelationship } from "./fixtures.js";

const offer: Offer = makeOffer({ windowDays: 30 });
const offersById = new Map([[offer.id, offer]]);

function makeClick(overrides: Partial<Click> = {}): Click {
  return {
    clickId: "click_1",
    merchantId: "merch_1",
    affiliateId: "aff_link",
    offerId: offer.id,
    ts: "2026-05-20T00:00:00Z",
    ip: "1.2.3.4",
    ua: "test",
    landingUrl: "https://shop.example/p",
    ...overrides,
  };
}

const baseInputs = (overrides: Partial<AttributionInputs> = {}): AttributionInputs => ({
  order: makeOrder({ ts: "2026-06-01T00:00:00Z" }),
  candidateClicks: [],
  matchedCodes: [],
  offersById,
  lookupRelationship: (affiliateId) => makeRelationship({ id: `rel_${affiliateId}`, affiliateId }),
  priority: "link_first",
  now: new Date("2026-06-01T00:00:00Z"),
  ...overrides,
});

describe("attribution", () => {
  it("matches deterministically on click_id from the postback", () => {
    const res = resolveAttribution(baseInputs({ clickIdFromPostback: "click_1", postbackClick: makeClick() }));
    expect(res.attribution?.mechanism).toBe("link");
    expect(res.attribution?.affiliateId).toBe("aff_link");
    expect(res.reason).toContain("deterministic");
  });

  it("falls back to last click within window", () => {
    const older = makeClick({ clickId: "c_old", affiliateId: "aff_old", ts: "2026-05-10T00:00:00Z" });
    const newer = makeClick({ clickId: "c_new", affiliateId: "aff_new", ts: "2026-05-28T00:00:00Z" });
    const res = resolveAttribution(baseInputs({ candidateClicks: [older, newer] }));
    expect(res.attribution?.affiliateId).toBe("aff_new");
  });

  it("ignores clicks outside the attribution window", () => {
    const stale = makeClick({ ts: "2026-01-01T00:00:00Z" }); // > 30 days
    const res = resolveAttribution(baseInputs({ candidateClicks: [stale] }));
    expect(res.attribution).toBeNull();
  });

  it("code_first prefers a code over a click", () => {
    const code = {
      code: { id: "code_1", affiliateId: "aff_code", merchantId: "merch_1", code: "SAVE10", kind: "discount" as const, discountValue: 10, usageCap: null, usageCount: 0, expiresAt: null },
      relationship: makeRelationship({ id: "rel_code", affiliateId: "aff_code" }),
    };
    const res = resolveAttribution(
      baseInputs({ priority: "code_first", postbackClick: makeClick(), clickIdFromPostback: "click_1", matchedCodes: [code] }),
    );
    expect(res.attribution?.mechanism).toBe("code");
    expect(res.attribution?.affiliateId).toBe("aff_code");
  });

  it("link_first prefers a click when both present", () => {
    const code = {
      code: { id: "code_1", affiliateId: "aff_code", merchantId: "merch_1", code: "SAVE10", kind: "referral" as const, discountValue: null, usageCap: null, usageCount: 0, expiresAt: null },
      relationship: makeRelationship({ id: "rel_code", affiliateId: "aff_code" }),
    };
    const res = resolveAttribution(
      baseInputs({ priority: "link_first", postbackClick: makeClick(), clickIdFromPostback: "click_1", matchedCodes: [code] }),
    );
    expect(res.attribution?.mechanism).toBe("link");
  });

  it("returns null when nothing matches", () => {
    expect(resolveAttribution(baseInputs()).attribution).toBeNull();
  });

  it("skips expired or capped codes", () => {
    const expired = {
      code: { id: "code_x", affiliateId: "aff_code", merchantId: "merch_1", code: "OLD", kind: "discount" as const, discountValue: 10, usageCap: null, usageCount: 0, expiresAt: "2026-01-01T00:00:00Z" },
      relationship: makeRelationship({ id: "rel_code", affiliateId: "aff_code" }),
    };
    expect(resolveAttribution(baseInputs({ priority: "code_first", matchedCodes: [expired] })).attribution).toBeNull();
  });
});
