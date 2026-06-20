import type {
  Offer,
  Order,
  AffiliateRelationship,
  OnOrderContext,
} from "../src/index.js";

let seq = 0;
const id = (p: string) => `${p}_${(seq += 1)}`;

export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer_1",
    merchantId: "merch_1",
    programId: "prog_1",
    engine: "affiliate",
    name: "Default offer",
    payoutType: "percentage",
    payoutValue: 0.2, // 20%
    currency: "USD",
    windowDays: 30,
    rules: [],
    tiers: [],
    bonuses: [],
    overridePolicy: null,
    status: "active",
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  const amount = overrides.amountCents ?? 10_000; // $100
  return {
    id: id("order"),
    merchantId: "merch_1",
    customerId: id("cust"),
    amountCents: amount,
    currency: "USD",
    txnId: id("txn"),
    ts: "2026-06-01T12:00:00.000Z",
    lineItems: [],
    couponCodes: [],
    isNewCustomer: true,
    isRebill: false,
    subtotalCents: amount,
    discountCents: 0,
    taxCents: 0,
    shippingCents: 0,
    country: "US",
    ...overrides,
  };
}

export function makeRelationship(overrides: Partial<AffiliateRelationship> = {}): AffiliateRelationship {
  return {
    id: "rel_seller",
    affiliateId: "aff_seller",
    merchantId: "merch_1",
    programId: "prog_1",
    status: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
    role: "seller",
    commissionTerms: null,
    source: "inbound",
    ownerUserId: null,
    tags: [],
    sponsorAffiliateId: null,
    prospectId: null,
    ...overrides,
  };
}

export function makeOnOrderContext(overrides: Partial<OnOrderContext> = {}): OnOrderContext {
  const order = overrides.order ?? makeOrder();
  const offer = overrides.offer ?? makeOffer();
  const relationship = overrides.relationship ?? makeRelationship();
  return {
    order,
    attribution: {
      affiliateId: relationship.affiliateId,
      offerId: offer.id,
      mechanism: "link",
      clickId: "click_1",
      codeId: null,
      relationshipId: relationship.id,
      sponsorAffiliateId: relationship.sponsorAffiliateId,
    },
    conversionId: "conv_1",
    offer,
    relationship,
    sponsorRelationship: null,
    priorVolumeCents: 0,
    priorConversionCount: 0,
    isFirstConversionForAffiliate: true,
    isFirstSaleUnderSponsor: true,
    now: new Date("2026-06-01T12:00:01.000Z"),
    ...overrides,
  };
}
