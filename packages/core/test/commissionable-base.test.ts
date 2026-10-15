import { describe, it, expect } from "vitest";
import { AffiliateEngine, MoneyError, computeCommissionableBase, currencyPricingIssue, type CommissionableBasis, type Order } from "../src/index.js";
import { makeOffer, makeOrder, makeOnOrderContext, makeRelationship } from "./fixtures.js";

// AUDIT-2026-10 M8.
const engine = new AffiliateEngine();
const baseOf = (order: Order, basis: CommissionableBasis, extraRules: any[] = []) =>
  computeCommissionableBase(order, makeOffer({ rules: [{ kind: "commissionable_basis", basis }, ...extraRules] }), {
    isFirstConversionForAffiliate: true,
  });

// One $100.00 item, $20 off, $8 tax, $5 shipping: the customer pays $93.00.
const discounted = (lineItems: Order["lineItems"] = []) =>
  makeOrder({ amountCents: 9_300, subtotalCents: 10_000, discountCents: 2_000, taxCents: 800, shippingCents: 500, lineItems });
const oneLine = [{ sku: "W", category: "widgets", quantity: 1, amountCents: 10_000 }];

describe("commissionable base", () => {
  it("gives each basis its own, correct figure", () => {
    expect(baseOf(discounted(), "gross").baseCents).toBe(9_300); // what was charged
    expect(baseOf(discounted(), "net_of_tax_shipping").baseCents).toBe(8_000); // charged − tax − shipping
    expect(baseOf(discounted(), "net_of_discount").baseCents).toBe(8_000); // subtotal − discount
  });

  it("the two net bases read different fields, so each survives a feed that lacks the other's", () => {
    // A feed that reports only the total and the tax/shipping split (no real subtotal).
    const noSubtotal = makeOrder({ amountCents: 11_300, subtotalCents: 11_300, discountCents: 0, taxCents: 800, shippingCents: 500 });
    expect(baseOf(noSubtotal, "net_of_tax_shipping").baseCents).toBe(10_000);
    expect(baseOf(noSubtotal, "net_of_discount").baseCents).toBe(11_300);
    // A feed that reports subtotal and discount but no tax/shipping split.
    const noSplit = makeOrder({ amountCents: 9_300, subtotalCents: 10_000, discountCents: 2_000, taxCents: 0, shippingCents: 0 });
    expect(baseOf(noSplit, "net_of_discount").baseCents).toBe(8_000);
    expect(baseOf(noSplit, "net_of_tax_shipping").baseCents).toBe(9_300);
  });

  it("is the same with and without line items when every line is eligible", () => {
    for (const basis of ["gross", "net_of_discount", "net_of_tax_shipping"] as const) {
      expect(baseOf(discounted(oneLine), basis).baseCents).toBe(baseOf(discounted(), basis).baseCents);
    }
    // The common shape: no discount, $100 item + $13 tax and shipping.
    const plain = (lineItems: Order["lineItems"]) =>
      makeOrder({ amountCents: 11_300, subtotalCents: 10_000, discountCents: 0, taxCents: 800, shippingCents: 500, lineItems });
    expect(baseOf(plain(oneLine), "net_of_tax_shipping").baseCents).toBe(10_000); // was 8,850
    expect(baseOf(plain([]), "net_of_tax_shipping").baseCents).toBe(10_000);
  });

  it("apportions the base to the eligible lines by their share of the lines", () => {
    const lines = [
      { sku: "WIDGET", category: "widgets", quantity: 1, amountCents: 7_000 },
      { sku: "GIFTCARD", category: "gift", quantity: 1, amountCents: 3_000 },
    ];
    const exclude = [{ kind: "sku_exclude", skus: ["GIFTCARD"] }];
    expect(baseOf(discounted(lines), "net_of_discount", exclude).baseCents).toBe(5_600); // 8,000 × 70%
    expect(baseOf(discounted(lines), "gross", exclude).baseCents).toBe(6_510); // 9,300 × 70%
    expect(baseOf(discounted(lines), "gross", [{ kind: "sku_include", skus: ["NOPE"] }]).eligible).toBe(false);
  });

  it("splits the base across categories without losing or inventing a cent", () => {
    const lines = [
      { sku: "A", category: "a", quantity: 1, amountCents: 3_333 },
      { sku: "B", category: "b", quantity: 1, amountCents: 3_333 },
      { sku: "C", category: null, quantity: 1, amountCents: 3_334 },
    ];
    const order = makeOrder({ amountCents: 10_001, subtotalCents: 10_001, lineItems: lines });
    const base = baseOf(order, "gross");
    expect(base.baseCents).toBe(10_001);
    expect([...base.categoryBaseCents.values()].reduce((s, v) => s + v, 0)).toBe(10_001);
  });

  it("is not eligible when the base is zero or negative", () => {
    const allTax = makeOrder({ amountCents: 500, subtotalCents: 0, taxCents: 500 });
    expect(baseOf(allTax, "net_of_tax_shipping").eligible).toBe(false);
    expect(engine.onOrder(makeOnOrderContext({ order: allTax, offer: makeOffer({ rules: [{ kind: "commissionable_basis", basis: "net_of_discount" }] }) }))).toEqual([]);
  });
});

