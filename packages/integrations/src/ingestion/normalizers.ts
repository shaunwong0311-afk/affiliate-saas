import { newId } from "@affiliate/core";
import type { Order, OrderLineItem } from "@affiliate/core";
import { verifyPostback, type PostbackPayload } from "@affiliate/core";
import type { IngestionInput, NormalizedOrder, OrderNormalizer } from "../ports.js";

/**
 * The single ingestion path (Section 4): normalize "an order happened, amount X,
 * attributed to entity Y" from Shopify, WooCommerce, Stripe, and signed S2S
 * postbacks into a core Order. Both the affiliate engine and a future MLM engine
 * consume from here, so this is the one place provider quirks are absorbed.
 */

function dollarsToCents(v: string | number | undefined | null): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Math.round(n * 100);
}

function baseOrder(merchantId: string, txnId: string, amountCents: number, currency: string): Order {
  return {
    id: newId("order"),
    merchantId,
    customerId: null,
    amountCents,
    currency: currency.toUpperCase(),
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
  subtotal_price?: string;
  total_discounts?: string;
  total_tax?: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  currency: string;
  created_at?: string;
  customer?: { id?: number | string; orders_count?: number };
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

    const total = dollarsToCents(raw.current_total_price ?? raw.total_price);
    const order = baseOrder(input.merchantId, `shopify_${raw.id}`, total, raw.currency ?? "USD");
    order.ts = raw.created_at ?? order.ts;
    order.subtotalCents = dollarsToCents(raw.subtotal_price) || total;
    order.discountCents = dollarsToCents(raw.total_discounts);
    order.taxCents = dollarsToCents(raw.total_tax);
    order.shippingCents = dollarsToCents(raw.total_shipping_price_set?.shop_money?.amount);
    order.country = raw.shipping_address?.country_code ?? null;
    order.couponCodes = (raw.discount_codes ?? []).map((d) => d.code);
    order.isNewCustomer = (raw.customer?.orders_count ?? 1) <= 1;
    order.lineItems = (raw.line_items ?? []).map(
      (li): OrderLineItem => ({
        sku: li.sku ?? "",
        category: li.product_type ?? null,
        quantity: li.quantity ?? 1,
        amountCents: dollarsToCents(li.price) * (li.quantity ?? 1),
      }),
    );

    const clickId = raw.note_attributes?.find((n) => n.name === "click_id" || n.name === "aff_click")?.value ?? null;
    return { order, clickId, customerRef: raw.customer?.id != null ? String(raw.customer.id) : null };
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
  billing?: { country?: string };
  coupon_lines?: Array<{ code: string }>;
  line_items?: Array<{ sku?: string; quantity?: number; total?: string }>;
  meta_data?: Array<{ key: string; value: string }>;
}

export const wooNormalizer: OrderNormalizer = {
  source: "woocommerce",
  normalize(input: IngestionInput): NormalizedOrder | null {
    const raw = input.raw as WooOrder;
    if (!raw || raw.id == null) return null;

    const total = dollarsToCents(raw.total);
    const order = baseOrder(input.merchantId, `woo_${raw.id}`, total, raw.currency ?? "USD");
    order.ts = raw.date_created ?? order.ts;
    order.subtotalCents = dollarsToCents(raw.subtotal) || total;
    order.discountCents = dollarsToCents(raw.discount_total);
    order.taxCents = dollarsToCents(raw.total_tax);
    order.shippingCents = dollarsToCents(raw.shipping_total);
    order.country = raw.billing?.country ?? null;
    order.couponCodes = (raw.coupon_lines ?? []).map((c) => c.code);
    order.isNewCustomer = (raw.customer_id ?? 0) === 0;
    order.lineItems = (raw.line_items ?? []).map(
      (li): OrderLineItem => ({
        sku: li.sku ?? "",
        category: null,
        quantity: li.quantity ?? 1,
        amountCents: dollarsToCents(li.total),
      }),
    );
    const clickId = raw.meta_data?.find((m) => m.key === "click_id" || m.key === "_aff_click")?.value ?? null;
    return { order, clickId, customerRef: raw.customer_id != null ? String(raw.customer_id) : null };
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
      customer?: string;
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

    const obj = event.data.object;
    const amount = obj.amount_total ?? obj.amount_paid ?? obj.amount ?? 0;
    const order = baseOrder(input.merchantId, `stripe_${obj.id}`, amount, obj.currency ?? "usd");
    if (obj.created) order.ts = new Date(obj.created * 1000).toISOString();
    order.subtotalCents = amount;
    order.isRebill = event.type === "invoice.paid" && obj.billing_reason === "subscription_cycle";
    if (obj.discount?.coupon?.id) order.couponCodes = [obj.discount.coupon.id];
    const clickId = obj.metadata?.click_id ?? obj.metadata?.aff_click ?? null;
    return { order, clickId, customerRef: obj.customer ?? null };
  },
};

// ---- Signed server-to-server postback (Section 6) --------------------------
export class PostbackVerificationError extends Error {
  constructor(public readonly reason: string) {
    super(`postback verification failed: ${reason}`);
    this.name = "PostbackVerificationError";
  }
}

/**
 * The robust conversion path. Verifies the HMAC signature with the per-merchant
 * secret BEFORE accepting the order — an open endpoint is how these systems get
 * drained by forged conversions.
 */
export const s2sNormalizer: OrderNormalizer = {
  source: "s2s",
  normalize(input: IngestionInput): NormalizedOrder | null {
    const payload = input.raw as PostbackPayload;
    if (!payload?.txnId) return null;
    if (!input.secret || !input.signature) {
      throw new PostbackVerificationError("missing signature or secret");
    }
    const verdict = verifyPostback(payload, input.signature, input.secret);
    if (!verdict.ok) throw new PostbackVerificationError(verdict.reason);

    const order = baseOrder(input.merchantId, payload.txnId, payload.amountCents, payload.currency);
    order.ts = new Date(payload.ts * 1000).toISOString();
    order.subtotalCents = payload.amountCents;
    order.couponCodes = payload.couponCodes ?? [];
    return { order, clickId: payload.clickId ?? null, customerRef: payload.customerRef ?? null };
  },
};

export const NORMALIZERS: Record<string, OrderNormalizer> = {
  shopify: shopifyNormalizer,
  woocommerce: wooNormalizer,
  stripe: stripeNormalizer,
  s2s: s2sNormalizer,
};

export function normalizeOrder(source: string, input: IngestionInput): NormalizedOrder | null {
  const normalizer = NORMALIZERS[source];
  if (!normalizer) throw new Error(`no order normalizer for source "${source}"`);
  return normalizer.normalize(input);
}
