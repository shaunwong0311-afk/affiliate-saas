import { describe, it, expect } from "vitest";
import { AffiliateEngine } from "../src/index.js";
import { makeOffer, makeOrder, makeRelationship, makeOnOrderContext } from "./fixtures.js";

const engine = new AffiliateEngine();

describe("AffiliateEngine.onOrder — direct commission", () => {
  it("pays a percentage commission to the seller", () => {
    const events = engine.onOrder(makeOnOrderContext());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("commission");
    expect(events[0]!.affiliateId).toBe("aff_seller");
    expect(events[0]!.amount.amountCents).toBe(2000); // 20% of $100
    expect(events[0]!.level).toBe(0);
  });

  it("pays a flat commission for flat offers, honoring per-relationship override", () => {
    const offer = makeOffer({ payoutType: "flat", payoutValue: 500 });
    const relationship = makeRelationship({ commissionTerms: { flatAmountCents: 750 } });
    const events = engine.onOrder(makeOnOrderContext({ offer, relationship }));
    expect(events[0]!.amount.amountCents).toBe(750);
  });

  it("honors a per-relationship percentage override (VIP terms)", () => {
    const relationship = makeRelationship({ commissionTerms: { rate: 0.35 } });
    const events = engine.onOrder(makeOnOrderContext({ relationship }));
    expect(events[0]!.amount.amountCents).toBe(3500);
  });

  it("does not pay direct commission to a recruiter-only affiliate", () => {
    const relationship = makeRelationship({ role: "recruiter" });
    const events = engine.onOrder(makeOnOrderContext({ relationship }));
    expect(events.find((e) => e.type === "commission")).toBeUndefined();
  });

  it("caps commission at max_commission_cents", () => {
    const offer = makeOffer({ rules: [{ kind: "max_commission_cents", value: 1500 }] });
    const events = engine.onOrder(makeOnOrderContext({ offer }));
    expect(events[0]!.amount.amountCents).toBe(1500);
  });
});

describe("AffiliateEngine.onOrder — guardrails", () => {
  it("skips a rebill when the offer is not recurring", () => {
    const order = makeOrder({ isRebill: true });
    const events = engine.onOrder(makeOnOrderContext({ order }));
    expect(events).toHaveLength(0);
  });

  it("pays a rebill when the offer is recurring", () => {
    const offer = makeOffer({ rules: [{ kind: "recurring", value: true }] });
    const order = makeOrder({ isRebill: true });
    const events = engine.onOrder(makeOnOrderContext({ offer, order }));
    expect(events[0]!.amount.amountCents).toBe(2000);
  });

  it("blocks geo-restricted orders", () => {
    const offer = makeOffer({ rules: [{ kind: "geo_block", countries: ["US"] }] });
    const events = engine.onOrder(makeOnOrderContext({ offer }));
    expect(events).toHaveLength(0);
  });

  it("respects new_customer_only", () => {
    const offer = makeOffer({ rules: [{ kind: "new_customer_only", value: true }] });
    const order = makeOrder({ isNewCustomer: false });
    expect(engine.onOrder(makeOnOrderContext({ offer, order }))).toHaveLength(0);
  });

  it("uses net_of_discount basis", () => {
    const offer = makeOffer({ rules: [{ kind: "commissionable_basis", basis: "net_of_discount" }] });
    const order = makeOrder({ amountCents: 12_000, subtotalCents: 12_000, discountCents: 2_000 });
    const events = engine.onOrder(makeOnOrderContext({ offer, order }));
    // 20% of (12000 - 2000) = 2000
    expect(events[0]!.amount.amountCents).toBe(2000);
  });

  it("excludes SKUs from the commissionable base", () => {
    const offer = makeOffer({ rules: [{ kind: "sku_exclude", skus: ["GIFTCARD"] }] });
    const order = makeOrder({
      amountCents: 10_000,
      subtotalCents: 10_000,
      lineItems: [
        { sku: "WIDGET", category: "widgets", quantity: 1, amountCents: 7_000 },
        { sku: "GIFTCARD", category: "gift", quantity: 1, amountCents: 3_000 },
      ],
    });
    const events = engine.onOrder(makeOnOrderContext({ offer, order }));
    // 20% of 7000 = 1400
    expect(events[0]!.amount.amountCents).toBe(1400);
  });
});

