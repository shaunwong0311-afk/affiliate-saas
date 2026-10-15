import { createHash } from "node:crypto";
import { newId } from "@affiliate/core";
import type { Order, OrderLineItem } from "@affiliate/core";
import { verifyPostback, type PostbackPayload } from "@affiliate/core";
import type { IngestionInput, NormalizedOrder, OrderNormalizer } from "../ports.js";

/**
 * The single ingestion path (Section 4): normalize "an order happened, amount X,
 * attributed to entity Y" from Shopify, WooCommerce, Stripe, and signed S2S
 * postbacks into a core Order. Both the affiliate engine and a future MLM engine
 * consume from here, so this is the one place provider quirks are absorbed.
 *
 * Nothing leaves this module unless it is a well-formed order: whole, non-negative
 * minor units, a 3-letter currency, a real timestamp, a transaction id. A payload that
 * is not is rejected HERE, before anything is written — a half-number such as 1999.5
 * used to get as far as a stored order and conversion before the money code threw.
 */

/** The payload is not a usable order. Carries an HTTP status so it answers 400, not 500. */
export class InvalidOrderError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_order";
  constructor(message: string) {
    super(`invalid order payload: ${message}`);
    this.name = "InvalidOrderError";
  }
}

/**
 * A normalized order plus the buyer's email as a SHA-256 hash (lower-cased, trimmed) when
 * the feed carried one. The raw address never leaves this module; the hash is what the
 * self-referral check compares with the affiliate's own.
 */
export interface NormalizedOrderWithBuyer extends NormalizedOrder {
  customerEmailHash?: string | null;
}

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

const emailHashOf = (value: unknown): string | null =>
  typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) ? hashEmail(value) : null;

/**
 * A decimal amount in major units ("19.99", 19.99) as whole minor units, exactly: parsed
 * digit by digit, half-up on the third decimal. No float multiplication (parseFloat × 100
 * is off by a cent for some prices) and no NaN (a non-numeric string became NaN cents).
 */
function dollarsToCents(v: string | number | undefined | null, field = "amount"): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number" && !Number.isFinite(v)) throw new InvalidOrderError(`${field} is not a number`);
  const text = (typeof v === "number" && (Math.abs(v) < 1e-6 || Math.abs(v) >= 1e21) ? v.toFixed(6) : String(v)).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new InvalidOrderError(`${field} is not a decimal amount: ${JSON.stringify(v)}`);
  const fraction = (m[3] ?? "").padEnd(3, "0");
  let cents = BigInt(m[2]!) * 100n + BigInt(fraction.slice(0, 2));
  if (fraction.charCodeAt(2) >= 53 /* "5" */) cents += 1n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidOrderError(`${field} is too large`);
  return (m[1] === "-" ? -1 : 1) * Number(cents);
}

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The gate every normalizer's output passes: the money code downstream assumes all of this. */
function assertValidOrder(order: Order): Order {
  if (typeof order.txnId !== "string" || order.txnId.trim() === "") throw new InvalidOrderError("missing transaction id");
  if (order.txnId.length > 200) throw new InvalidOrderError("transaction id is longer than 200 characters");
  if (typeof order.currency !== "string" || !/^[A-Z]{3}$/.test(order.currency)) {
    throw new InvalidOrderError(`currency must be a 3-letter ISO-4217 code, got ${JSON.stringify(order.currency)}`);
  }
  for (const field of ["amountCents", "subtotalCents", "discountCents", "taxCents", "shippingCents"] as const) {
    if (!isCents(order[field])) {
      throw new InvalidOrderError(`${field} must be a whole, non-negative number of minor units, got ${JSON.stringify(order[field])}`);
    }
  }
  if (typeof order.ts !== "string" || Number.isNaN(new Date(order.ts).getTime())) throw new InvalidOrderError("order timestamp is not a date");
  order.ts = new Date(order.ts).toISOString();
  for (const li of order.lineItems) {
    if (!isCents(li.amountCents)) {
      throw new InvalidOrderError(`line item amount must be a whole, non-negative number of minor units, got ${JSON.stringify(li.amountCents)}`);
    }
    if (!Number.isSafeInteger(li.quantity) || li.quantity < 0) {
      throw new InvalidOrderError(`line item quantity must be a whole number, got ${JSON.stringify(li.quantity)}`);
    }
  }
  if (!Array.isArray(order.couponCodes) || order.couponCodes.some((c) => typeof c !== "string")) {
    throw new InvalidOrderError("coupon codes must be strings");
  }
  return order;
}