describe("offer currency", () => {
  const jpyOrder = makeOrder({ currency: "JPY", amountCents: 500_000, subtotalCents: 500_000 });

  it("a plain percentage offer prices an order in any currency, in the order's currency", () => {
    const offer = makeOffer({ currency: "USD", payoutValue: 0.1 });
    expect(currencyPricingIssue(jpyOrder, offer)).toBeNull();
    const [commission] = engine.onOrder(makeOnOrderContext({ order: jpyOrder, offer }));
    expect(commission!.amount).toEqual({ amountCents: 50_000, currency: "JPY" });
  });

  it("names every currency amount that makes a cross-currency order unpriceable", () => {
    const offer = makeOffer({
      currency: "USD",
      payoutType: "flat",
      payoutValue: 1_000,
      tiers: [{ id: "t", offerId: "offer_1", minVolumeCents: 50_000, rate: 0.25 }],
      bonuses: [{ id: "b", offerId: "offer_1", triggerType: "first_sale", threshold: 1, amountCents: 5_000 }],
      overridePolicy: { id: "op", offerId: "offer_1", structure: "flat", value: 250, trigger: "per_sale", maxDepth: 1 },
      rules: [{ kind: "max_commission_cents", value: 10_000 }],
    });
    const issue = currencyPricingIssue(jpyOrder, offer)!;
    expect(issue).toContain("JPY");
    expect(issue).toContain("USD");
    for (const part of ["flat payout", "volume tiers", "bonuses", "flat recruiter override", "max_commission_cents"]) expect(issue).toContain(part);
    expect(currencyPricingIssue(makeOrder({ currency: "usd" }), offer)).toBeNull(); // same currency, any case
  });

  it("the engine refuses to emit a USD flat fee or bonus as yen", () => {
    const flat = makeOffer({ currency: "USD", payoutType: "flat", payoutValue: 1_000 });
    expect(() => engine.onOrder(makeOnOrderContext({ order: jpyOrder, offer: flat }))).toThrow(MoneyError);
    const withBonus = makeOffer({ currency: "USD", bonuses: [{ id: "b", offerId: "offer_1", triggerType: "first_sale", threshold: 1, amountCents: 5_000 }] });
    expect(() => engine.onOrder(makeOnOrderContext({ order: jpyOrder, offer: withBonus }))).toThrow(/cannot price/);
  });
});

describe("a stored rate outside 0..1 is never paid", () => {
  it("refuses an offer rate, a negotiated rate, a tier, a category rate and an override above 100%", () => {
    const price = (overrides: Parameters<typeof makeOnOrderContext>[0]) => () => engine.onOrder(makeOnOrderContext(overrides));
    expect(price({ offer: makeOffer({ payoutValue: 20 }) })).toThrow(/between 0 and 1/);
    expect(price({ relationship: makeRelationship({ commissionTerms: { rate: 5 } }) })).toThrow(MoneyError);
    expect(price({ offer: makeOffer({ tiers: [{ id: "t", offerId: "offer_1", minVolumeCents: 0, rate: 15 }] }) })).toThrow(MoneyError);
    expect(
      price({
        offer: makeOffer({ rules: [{ kind: "category_rate", category: "widgets", rate: 3 }] }),
        order: makeOrder({ lineItems: [{ sku: "W", category: "widgets", quantity: 1, amountCents: 10_000 }] }),
      }),
    ).toThrow(MoneyError);
    expect(
      price({
        offer: makeOffer({ overridePolicy: { id: "op", offerId: "offer_1", structure: "percentage", value: 2, trigger: "per_sale", maxDepth: 1 } }),
        sponsorRelationship: makeRelationship({ id: "rel_r", affiliateId: "aff_r", role: "recruiter" }),
      }),
    ).toThrow(MoneyError);
    // The boundary values are fine.
    expect(engine.onOrder(makeOnOrderContext({ offer: makeOffer({ payoutValue: 1 }) }))[0]!.amount.amountCents).toBe(10_000);
  });
});
