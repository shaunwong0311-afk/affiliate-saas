import type { Id, Timestamp } from "./common.js";
import type { CurrencyCode } from "../money.js";

/** A normalized order from any source (Shopify, Woo, Stripe, S2S) — Section 4. */
export interface Order {
  readonly id: Id;
  readonly merchantId: Id;
  customerId: Id | null;
  amountCents: number;
  currency: CurrencyCode;
  /** Merchant-supplied idempotency key; unique per merchant (Section 6). */
  txnId: string;
  ts: Timestamp;
  lineItems: OrderLineItem[];
  /** Discount/promo codes applied at checkout (carries code attribution). */
  couponCodes: string[];
  isNewCustomer: boolean;
  /** True when this order is a subscription rebill (recurring commissions). */
  isRebill: boolean;
  subtotalCents: number; // before tax/shipping
  discountCents: number;
  taxCents: number;
  shippingCents: number;
  /** country of the buyer, for geo rules. */
  country: string | null;
}

export interface OrderLineItem {
  sku: string;
  category: string | null;
  quantity: number;
  amountCents: number;
}

/** A click record (written asynchronously off the redirect hot path, Section 6). */
export interface Click {
  readonly clickId: Id; // UUIDv7
  readonly merchantId: Id;
  affiliateId: Id;
  offerId: Id;
  ts: Timestamp;
  ip: string | null;
  ua: string | null;
  landingUrl: string | null;
  sub1?: string;
  sub2?: string;
  sub3?: string;
  sub4?: string;
  sub5?: string;
}

export type AttributionMechanism = "link" | "code";

/**
 * The resolved attribution decision for an order: which affiliate gets credit and
 * by which mechanism. Produced by the attribution resolver (Section 6/7).
 */
export interface Attribution {
  affiliateId: Id;
  offerId: Id;
  mechanism: AttributionMechanism;
  clickId: Id | null;
  codeId: Id | null;
  /** The relationship establishing role + sponsor for override walking. */
  relationshipId: Id;
  sponsorAffiliateId: Id | null;
}

export type ConversionStatus = "pending" | "approved" | "rejected" | "reversed";
export type ReviewStatus = "none" | "flagged" | "cleared" | "rejected";

export interface Conversion {
  readonly id: Id;
  readonly merchantId: Id;
  clickId: Id | null;
  orderId: Id;
  affiliateId: Id;
  /** The offer that priced this conversion — so reversals route to the right engine. */
  offerId: Id;
  codeId: Id | null;
  amountCents: number;
  currency: CurrencyCode;
  status: ConversionStatus;
  reviewStatus: ReviewStatus;
  ts: Timestamp;
}
