import type { Id, Timestamp, AffiliateRole } from "./common.js";
import type { CurrencyCode } from "../money.js";

/**
 * Global affiliate identity (Section 2, bet #2). An affiliate is a global entity;
 * the link to a merchant is the relationship join. This is what keeps the network
 * an option — the affiliate graph spans merchants natively.
 */
export interface Affiliate {
  readonly id: Id;
  name: string;
  primaryEmail: string;
  country: string | null;
  audienceProfile: AudienceProfile | null;
  status: AffiliateStatus;
  createdAt: Timestamp;
}

export type AffiliateStatus = "active" | "paused" | "banned";

export interface AudienceProfile {
  niche?: string;
  reach?: number;
  geos?: string[];
  languages?: string[];
  channels?: string[];
}

/**
 * Per-merchant relationship carrying role, negotiated terms, and the
 * self-referential sponsor pointer (the recruiter) — the seed of overrides and,
 * later, MLM genealogy (Section 4, Section 7).
 */
export interface AffiliateRelationship {
  readonly id: Id;
  readonly affiliateId: Id;
  readonly merchantId: Id;
  readonly programId: Id;
  status: RelationshipStatus;
  joinedAt: Timestamp;
  role: AffiliateRole;
  /** Per-relationship overrides of program defaults (VIP terms, group terms). */
  commissionTerms: CommissionTermsOverride | null;
  source: string; // 'inbound' | 'recruitment' | 'auto_invite' | a discovery sourceType
  ownerUserId: Id | null;
  tags: string[];
  /** The recruiter who brought this affiliate in. Null when self-sourced. */
  sponsorAffiliateId: Id | null;
  /**
   * The prospect this affiliate was converted from, if recruited. This FK is what
   * makes source-yield attribution and cost-per-producing-affiliate computable —
   * a producing affiliate can be traced back to the source that found it.
   */
  prospectId: Id | null;
}

export type RelationshipStatus = "pending" | "active" | "paused" | "banned" | "rejected";

/** Optional per-relationship overrides applied on top of the offer's defaults. */
export interface CommissionTermsOverride {
  rate?: number; // decimal, overrides percentage offers
  flatAmountCents?: number; // overrides flat offers
  note?: string;
}

export interface PayoutAccount {
  readonly id: Id;
  readonly affiliateId: Id;
  rail: string; // 'stripe' | 'paypal' | 'wise'
  accountRef: string;
  status: "unverified" | "active" | "disabled";
  currency: CurrencyCode;
}

export interface TaxDocument {
  readonly id: Id;
  readonly affiliateId: Id;
  rail: string | null;
  formType: "W-9" | "W-8BEN" | "W-8BEN-E" | "other";
  status: "missing" | "on_file" | "expired";
  collectedAt: Timestamp | null;
}
