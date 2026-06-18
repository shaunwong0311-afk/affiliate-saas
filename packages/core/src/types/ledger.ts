import type { Id, Timestamp } from "./common.js";
import type { CurrencyCode } from "../money.js";

export type LedgerEntryType =
  | "commission" // a seller's earnings on their own sale
  | "override" // a recruiter's earnings on a recruit's sale
  | "bonus" // milestone / activation bonus
  | "adjustment" // manual adjustment (+/-)
  | "reversal"; // clawback of a prior entry

/**
 * Ledger lifecycle. The ledger is append-only — balances are never mutated.
 * A reversal is a new entry that cancels a prior one (Section 4).
 */
export type LedgerStatus = "pending" | "approved" | "paid" | "reversed";

export interface LedgerEntry {
  readonly id: Id;
  readonly merchantId: Id;
  readonly affiliateId: Id;
  conversionId: Id | null;
  type: LedgerEntryType;
  amountCents: number; // negative for reversals/negative adjustments
  currency: CurrencyCode;
  status: LedgerStatus;
  /** When funds become available for payout (after the hold period). */
  availableAt: Timestamp | null;
  ts: Timestamp;
  /** For reversals: the entry being reversed. */
  reversesEntryId: Id | null;
  metadata: Record<string, unknown>;
}