function optionalString(v: unknown, field: string, max = 200): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || v.length > max) throw new InvalidOrderError(`${field} must be a string of at most ${max} characters`);
  return v;
}

function baseOrder(merchantId: string, txnId: string, amountCents: number, currency: string): Order {
  return {
    id: newId("order"),
    merchantId,
    customerId: null,
    amountCents,
    currency: typeof currency === "string" ? currency.trim().toUpperCase() : currency,
    txnId,
    ts: new Date().toISOString(),
    lineItems: [],
    couponCodes: [],
    isNewCustomer: false,
    isRebill: false,
    subtotalCents: amountCents,
    discountCents: 0,
    taxCents: 0,
    shippingCents: 0,
    country: null,
  };
}

// ---- Shopify ----------------------------------------------------------------
interface ShopifyOrder {
  id: number | string;
  current_total_price?: string;
  total_price?: string;
  /** After discounts, before tax and shipping. */
  subtotal_price?: string;
  /** Sum of the line item prices — before discounts. */
  total_line_items_price?: string;
  total_discounts?: string;
  total_tax?: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  currency: string;
  created_at?: string;
  email?: string;
  contact_email?: string;
  customer?: { id?: number | string; orders_count?: number; email?: string };
  shipping_address?: { country_code?: string };
  discount_codes?: Array<{ code: string }>;
  line_items?: Array<{ sku?: string; product_type?: string; quantity?: number; price?: string }>;
  note_attributes?: Array<{ name: string; value: string }>;
  financial_status?: string;
}

export const shopifyNormalizer: OrderNormalizer = {
  source: "shopify",
  normalize(input: IngestionInput): NormalizedOrder | null {
    const raw = input.raw as ShopifyOrder;
    if (!raw || raw.id == null) return null;

    const total = dollarsToCents(raw.current_total_price ?? raw.total_price, "total_price");
    const order = baseOrder(input.merchantId, `shopify_${raw.id}`, total, raw.currency ?? "USD");
    order.ts = raw.created_at ?? order.ts;
    order.discountCents = dollarsToCents(raw.total_discounts, "total_discounts");
    order.taxCents = dollarsToCents(raw.total_tax, "total_tax");
    order.shippingCents = dollarsToCents(raw.total_shipping_price_set?.shop_money?.amount, "shipping");
    // Order.subtotalCents is merchandise BEFORE discounts. Shopify's `subtotal_price` is
    // AFTER them (it used to be stored as-is, so a net-of-discount commission took the
    // discount off twice); `total_line_items_price` is the pre-discount figure.
    order.subtotalCents =
      raw.total_line_items_price != null
        ? dollarsToCents(raw.total_line_items_price, "total_line_items_price")
        : raw.subtotal_price != null
          ? dollarsToCents(raw.subtotal_price, "subtotal_price") + order.discountCents
          : Math.max(0, total - order.taxCents - order.shippingCents + order.discountCents);
    order.country = raw.shipping_address?.country_code ?? null;
    order.couponCodes = (raw.discount_codes ?? []).map((d) => d.code);
    order.isNewCustomer = (raw.customer?.orders_count ?? 1) <= 1;
    order.lineItems = (raw.line_items ?? []).map(
      (li): OrderLineItem => ({
        sku: li.sku ?? "",
        category: li.product_type ?? null,
        quantity: li.quantity ?? 1,
        amountCents: dollarsToCents(li.price, "line item price") * (li.quantity ?? 1),
      }),
    );

    const clickId = raw.note_attributes?.find((n) => n.name === "click_id" || n.name === "aff_click")?.value ?? null;
    const normalized: NormalizedOrderWithBuyer = {
      order: assertValidOrder(order),
      clickId: optionalString(clickId, "click id"),
      customerRef: raw.customer?.id != null ? String(raw.customer.id) : null,
      customerEmailHash: emailHashOf(raw.email ?? raw.contact_email ?? raw.customer?.email),
    };
    return normalized;
  },
};

