import type { Id, EngineKind } from "./common.js";
import type { CurrencyCode } from "../money.js";
import type { AttributionPriority } from "../attribution/attribution.js";

export type ProgramStatus = "draft" | "active" | "paused" | "archived";
export type ApprovalMode = "auto" | "manual" | "invite_only";

export interface Program {
  readonly id: Id;
  readonly merchantId: Id;
  name: string;
  status: ProgramStatus;
  termsUrl: string | null;
  approvalMode: ApprovalMode;
  defaultCurrency: CurrencyCode;
  /** Link-vs-code precedence (Section 7); defaults to last_touch when unset. */
  attributionPriority: AttributionPriority;
  /** Payout hold period in days before commissions become payable. */
  holdDays: number;
}

export type PayoutType = "percentage" | "flat";

/**
 * An offer is the priced unit a sale resolves against. `engine` is the hook that
 * routes an order to the correct commission engine (Section 10).
 */
export interface Offer {
  readonly id: Id;
  readonly merchantId: Id;
  readonly programId: Id;
  engine: EngineKind;
  name: string;
  payoutType: PayoutType;
  /** For percentage: a decimal rate (0.15). For flat: minor units (cents). */
  payoutValue: number;
  /**
   * The currency every amount in this offer is in (flat payout, tier thresholds, bonuses,
   * caps, flat overrides). There is no FX: an order in another currency is priced only when
   * the offer is a plain percentage — see `currencyPricingIssue`.
   */
  currency: CurrencyCode;
  windowDays: number; // attribution window
  rules: OfferRule[];
  tiers: CommissionTier[];
  bonuses: Bonus[];
  overridePolicy: OverridePolicy | null;
  status: "active" | "paused";
}

/**
 * Commissionable-subtotal basis and other guardrails (Section 7). `kind`
 * discriminates the config shape; the engine reads the ones it understands and
 * ignores the rest (forward-compatible).
 */
export type OfferRule =
  | { kind: "commissionable_basis"; basis: CommissionableBasis }
  | { kind: "first_order_only"; value: true }
  | { kind: "new_customer_only"; value: true }
  | { kind: "min_order_cents"; value: number }
  | { kind: "max_commission_cents"; value: number } // per-conversion cap
  | { kind: "sku_include"; skus: string[] }
  | { kind: "sku_exclude"; skus: string[] }
  | { kind: "category_rate"; category: string; rate: number }
  | { kind: "geo_allow"; countries: string[] }
  | { kind: "geo_block"; countries: string[] }
  | { kind: "excluded_coupons"; codes: string[] }
  | { kind: "time_boost"; rate: number; startsAt: string; endsAt: string }
  | { kind: "recurring"; value: true } // pays on rebills
  | { kind: "manual_review_over_cents"; value: number };

/**
 * What a percentage commission is a percentage OF (see the Order money fields):
 *  - `gross`               the amount charged — after discounts, including tax and shipping;
 *  - `net_of_tax_shipping` the amount charged less tax and shipping;
 *  - `net_of_discount`     the merchandise subtotal less discounts.
 * The last two are the same figure whenever an order's parts add up; they differ in which
 * fields the feed has to carry (a feed with no subtotal can still use `net_of_tax_shipping`).
 * With line items and SKU rules, the base is that figure apportioned to the eligible lines.
 */
export type CommissionableBasis = "gross" | "net_of_discount" | "net_of_tax_shipping";

/** Volume escalation: rate increases as cumulative volume crosses thresholds. */
export interface CommissionTier {
  readonly id: Id;
  readonly offerId: Id;
  minVolumeCents: number;
  rate: number; // decimal
}

export type BonusTrigger = "lifetime_volume" | "conversion_count" | "first_sale";

/** Milestone / activation bonuses: flat reward when a threshold is crossed. */
export interface Bonus {
  readonly id: Id;
  readonly offerId: Id;
  triggerType: BonusTrigger;
  threshold: number; // cents for volume, count for conversion_count, 1 for first_sale
  amountCents: number;
}

export type OverrideStructure = "flat" | "percentage";
export type OverrideTrigger = "first_sale" | "per_sale";

/**
 * Recruiter override policy (Section 7). Strictly contingent on the recruit's
 * real sales, never the signup; capped at a two-tier depth.
 */
export interface OverridePolicy {
  readonly id: Id;
  readonly offerId: Id;
  structure: OverrideStructure;
  /** For percentage: decimal of the recruit's commissionable base. For flat: cents. */
  value: number;
  trigger: OverrideTrigger;
  maxDepth: 1; // two-tier cap — hard constraint
}

export type CodeKind = "discount" | "referral";

export interface AffiliateCode {
  readonly id: Id;
  readonly affiliateId: Id;
  readonly merchantId: Id;
  code: string;
  kind: CodeKind;
  discountValue: number | null; // percent off for discount codes
  usageCap: number | null;
  usageCount: number;
  expiresAt: string | null;
}
