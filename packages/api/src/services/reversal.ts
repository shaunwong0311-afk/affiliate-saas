import { applyReversal, type Conversion, type LedgerEntry } from "@affiliate/core";
import type { AppContext } from "../context.js";
import { conflict } from "../errors.js";
import { emitAfterCommit, moneyTransaction, resyncDraftPayout, withMoneyLock, type PendingEvent } from "./payout-service.js";

/**
 * Clawback cascade on refund/cancellation (Section 4). The engine decides what to
 * reverse (one level for two-tier, full upline for MLM); this service applies the
 * append-only ledger mutation and flips the conversion to `reversed`.
 *
 * Refunds, approvals and rejections all change what an affiliate is owed, so each runs
 * under the merchant's money lock, in one transaction, and checks the conversion's state
 * INSIDE it. A partial refund is not modelled: a refund reverses the whole conversion.
 */
export interface ReversalResult {
  conversionId: string;
  reversedEntries: number;
  reason: string;
}

/**
 * Take back what a conversion earned. For each entry, by where its money is:
 *  - not paid and not in a payout → voided;
 *  - reserved by a payout still in a DRAFT batch → voided and taken out of that payout,
 *    whose amount shrinks accordingly (it used to be sent in full regardless);
 *  - reserved by a payout already handed over, or paid → it stays, and a negative entry
 *    claws it back from the affiliate's future balance.
 * Must run inside a money transaction. Returns the number of entries reversed.
 */
async function reverseEntries(tx: AppContext, conversion: Conversion, entries: LedgerEntry[], reason: string): Promise<number> {
  const { db, clock } = tx;
  const now = clock.now();
  const order = await db.orders.require(conversion.orderId);
  // Route to the engine of the OFFER that produced this conversion (not the
  // merchant's first offer) — correct for multi-program / multi-engine merchants.
  const offer = await db.offers.get(conversion.offerId);
  const engine = tx.engines.get(offer?.engine ?? "affiliate");
  const reversalEvents = engine.onReversal({ order, originalEntries: entries, reason, now });

  const draftPayouts = new Set<string>();
  let reversedCount = 0;
  for (const event of reversalEvents) {
    const original = entries.find((e) => e.id === event.reversesEntryId);
    if (!original) continue;

    let disbursementStarted: boolean | undefined;
    if (original.status === "processing") {
      const payoutId = original.metadata?.["payoutId"];
      const payout = typeof payoutId === "string" ? await db.payouts.get(payoutId) : null;
      // Only a payout still sitting in a draft is known not to have been sent. Anything
      // else — approved, with a rail, or a reservation we cannot trace — may have moved.
      disbursementStarted = !(payout && payout.status === "pending");
      if (payout && !disbursementStarted) draftPayouts.add(payout.id);
    }

    const { reversalEntry, originalNewStatus } = applyReversal(original, event, { merchantId: conversion.merchantId, now, disbursementStarted });
    await db.ledger.insert(reversalEntry);
    if (originalNewStatus !== original.status) {
      await db.ledger.update(original.id, { status: originalNewStatus });
    }
    reversedCount++;
  }
  for (const payoutId of draftPayouts) await resyncDraftPayout(tx, payoutId);
  return reversedCount;
}

export async function reverseOrder(ctx: AppContext, orderId: string, reason: string): Promise<ReversalResult | null> {
  const order = await ctx.db.orders.get(orderId);
  if (!order) return null;
  const { merchantId } = order;

  const events: PendingEvent[] = [];
  const result = await withMoneyLock(ctx, merchantId, () =>
    moneyTransaction(ctx, merchantId, async (tx) => {
      // Only a live conversion can be refunded: a rejected or already reversed one has
      // nothing left to take back (and two refunds at once must not claw back twice).
      const conversion = await tx.db.conversions.findOne((c) => c.orderId === orderId && (c.status === "pending" || c.status === "approved"));
      if (!conversion) return null;

      const entries = await tx.db.ledger.find((e) => e.conversionId === conversion.id && e.type !== "reversal");
      const reversedEntries = await reverseEntries(tx, conversion, entries, reason);
      await tx.db.conversions.update(conversion.id, { status: "reversed" });
      events.push({ merchantId, type: "conversion.reversed", payload: { conversionId: conversion.id, reason } });
      return { conversionId: conversion.id, reversedEntries, reason };
    }),
  );
  await emitAfterCommit(ctx, events);
  return result;
}

