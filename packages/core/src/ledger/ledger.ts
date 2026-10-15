import { add, money, zero, type CurrencyCode } from "../money.js";
import { newId } from "../ids.js";
import type { Id } from "../types/common.js";
import type { LedgerEntry, LedgerStatus } from "../types/ledger.js";
import type { CommissionEvent, ReversalEvent } from "../engine/types.js";

/**
 * Ledger semantics (Section 4):
 *
 *  - Money *amounts* are immutable once written.
 *  - An entry's *status* progresses pending → approved → paid (lifecycle), or is
 *    marked `reversed`.
 *  - Balances are ALWAYS derived by summing entries — never stored and mutated.
 *  - A clawback appends a NEW negative `reversal` entry; it never deletes history.
 *
 * Reversal cases, handled explicitly:
 *  1. Reversing an un-paid entry → mark the original `reversed` (drops out of
 *     sums) and record the reversal entry as `reversed` too (pure audit, not
 *     summed) so there is no double subtraction.
 *  2. Reversing an already-PAID entry → the original stays `paid` (you cannot
 *     un-pay), and the reversal entry is `approved` with a negative amount, which
 *     nets against the affiliate's balance — the documented negative-balance
 *     exposure after refunds (Section 9).
 *  3. Reversing an entry a payout has RESERVED (`processing`):
 *     - the payout has been handed over (approved for manual payment, or sent to a
 *       rail): the money may already have moved, so this is case 2 — the original keeps
 *       its place in the payout and a negative `approved` entry claws it back. If the
 *       payout later fails, the original returns to `approved` and the two cancel out;
 *     - the payout is still a draft: nothing was sent, so this is case 1 — and the
 *       caller must take the entry out of the payout and recompute its amount.
 */

export interface ToEntryOptions {
  merchantId: Id;
  /** Initial status; commissions start `pending` then are approved after review/hold. */
  status?: LedgerStatus;
  /** When funds become payable (now + hold period). */
  availableAt?: Date | null;
  now: Date;
}

export function commissionEventToEntry(event: CommissionEvent, opts: ToEntryOptions): LedgerEntry {
  const status = opts.status ?? "pending";
  return {
    id: newId("led"),
    merchantId: opts.merchantId,
    affiliateId: event.affiliateId,
    conversionId: event.conversionId,
    type: event.type,
    amountCents: event.amount.amountCents,
    currency: event.amount.currency,
    status,
    availableAt: opts.availableAt ? opts.availableAt.toISOString() : null,
    ts: opts.now.toISOString(),
    reversesEntryId: null,
    metadata: { reason: event.reason, level: event.level, ...(event.metadata ?? {}) },
  };
}

export interface ReversalResult {
  reversalEntry: LedgerEntry;
  /** The new status to persist on the original entry. */
  originalNewStatus: LedgerStatus;
}

export function applyReversal(
  original: LedgerEntry,
  event: ReversalEvent,
  opts: {
    merchantId: Id;
    now: Date;
    /**
     * For a `processing` (reserved) original: has its payout been handed over — approved
     * for manual payment or sent to a rail? Pass `false` ONLY for a payout that is still a
     * draft. Left out, the answer is assumed to be yes: treating money as possibly moved is
     * the mistake that costs nothing.
     */
    disbursementStarted?: boolean;
  },
): ReversalResult {
  const moneyMayHaveMoved =
    original.status === "paid" || (original.status === "processing" && opts.disbursementStarted !== false);
  const reversalStatus: LedgerStatus = moneyMayHaveMoved ? "approved" : "reversed";
  const originalNewStatus: LedgerStatus = moneyMayHaveMoved ? original.status : "reversed";

  const reversalEntry: LedgerEntry = {
    id: newId("led"),
    merchantId: opts.merchantId,
    affiliateId: event.affiliateId,
    conversionId: event.conversionId,
    type: "reversal",
    amountCents: event.amount.amountCents, // negative
    currency: event.amount.currency,
    status: reversalStatus,
    availableAt: null,
    ts: opts.now.toISOString(),
    reversesEntryId: original.id,
    metadata: { reason: event.reason, reversedFromStatus: original.status },
  };

  return { reversalEntry, originalNewStatus };
}

export interface Balance {
  currency: CurrencyCode;
  pendingCents: number; // awaiting approval / in hold as pending
  availableCents: number; // approved AND available now → payable (net of negative reversals)
  onHoldCents: number; // approved but still inside the hold window
  /** Reserved by a payout that is not settled yet (draft, awaiting payment, or with a rail). Still owed. */
  processingCents: number;
  paidCents: number;
  reversedCents: number; // absolute value of fully-reversed (un-paid) entries
}

/**
 * Derive balances per currency for one affiliate from their ledger entries.
 * `reversed`-status entries are excluded from live balances (pure audit); negative
 * reversal entries that are `approved` (post-payout clawbacks) net against payable.
 */
export function computeBalances(entries: readonly LedgerEntry[], now: Date): Map<CurrencyCode, Balance> {
  const byCurrency = new Map<CurrencyCode, Balance>();
  const nowMs = now.getTime();

  const ensure = (currency: CurrencyCode): Balance => {
    let b = byCurrency.get(currency);
    if (!b) {
      b = {
        currency,
        pendingCents: 0,
        availableCents: 0,
        onHoldCents: 0,
        processingCents: 0,
        paidCents: 0,
        reversedCents: 0,
      };
      byCurrency.set(currency, b);
    }
    return b;
  };

  for (const e of entries) {
    const b = ensure(e.currency);
    switch (e.status) {
      case "pending":
        b.pendingCents += e.amountCents;
        break;
      case "approved": {
        const available = !e.availableAt || new Date(e.availableAt).getTime() <= nowMs;
        if (available) b.availableCents += e.amountCents;
        else b.onHoldCents += e.amountCents;
        break;
      }
      case "processing":
        // Without this bucket, money reserved by an open payout vanished from every total.
        b.processingCents += e.amountCents;
        break;
      case "paid":
        b.paidCents += e.amountCents;
        break;
      case "reversed":
        // Excluded from live balances; track magnitude for reporting.
        if (e.type === "reversal") b.reversedCents += Math.abs(e.amountCents);
        break;
    }
  }

  return byCurrency;
}

/** Total payable now across all currencies for an affiliate (positive balances only). */
export function payableTotals(entries: readonly LedgerEntry[], now: Date): Map<CurrencyCode, number> {
  const out = new Map<CurrencyCode, number>();
  for (const [currency, b] of computeBalances(entries, now)) {
    if (b.availableCents > 0) out.set(currency, b.availableCents);
  }
  return out;
}

/** Sum a set of entries' amounts, asserting a single currency. */
export function sumEntries(entries: readonly LedgerEntry[], currency: CurrencyCode) {
  return entries.reduce((acc, e) => add(acc, money(e.amountCents, e.currency)), zero(currency));
}