describe("AffiliateEngine.onOrder — tiers, bonuses, boosts", () => {
  it("applies volume tiers based on prior volume", () => {
    const offer = makeOffer({
      tiers: [
        { id: "t1", offerId: "offer_1", minVolumeCents: 50_000, rate: 0.25 },
        { id: "t2", offerId: "offer_1", minVolumeCents: 100_000, rate: 0.3 },
      ],
    });
    const events = engine.onOrder(makeOnOrderContext({ offer, priorVolumeCents: 120_000 }));
    expect(events[0]!.amount.amountCents).toBe(3000); // 30% tier
  });

  it("awards a first_sale bonus once", () => {
    const offer = makeOffer({
      bonuses: [{ id: "b1", offerId: "offer_1", triggerType: "first_sale", threshold: 1, amountCents: 5_000 }],
    });
    const first = engine.onOrder(makeOnOrderContext({ offer, isFirstConversionForAffiliate: true }));
    expect(first.find((e) => e.type === "bonus")?.amount.amountCents).toBe(5000);
    const later = engine.onOrder(makeOnOrderContext({ offer, isFirstConversionForAffiliate: false }));
    expect(later.find((e) => e.type === "bonus")).toBeUndefined();
  });

  it("awards a lifetime_volume bonus only on the crossing order", () => {
    const offer = makeOffer({
      bonuses: [{ id: "b2", offerId: "offer_1", triggerType: "lifetime_volume", threshold: 100_000, amountCents: 10_000 }],
    });
    const order = makeOrder({ amountCents: 30_000, subtotalCents: 30_000 });
    // prior 80k + 30k = 110k crosses 100k
    const crossing = engine.onOrder(makeOnOrderContext({ offer, order, priorVolumeCents: 80_000 }));
    expect(crossing.find((e) => e.type === "bonus")?.amount.amountCents).toBe(10_000);
    // prior 110k already past → no bonus
    const after = engine.onOrder(makeOnOrderContext({ offer, order, priorVolumeCents: 110_000 }));
    expect(after.find((e) => e.type === "bonus")).toBeUndefined();
  });

  it("applies an active time boost over the base rate", () => {
    const offer = makeOffer({
      rules: [{ kind: "time_boost", rate: 0.4, startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-02T00:00:00Z" }],
    });
    const events = engine.onOrder(makeOnOrderContext({ offer }));
    expect(events[0]!.amount.amountCents).toBe(4000); // 40% boost
  });
});

describe("AffiliateEngine.onOrder — recruiter override (two-tier)", () => {
  const offerWithOverride = () =>
    makeOffer({
      overridePolicy: { id: "op1", offerId: "offer_1", structure: "percentage", value: 0.1, trigger: "per_sale", maxDepth: 1 },
    });

  const sponsor = () =>
    makeRelationship({
      id: "rel_recruiter",
      affiliateId: "aff_recruiter",
      role: "recruiter",
      sponsorAffiliateId: null,
    });

  it("pays a percentage override to an active recruiter sponsor", () => {
    const events = engine.onOrder(
      makeOnOrderContext({ offer: offerWithOverride(), sponsorRelationship: sponsor() }),
    );
    const override = events.find((e) => e.type === "override");
    expect(override).toBeDefined();
    expect(override!.affiliateId).toBe("aff_recruiter");
    expect(override!.amount.amountCents).toBe(1000); // 10% of $100 base
    expect(override!.level).toBe(1);
  });

  it("pays a flat override", () => {
    const offer = makeOffer({
      overridePolicy: { id: "op2", offerId: "offer_1", structure: "flat", value: 250, trigger: "per_sale", maxDepth: 1 },
    });
    const events = engine.onOrder(makeOnOrderContext({ offer, sponsorRelationship: sponsor() }));
    expect(events.find((e) => e.type === "override")!.amount.amountCents).toBe(250);
  });

  it("respects the first_sale trigger", () => {
    const offer = makeOffer({
      overridePolicy: { id: "op3", offerId: "offer_1", structure: "flat", value: 250, trigger: "first_sale", maxDepth: 1 },
    });
    const notFirst = engine.onOrder(
      makeOnOrderContext({ offer, sponsorRelationship: sponsor(), isFirstSaleUnderSponsor: false }),
    );
    expect(notFirst.find((e) => e.type === "override")).toBeUndefined();
  });

  it("does not pay an override if the sponsor lacks the recruiter role", () => {
    const seller = makeRelationship({ id: "rel_x", affiliateId: "aff_x", role: "seller" });
    const events = engine.onOrder(makeOnOrderContext({ offer: offerWithOverride(), sponsorRelationship: seller }));
    expect(events.find((e) => e.type === "override")).toBeUndefined();
  });

  it("never overrides a self-referral sponsor", () => {
    const self = makeRelationship({ id: "rel_self", affiliateId: "aff_seller", role: "both" });
    const events = engine.onOrder(makeOnOrderContext({ offer: offerWithOverride(), sponsorRelationship: self }));
    expect(events.find((e) => e.type === "override")).toBeUndefined();
  });
});

describe("AffiliateEngine.qualify", () => {
  it("reports the qualified tier name and rate", () => {
    const offer = makeOffer({
      tiers: [
        { id: "t1", offerId: "offer_1", minVolumeCents: 50_000, rate: 0.25 },
        { id: "t2", offerId: "offer_1", minVolumeCents: 100_000, rate: 0.3 },
      ],
    });
    expect(engine.qualify({ offer, priorVolumeCents: 0, now: new Date() }).tier).toBeNull();
    expect(engine.qualify({ offer, priorVolumeCents: 60_000, now: new Date() })).toMatchObject({ tier: "Bronze", rate: 0.25 });
    expect(engine.qualify({ offer, priorVolumeCents: 120_000, now: new Date() })).toMatchObject({ tier: "Silver", rate: 0.3 });
  });
});