/** The hold period that applies to a conversion: its OWN offer's program, not a global default. */
async function holdDaysFor(tx: AppContext, conversion: Conversion): Promise<number> {
  const offer = await tx.db.offers.get(conversion.offerId);
  const program = offer ? await tx.db.programs.get(offer.programId) : null;
  return program?.holdDays ?? tx.config.defaultHoldDays;
}

/**
 * Approve a pending conversion out of the review queue and release its ledger entries.
 * Only a `pending` conversion can be approved — approving a rejected or refunded one used
 * to flip it back to approved.
 */
export async function approveConversion(ctx: AppContext, conversionId: string): Promise<void> {
  const found = await ctx.db.conversions.get(conversionId);
  if (!found) return;
  const { merchantId } = found;

  const events: PendingEvent[] = [];
  await withMoneyLock(ctx, merchantId, () =>
    moneyTransaction(ctx, merchantId, async (tx) => {
      const conversion = await tx.db.conversions.require(conversionId);
      if (conversion.status !== "pending") throw conflict(`conversion is ${conversion.status}; only a pending conversion can be approved`);
      const entries = await tx.db.ledger.find((e) => e.conversionId === conversionId && e.status === "pending");
      if (conversion.flagReason && entries.length === 0) {
        throw conflict(`this conversion has no commission to approve (${conversion.flagReason}). Pay it with a manual adjustment, or reject it.`);
      }
      const now = tx.clock.now();
      const availableAt = new Date(now.getTime() + (await holdDaysFor(tx, conversion)) * 86_400_000).toISOString();
      await tx.db.conversions.update(conversionId, { status: "approved", reviewStatus: "cleared" });
      for (const entry of entries) {
        await tx.db.ledger.update(entry.id, { status: "approved", availableAt });
      }
      events.push({ merchantId, type: "conversion.approved", payload: { conversionId } });
    }),
  );
  await emitAfterCommit(ctx, events);
}

/**
 * Reject a conversion. Entries still pending review are voided in place. Entries that were
 * already approved are taken back exactly as a refund would — voided if unpaid, clawed back
 * if a payout has them or they are paid. (Rejecting an approved conversion used to leave its
 * commission approved and payable.)
 */
export async function rejectConversion(ctx: AppContext, conversionId: string, reason: string): Promise<void> {
  const found = await ctx.db.conversions.get(conversionId);
  if (!found) return;
  const { merchantId } = found;

  const events: PendingEvent[] = [];
  await withMoneyLock(ctx, merchantId, () =>
    moneyTransaction(ctx, merchantId, async (tx) => {
      const conversion = await tx.db.conversions.require(conversionId);
      if (conversion.status === "rejected" || conversion.status === "reversed") {
        throw conflict(`conversion is already ${conversion.status}`);
      }
      const entries = await tx.db.ledger.find((e) => e.conversionId === conversionId && e.type !== "reversal");
      for (const entry of entries.filter((e) => e.status === "pending")) {
        await tx.db.ledger.update(entry.id, { status: "reversed", metadata: { ...entry.metadata, rejected: reason } });
      }
      const earned = entries.filter((e) => e.status === "approved" || e.status === "processing" || e.status === "paid");
      if (earned.length > 0) await reverseEntries(tx, conversion, earned, `rejected: ${reason}`);
      await tx.db.conversions.update(conversionId, { status: "rejected", reviewStatus: "rejected" });
      events.push({ merchantId, type: "conversion.rejected", payload: { conversionId, reason } });
    }),
  );
  await emitAfterCommit(ctx, events);
}