// ---- WooCommerce ------------------------------------------------------------
interface WooOrder {
  id: number | string;
  total?: string;
  subtotal?: string;
  discount_total?: string;
  total_tax?: string;
  shipping_total?: string;
  currency: string;
  date_created?: string;
  customer_id?: number;
  billing?: { country?: string; email?: string };
  coupon_lines?: Array<{ code: string }>;
  line_items?: Array<{ sku?: string; quantity?: number; total?: string }>;
  meta_data?: Array<{ key: string; value: string }>;
}

export const wooNormalizer: OrderNormalizer = {
  source: "woocommerce",
  normalize(input: IngestionInput): NormalizedOrder | null {
    const raw = input.raw as WooOrder;
    if (!raw || raw.id == null) return null;

    const total = dollarsToCents(raw.total, "total");
    const order = baseOrder(input.merchantId, `woo_${raw.id}`, total, raw.currency ?? "USD");
    order.ts = raw.date_created ?? order.ts;
    order.discountCents = dollarsToCents(raw.discount_total, "discount_total");
    order.taxCents = dollarsToCents(raw.total_tax, "total_tax");
    order.shippingCents = dollarsToCents(raw.shipping_total, "shipping_total");
    // A WooCommerce order has no order-level subtotal; derive the pre-discount merchandise
    // value from the parts it does report (this used to fall back to the grand total).
    order.subtotalCents =
      raw.subtotal != null && raw.subtotal !== ""
        ? dollarsToCents(raw.subtotal, "subtotal")
        : Math.max(0, total - order.taxCents - order.shippingCents + order.discountCents);
    order.country = raw.billing?.country ?? null;
    order.couponCodes = (raw.coupon_lines ?? []).map((c) => c.code);
    order.isNewCustomer = (raw.customer_id ?? 0) === 0;
    order.lineItems = (raw.line_items ?? []).map(
      (li): OrderLineItem => ({
        sku: li.sku ?? "",
        category: null,
        quantity: li.quantity ?? 1,
        amountCents: dollarsToCents(li.total, "line item total"),
      }),
    );
    const clickId = raw.meta_data?.find((m) => m.key === "click_id" || m.key === "_aff_click")?.value ?? null;
    const normalized: NormalizedOrderWithBuyer = {
      order: assertValidOrder(order),
      clickId: optionalString(clickId, "click id"),
      customerRef: raw.customer_id != null ? String(raw.customer_id) : null,
      customerEmailHash: emailHashOf(raw.billing?.email),
    };
    return normalized;
  },
};

// ---- Stripe -----------------------------------------------------------------
interface StripeEvent {
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      amount_total?: number;
      amount_paid?: number;
      currency?: string;
      /** An id, or the expanded customer object. */
      customer?: string | { id?: string } | null;
      customer_email?: string | null;
      customer_details?: { email?: string | null } | null;
      receipt_email?: string | null;
      created?: number;
      metadata?: Record<string, string>;
      billing_reason?: string; // invoice rebill detection
      discount?: { coupon?: { id?: string } } | null;
    };
  };
}

export const stripeNormalizer: OrderNormalizer = {
  source: "stripe",
  normalize(input: IngestionInput): NormalizedOrder | null {
    const event = input.raw as StripeEvent;
    if (!event?.type) return null;
    // Only treat completed payments / paid invoices as orders.
    const isOrderEvent =
      event.type === "checkout.session.completed" ||
      event.type === "payment_intent.succeeded" ||
      event.type === "invoice.paid";
    if (!isOrderEvent) return null;

    const obj = event.data?.object;
    if (!obj || obj.id == null) throw new InvalidOrderError("stripe event has no data.object.id");
    const amount = obj.amount_total ?? obj.amount_paid ?? obj.amount ?? 0;
    const order = baseOrder(input.merchantId, `stripe_${obj.id}`, amount, obj.currency ?? "usd");
    if (obj.created) order.ts = new Date(obj.created * 1000).toISOString();
    order.subtotalCents = amount;
    order.isRebill = event.type === "invoice.paid" && obj.billing_reason === "subscription_cycle";
    if (obj.discount?.coupon?.id) order.couponCodes = [obj.discount.coupon.id];
    const clickId = obj.metadata?.click_id ?? obj.metadata?.aff_click ?? null;
    const normalized: NormalizedOrderWithBuyer = {
      order: assertValidOrder(order),
      clickId: optionalString(clickId, "click id"),
      customerRef: optionalString(typeof obj.customer === "object" ? obj.customer?.id : obj.customer, "customer"),
      customerEmailHash: emailHashOf(obj.customer_details?.email ?? obj.customer_email ?? obj.receipt_email),
    };
    return normalized;
  },
};

