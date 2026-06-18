import type { Order } from "../types/orders.js";
import type { Offer, OfferRule, CommissionableBasis } from "../types/program.js";

export interface BaseComputation {
  /** False when a hard rule disqualifies the order entirely (geo, first-order, etc). */
  eligible: boolean;
  reason: string;
  /** The commissionable amount in cents after basis + SKU filtering. */
  baseCents: number;
  /** Per-line-item commissionable amounts keyed by category, for category rates. */
  categoryBaseCents: Map<string | null, number>;
}

function rule<T extends OfferRule["kind"]>(
  offer: Offer,
  kind: T,
): Extract<OfferRule, { kind: T }> | undefined {
  return offer.rules.find((r) => r.kind === kind) as Extract<OfferRule, { kind: T }> | undefined;
}

function allRules<T extends OfferRule["kind"]>(
  offer: Offer,
  kind: T,
): Extract<OfferRule, { kind: T }>[] {
  return offer.rules.filter((r) => r.kind === kind) as Extract<OfferRule, { kind: T }>[];
}

/**
 * Resolve the commissionable base from an order per the offer's guardrails
 * (Section 7): commissionable-subtotal definition, SKU include/exclude, geo,
 * first-order / new-customer gating, minimum order, excluded coupons, recurring.
 */
export function computeCommissionableBase(
  order: Order,
  offer: Offer,
  ctx: { isFirstConversionForAffiliate: boolean },
): BaseComputation {
  const empty = (reason: string): BaseComputation => ({
    eligible: false,
    reason,
    baseCents: 0,
    categoryBaseCents: new Map(),
  });

  // Recurring gate: if the order is a rebill but the offer doesn't pay recurring, skip.
  if (order.isRebill && !rule(offer, "recurring")) {
    return empty("rebill but offer is not recurring");
  }

  // first-order-only / new-customer-only
  if (rule(offer, "first_order_only") && !ctx.isFirstConversionForAffiliate) {
    // first_order_only is keyed on the customer's first order — modeled via isNewCustomer.
    if (!order.isNewCustomer) return empty("first_order_only: not the customer's first order");
  }
  if (rule(offer, "new_customer_only") && !order.isNewCustomer) {
    return empty("new_customer_only: returning customer");
  }

  // geo allow / block
  const allow = rule(offer, "geo_allow");
  if (allow && order.country && !allow.countries.includes(order.country)) {
    return empty(`geo_allow: ${order.country} not allowed`);
  }
  const block = rule(offer, "geo_block");
  if (block && order.country && block.countries.includes(order.country)) {
    return empty(`geo_block: ${order.country} blocked`);
  }

  // excluded coupons
  const excludedCoupons = rule(offer, "excluded_coupons");
  if (excludedCoupons && order.couponCodes.some((c) => excludedCoupons.codes.includes(c))) {
    return empty("excluded_coupons: order used an excluded coupon");
  }

  // minimum order
  const minOrder = rule(offer, "min_order_cents");
  if (minOrder && order.amountCents < minOrder.value) {
    return empty(`min_order_cents: ${order.amountCents} < ${minOrder.value}`);
  }

  // SKU include/exclude — restrict commissionable line items.
  const include = rule(offer, "sku_include");
  const exclude = rule(offer, "sku_exclude");
  const eligibleLines = order.lineItems.filter((li) => {
    if (include && !include.skus.includes(li.sku)) return false;
    if (exclude && exclude.skus.includes(li.sku)) return false;
    return true;
  });

  const basis = rule(offer, "commissionable_basis")?.basis ?? "gross";
  const hasLineItems = order.lineItems.length > 0;

  let baseCents: number;
  const categoryBaseCents = new Map<string | null, number>();

  if (hasLineItems) {
    // Sum eligible line items, then scale by the basis ratio derived from the order.
    const eligibleSum = eligibleLines.reduce((s, li) => s + li.amountCents, 0);
    if (eligibleSum <= 0) return empty("no commissionable line items after SKU filtering");
    const ratio = basisRatio(order, basis);
    baseCents = Math.round(eligibleSum * ratio);
    for (const li of eligibleLines) {
      const liBase = Math.round(li.amountCents * ratio);
      categoryBaseCents.set(li.category, (categoryBaseCents.get(li.category) ?? 0) + liBase);
    }
  } else {
    baseCents = applyBasis(order, basis);
    categoryBaseCents.set(null, baseCents);
  }

  if (baseCents <= 0) return empty("commissionable base is zero");

  return { eligible: true, reason: "ok", baseCents, categoryBaseCents };
}

function applyBasis(order: Order, basis: CommissionableBasis): number {
  switch (basis) {
    case "gross":
      return order.amountCents;
    case "net_of_discount":
      return order.subtotalCents - order.discountCents;
    case "net_of_tax_shipping":
      return order.subtotalCents - order.discountCents; // already excludes tax/shipping
  }
}

function basisRatio(order: Order, basis: CommissionableBasis): number {
  const gross = order.amountCents || 1;
  return applyBasis(order, basis) / gross;
}

export interface RateSelection {
  rate: number;
  source: string; // 'offer' | 'relationship' | 'tier' | 'time_boost'
}

/**
 * Select the effective percentage rate: offer base → relationship override →
 * volume tier (highest qualified) → active time-boost. Later sources win.
 */
export function selectRate(
  offer: Offer,
  priorVolumeCents: number,
  relationshipRate: number | undefined,
  now: Date,
): RateSelection {
  let rate = offer.payoutType === "percentage" ? offer.payoutValue : 0;
  let source = "offer";

  if (typeof relationshipRate === "number") {
    rate = relationshipRate;
    source = "relationship";
  }

  // Volume tiers: pick the highest tier whose threshold is met by prior volume.
  const qualifiedTier = [...offer.tiers]
    .filter((t) => priorVolumeCents >= t.minVolumeCents)
    .sort((a, b) => b.minVolumeCents - a.minVolumeCents)[0];
  if (qualifiedTier) {
    rate = qualifiedTier.rate;
    source = "tier";
  }

  // Active time-limited boost takes precedence while it is live.
  const boost = allRules(offer, "time_boost").find((b) => {
    const start = new Date(b.startsAt).getTime();
    const end = new Date(b.endsAt).getTime();
    const t = now.getTime();
    return t >= start && t <= end;
  });
  if (boost && boost.rate > rate) {
    rate = boost.rate;
    source = "time_boost";
  }

  return { rate, source };
}

export function categoryRateFor(offer: Offer, category: string | null): number | undefined {
  if (category == null) return undefined;
  return allRules(offer, "category_rate").find((r) => r.category === category)?.rate;
}

export function maxCommissionCents(offer: Offer): number | undefined {
  return rule(offer, "max_commission_cents")?.value;
}
