import type { Money } from "../money.js";
import type { Id } from "../types/common.js";
import type { Order, Attribution } from "../types/orders.js";
import type { Offer } from "../types/program.js";
import type { AffiliateRelationship } from "../types/identity.js";
import type { LedgerEntry } from "../types/ledger.js";

/**
 * The commission-engine seam (Section 5). Calculation lives behind this narrow
 * interface. The substrate assembles a context (all reads), calls the engine
 * (pure compute), and writes the returned events to the append-only ledger (all
 * writes). The affiliate engine is the first implementation; an MLM engine is a
 * second one on the same substrate. Same chassis, different transmission.
 *
 * Keeping the engine a *pure function of its context* is what makes commission
 * math reproducible, unit-testable without a database, and impossible to weld
 * into the foundation.
 */
export interface CommissionEngine {
  readonly kind: string;

  /** Event-driven path (affiliate): a sale fires → emit commission events. */
  onOrder(ctx: OnOrderContext): CommissionEvent[];

  /** Batch path (MLM commission runs): largely a no-op for the affiliate engine. */
  runCycle(ctx: RunCycleContext): CommissionEvent[];

  /** Clawback cascade: a refund reverses whatever entries the order produced. */
  onReversal(ctx: OnReversalContext): ReversalEvent[];

  /** Tier / rank qualification from accumulated volume. */
  qualify(ctx: QualifyContext): Qualification;
}

/** Everything the engine needs to price one order — assembled by the substrate. */
export interface OnOrderContext {
  order: Order;
  attribution: Attribution;
  /** The conversion record id the substrate has already created for this order. */
  conversionId: Id;
  offer: Offer;
  /** The converting affiliate's relationship (role, negotiated terms). */
  relationship: AffiliateRelationship;
  /** The recruiter's relationship, if the converter was sponsored. */
  sponsorRelationship: AffiliateRelationship | null;
  /** Cumulative commissionable volume (cents) credited before this order. */
  priorVolumeCents: number;
  /** Count of prior approved conversions for this affiliate on this offer. */
  priorConversionCount: number;
  /** Is this the converting affiliate's first sale on this offer? */
  isFirstConversionForAffiliate: boolean;
  /** Is this the recruit's first sale (override `first_sale` trigger)? */
  isFirstSaleUnderSponsor: boolean;
  now: Date;
}

export interface RunCycleContext {
  merchantId: Id;
  period: { start: Date; end: Date };
  now: Date;
}

export interface OnReversalContext {
  order: Order;
  /** The ledger entries the original conversion produced (commission + overrides). */
  originalEntries: LedgerEntry[];
  reason: string;
  now: Date;
}

export interface QualifyContext {
  offer: Offer;
  priorVolumeCents: number;
  now: Date;
}

export type CommissionEventType = "commission" | "override" | "bonus";

/** A money event for the substrate to write to the ledger. */
export interface CommissionEvent {
  type: CommissionEventType;
  /** Beneficiary affiliate (seller for commission/bonus, recruiter for override). */
  affiliateId: Id;
  amount: Money;
  conversionId: Id;
  /** 0 = direct sale; 1 = recruiter override (two-tier). MLM extends to depth. */
  level: number;
  reason: string;
  /** When funds become available, set by the substrate from the hold period. */
  metadata?: Record<string, unknown>;
}

export interface ReversalEvent {
  reversesEntryId: Id;
  affiliateId: Id;
  amount: Money; // negative
  conversionId: Id | null;
  reason: string;
}

export interface Qualification {
  tier: string | null;
  /** Effective rate after applying volume tiers, or null if no tier matched. */
  rate: number | null;
  metadata?: Record<string, unknown>;
}
