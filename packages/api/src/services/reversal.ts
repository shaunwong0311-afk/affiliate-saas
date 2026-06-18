import { applyReversal, type LedgerEntry } from "@affiliate/core";
import type { AppContext } from "../context.js";
import { emitWebhook } from "./webhooks.js";

/**
 * Clawback cascade on refund/cancellation (Section 4). The engine decides what to
 * reverse (one level for two-tier, full upline for MLM); this service applies the
 * append-only ledger mutation and flips the conversion to `reversed`.
 */
export interface ReversalResult {
  conversionId: string;
  reversedEntries: number;
  reason: string;
}

export async function reverseOrder(ctx: AppContext, orderId: string, reason: string): Promise<ReversalResult | null> {
  const { db, clock } = ctx;
  const now = clock.now();

  const order = await db.orders.get(orderId);
  if (!order) return null;
  const conversion = await db.conversions.findOne((c) => c.orderId === orderId && c.status !== "reversed");
  if (!conversion) return null;

  const originalEntries = await db.ledger.find((e) => e.conversionId === conversion.id && e.type !== "reversal");
  const engine = ctx.engines.get(await offerEngineFor(ctx, conversion.affiliateId, order.merchantId));

  const reversalEvents = engine.onReversal({ order, originalEntries, reason, now });

  let reversedCount = 0;
  for (const event of reversalEvents) {
    const original = originalEntries.find((e) => e.id === event.reversesEntryId);
    if (!original) continue;
    const { reversalEntry, originalNewStatus } = applyReversal(original, event, { merchantId: order.merchantId, now });
    await db.ledger.insert(reversalEntry);
    if (originalNewStatus !== original.status) {
      await db.ledger.update(original.id, { status: originalNewStatus });
    }
    reversedCount++;
  }

  await db.conversions.update(conversion.id, { status: "reversed" });
  await emitWebhook(ctx, order.merchantId, "conversion.reversed", { conversionId: conversion.id, reason });

  return { conversionId: conversion.id, reversedEntries: reversedCount, reason };
}

async function offerEngineFor(ctx: AppContext, _affiliateId: string, merchantId: string): Promise<string> {
  // In practice the engine is read from the offer that produced the conversion.
  // Conversions don't store the offer directly here, so default to the merchant's
  // first offer engine (affiliate). The engine seam makes this swap trivial.
  const offer = await ctx.db.offers.findOne((o) => o.merchantId === merchantId);
  return offer?.engine ?? "affiliate";
}

/** Approve a pending conversion out of the review queue and release its ledger entries. */
export async function approveConversion(ctx: AppContext, conversionId: string, holdDays: number): Promise<void> {
  const { db, clock } = ctx;
  const now = clock.now();
  const conversion = await db.conversions.get(conversionId);
  if (!conversion) return;
  await db.conversions.update(conversionId, { status: "approved", reviewStatus: "cleared" });
  const availableAt = new Date(now.getTime() + holdDays * 86_400_000).toISOString();
  const entries = await db.ledger.find((e) => e.conversionId === conversionId && e.status === "pending");
  for (const entry of entries) {
    await db.ledger.update(entry.id, { status: "approved", availableAt });
  }
  await emitWebhook(ctx, conversion.merchantId, "conversion.approved", { conversionId });
}

/** Reject a flagged conversion; its pending ledger entries are voided as reversed. */
export async function rejectConversion(ctx: AppContext, conversionId: string, reason: string): Promise<void> {
  const { db } = ctx;
  const conversion = await db.conversions.get(conversionId);
  if (!conversion) return;
  await db.conversions.update(conversionId, { status: "rejected", reviewStatus: "rejected" });
  const entries: LedgerEntry[] = await db.ledger.find((e) => e.conversionId === conversionId && e.status === "pending");
  for (const entry of entries) {
    await db.ledger.update(entry.id, { status: "reversed", metadata: { ...entry.metadata, rejected: reason } });
  }
  await emitWebhook(ctx, conversion.merchantId, "conversion.rejected", { conversionId, reason });
}
