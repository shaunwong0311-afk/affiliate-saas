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
 *
 * `processing` means the entry has been claimed by a payout batch and is in
 * flight to the rail — it is reserved out of the available balance so it cannot
 * be claimed by a second batch (preventing double payment). On disburse success
 * it becomes `paid`; on failure it returns to `approved`.
 */
export type LedgerStatus = "pending" | "approved" | "processing" | "paid" | "reversed";

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