// ---- Signed server-to-server postback (Section 6) --------------------------
/** The signature is missing, wrong, or too old. Carries an HTTP status so it answers 401, not 500. */
export class PostbackVerificationError extends Error {
  readonly statusCode = 401;
  readonly code = "postback_unverified";
  constructor(public readonly reason: string) {
    super(`postback verification failed: ${reason}`);
    this.name = "PostbackVerificationError";
  }
}

/**
 * Check the shape of a postback body and return ONLY its known fields. Run before the
 * signature is verified (the signature is computed over these fields, and a non-string
 * currency would crash the canonicalizer) and before anything is stored.
 */
export function parsePostbackPayload(raw: unknown): PostbackPayload {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidOrderError("body must be a JSON object");
  const r = raw as Record<string, unknown>;
  const required = (field: string, max = 200): string => {
    const v = r[field];
    if (typeof v !== "string" || v.trim() === "" || v.length > max) {
      throw new InvalidOrderError(`${field} must be a non-empty string of at most ${max} characters`);
    }
    return v;
  };
  const amountCents = r["amountCents"];
  if (!isCents(amountCents)) {
    throw new InvalidOrderError(
      `amountCents must be a whole, non-negative number of minor units (1999, not 19.99 or 1999.5), got ${JSON.stringify(amountCents)}`,
    );
  }
  const currency = required("currency", 3);
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new InvalidOrderError(`currency must be a 3-letter ISO-4217 code, got ${JSON.stringify(currency)}`);
  const ts = r["ts"];
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) throw new InvalidOrderError("ts must be a Unix time in whole seconds");
  const couponCodes = r["couponCodes"];
  if (
    couponCodes != null &&
    (!Array.isArray(couponCodes) || couponCodes.length > 50 || couponCodes.some((c) => typeof c !== "string" || c.length > 100))
  ) {
    throw new InvalidOrderError("couponCodes must be an array of at most 50 strings");
  }
  return {
    merchantId: required("merchantId"),
    txnId: required("txnId"),
    amountCents,
    currency,
    clickId: optionalString(r["clickId"], "clickId"),
    couponCodes: (couponCodes as string[] | null | undefined) ?? [],
    customerRef: optionalString(r["customerRef"], "customerRef"),
    ts,
  };
}

/**
 * The robust conversion path. Verifies the HMAC signature with the per-merchant
 * secret BEFORE accepting the order — an open endpoint is how these systems get
 * drained by forged conversions.
 */
export const s2sNormalizer: OrderNormalizer = {
  source: "s2s",
  normalize(input: IngestionInput): NormalizedOrder | null {
    if (!(input.raw as { txnId?: unknown } | null)?.txnId) return null;
    const payload = parsePostbackPayload(input.raw);
    if (payload.merchantId !== input.merchantId) {
      throw new InvalidOrderError("merchantId in the body does not match the merchant this postback was sent to");
    }
    if (!input.secret || !input.signature) {
      throw new PostbackVerificationError("missing signature or secret");
    }
    const verdict = verifyPostback(payload, input.signature, input.secret);
    if (!verdict.ok) throw new PostbackVerificationError(verdict.reason);

    const order = baseOrder(input.merchantId, payload.txnId, payload.amountCents, payload.currency);
    order.ts = new Date(payload.ts * 1000).toISOString();
    order.subtotalCents = payload.amountCents;
    order.couponCodes = payload.couponCodes ?? [];
    const normalized: NormalizedOrderWithBuyer = {
      order: assertValidOrder(order),
      clickId: payload.clickId ?? null,
      customerRef: payload.customerRef ?? null,
      // Many merchants pass the buyer's email as the customer reference (it is signed).
      customerEmailHash: emailHashOf(payload.customerRef),
    };
    return normalized;
  },
};

export const NORMALIZERS: Record<string, OrderNormalizer> = {
  shopify: shopifyNormalizer,
  woocommerce: wooNormalizer,
  stripe: stripeNormalizer,
  s2s: s2sNormalizer,
};

export function normalizeOrder(source: string, input: IngestionInput): NormalizedOrderWithBuyer | null {
  const normalizer = NORMALIZERS[source];
  if (!normalizer) throw new Error(`no order normalizer for source "${source}"`);
  return normalizer.normalize(input);
}
