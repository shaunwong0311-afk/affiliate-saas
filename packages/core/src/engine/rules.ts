import { MoneyError, allocateCents, proRateCents } from "../money.js";
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
  // The whole order's commissionable amount under the chosen basis…
  const orderBaseCents = applyBasis(order, basis);
  if (orderBaseCents <= 0) return empty("commissionable base is zero");

  const categoryBaseCents = new Map<string | null, number>();
  if (order.lineItems.length === 0) {
    categoryBaseCents.set(null, orderBaseCents);
    return { eligible: true, reason: "ok", baseCents: orderBaseCents, categoryBaseCents };
  }

  // …then, with line items, the share of it that the eligible lines make up. A share of the
  // lines' own total is the only ratio that is safe to take: line amounts are merchandise
  // prices, while the order figure may include tax and shipping or exclude discounts, so
  // dividing one by the other (as this did) mixes units and shrinks or inflates the base.
  const lineSum = order.lineItems.reduce((s, li) => s + li.amountCents, 0);
  const eligibleSum = eligibleLines.reduce((s, li) => s + li.amountCents, 0);
  if (eligibleSum <= 0 || lineSum <= 0) return empty("no commissionable line items after SKU filtering");
  // Never more than the whole order (negative lines could otherwise push the share past 1).
  const baseCents = proRateCents(orderBaseCents, Math.min(eligibleSum, lineSum), lineSum);
  if (baseCents <= 0) return empty("commissionable base is zero");

  // Per-category bases that add up to the base exactly (for category rates).
  const byCategory = new Map<string | null, number>();
  for (const li of eligibleLines) byCategory.set(li.category, (byCategory.get(li.category) ?? 0) + li.amountCents);
  const categories = [...byCategory.entries()].filter(([, sum]) => sum > 0);
  const shares = allocateCents(baseCents, categories.map(([, sum]) => sum));
  categories.forEach(([category], i) => categoryBaseCents.set(category, shares[i]!));

  return { eligible: true, reason: "ok", baseCents, categoryBaseCents };
}

/** The order-level commissionable amount for a basis — see CommissionableBasis. */
function applyBasis(order: Order, basis: CommissionableBasis): number {
  switch (basis) {
    case "gross":
      return order.amountCents;
    case "net_of_discount":
      return order.subtotalCents - order.discountCents;
    case "net_of_tax_shipping":
      return order.amountCents - order.taxCents - order.shippingCents;
  }
}

/**
 * A percentage must be a share of the base: 0..1. Anything else is a configuration error
 * (20 instead of 0.2 turns a $100 sale into a $2,000 commission), so pricing stops instead
 * of paying it. The API validates this on the way in; this is the last line of defence for
 * rows that were stored before it did.
 */
export function assertCommissionRate(rate: number, what: string): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new MoneyError(`${what} must be a decimal between 0 and 1 (0.2 = 20%), got ${rate}`);
  }
}

/**
 * Every amount in an offer — flat payout, tier thresholds, bonuses, caps, a flat recruiter
 * override — is in the OFFER's currency, and there is no FX here. An order in another
 * currency can therefore only be priced when the offer is a plain percentage, which is the
 * same number in any currency. Returns why the order cannot be priced, or null when it can.
 */
export function currencyPricingIssue(order: Pick<Order, "currency">, offer: Offer): string | null {
  const orderCurrency = order.currency.toUpperCase();
  const offerCurrency = offer.currency.toUpperCase();
  if (orderCurrency === offerCurrency) return null;
  const amounts: string[] = [];
  if (offer.payoutType === "flat") amounts.push("flat payout");
  if (offer.tiers.length > 0) amounts.push("volume tiers");
  if (offer.bonuses.length > 0) amounts.push("bonuses");
  if (offer.overridePolicy?.structure === "flat") amounts.push("flat recruiter override");
  for (const r of offer.rules) {
    if (r.kind === "min_order_cents" || r.kind === "max_commission_cents" || r.kind === "manual_review_over_cents") {
      amounts.push(r.kind);
    }
  }
  if (amounts.length === 0) return null;
  return `order is in ${orderCurrency} but the offer's amounts (${amounts.join(", ")}) are in ${offerCurrency}`;
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
