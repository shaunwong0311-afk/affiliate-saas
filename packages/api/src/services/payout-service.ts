import { newId, computeBalances, type Balance, type LedgerEntry } from "@affiliate/core";
import type { PayoutBatch, Payout } from "@affiliate/db";
import type { AppContext } from "../context.js";
import { writeAudit } from "./audit.js";
import { emitWebhook } from "./webhooks.js";

/**
 * Operator-grade payout console (Section 9) over the orchestration-without-custody
 * model (Section 4). Compute payable balances → gate on tax form + threshold →
 * batch → merchant approval → disburse through the connected rail → handle
 * failures/retries. The platform conducts; the rail moves the money.
 */

export interface PayableLine {
  affiliateId: string;
  affiliateName: string;
  currency: string;
  availableCents: number;
  onHoldCents: number;
  pendingCents: number;
  taxOnFile: boolean;
  payoutAccountRef: string | null;
  rail: string | null;
  eligible: boolean;
  blockedReason: string | null;
}

export async function computePayableLines(ctx: AppContext, merchantId: string, minPayoutCents: number): Promise<PayableLine[]> {
  const { db, clock } = ctx;
  const now = clock.now();
  const entries = await db.ledger.find((e) => e.merchantId === merchantId);
  const byAffiliate = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const list = byAffiliate.get(e.affiliateId) ?? [];
    list.push(e);
    byAffiliate.set(e.affiliateId, list);
  }

  const lines: PayableLine[] = [];
  for (const [affiliateId, affEntries] of byAffiliate) {
    const affiliate = await db.affiliates.get(affiliateId);
    const balances = computeBalances(affEntries, now);
    for (const [currency, b] of balances) {
      if (b.availableCents === 0 && b.onHoldCents === 0 && b.pendingCents === 0) continue;
      const taxDoc = await db.taxDocuments.findOne((t) => t.affiliateId === affiliateId && t.status === "on_file");
      const account = await db.payoutAccounts.findOne((a) => a.affiliateId === affiliateId && a.currency === currency);
      const { eligible, blockedReason } = payoutEligibility(b, !!taxDoc, account?.accountRef ?? null, minPayoutCents);
      lines.push({
        affiliateId,
        affiliateName: affiliate?.name ?? affiliateId,
        currency,
        availableCents: b.availableCents,
        onHoldCents: b.onHoldCents,
        pendingCents: b.pendingCents,
        taxOnFile: !!taxDoc,
        payoutAccountRef: account?.accountRef ?? null,
        rail: account?.rail ?? null,
        eligible,
        blockedReason,
      });
    }
  }
  return lines.sort((a, b) => b.availableCents - a.availableCents);
}

function payoutEligibility(
  b: Balance,
  taxOnFile: boolean,
  accountRef: string | null,
  minPayoutCents: number,
): { eligible: boolean; blockedReason: string | null } {
  if (b.availableCents <= 0) return { eligible: false, blockedReason: "no available balance" };
  if (b.availableCents < minPayoutCents) return { eligible: false, blockedReason: `below minimum ${minPayoutCents}` };
  // Tax-form gate (Section 4): no form, no payout. Fully automatic.
  if (!taxOnFile) return { eligible: false, blockedReason: "tax form not on file" };
  if (!accountRef) return { eligible: false, blockedReason: "no payout account" };
  return { eligible: true, blockedReason: null };
}

export interface BatchResult {
  batch: PayoutBatch;
  payouts: Payout[];
  skipped: PayableLine[];
}

/** Create a draft payout batch from currently-eligible payable lines. */
export async function createPayoutBatch(
  ctx: AppContext,
  merchantId: string,
  currency: string,
  minPayoutCents: number,
): Promise<BatchResult> {
  const { db, clock } = ctx;
  const lines = (await computePayableLines(ctx, merchantId, minPayoutCents)).filter((l) => l.currency === currency);
  const eligible = lines.filter((l) => l.eligible);
  const skipped = lines.filter((l) => !l.eligible);

  const batch: PayoutBatch = {
    id: newId("batch"),
    merchantId,
    rail: eligible[0]?.rail ?? "mock",
    currency,
    status: "draft",
    approvedBy: null,
    ts: clock.now().toISOString(),
  };
  await db.payoutBatches.insert(batch);

  const payouts: Payout[] = [];
  for (const line of eligible) {
    const payout: Payout = {
      id: newId("pay"),
      batchId: batch.id,
      merchantId,
      affiliateId: line.affiliateId,
      amountCents: line.availableCents,
      currency,
      method: line.rail ?? "mock",
      status: "pending",
      failureReason: null,
      ts: clock.now().toISOString(),
    };
    await db.payouts.insert(payout);
    payouts.push(payout);
  }
  return { batch, payouts, skipped };
}

/** Merchant approves a batch, then disburse through the rail (Section 4). */
export async function approveAndDisburse(ctx: AppContext, batchId: string, approverId: string): Promise<Payout[]> {
  const { db, clock } = ctx;
  const batch = await db.payoutBatches.require(batchId);
  await db.payoutBatches.update(batchId, { status: "processing", approvedBy: approverId });
  await writeAudit(ctx, { merchantId: batch.merchantId, actorId: approverId, action: "payout.batch.approved", subjectType: "payout_batch", subjectId: batchId });

  const payouts = await db.payouts.find((p) => p.batchId === batchId);
  const rail = ctx.rails.get(batch.rail);
  const results: Payout[] = [];

  for (const payout of payouts) {
    const account = await db.payoutAccounts.findOne((a) => a.affiliateId === payout.affiliateId && a.currency === payout.currency);
    const result = await rail.disburse({
      payoutId: payout.id,
      affiliateId: payout.affiliateId,
      accountRef: account?.accountRef ?? "unknown",
      amountCents: payout.amountCents,
      currency: payout.currency,
      idempotencyKey: payout.id,
    });
    const updated = await db.payouts.update(payout.id, { status: result.status, failureReason: result.failureReason });
    results.push(updated);

    // On success, mark the affiliate's available ledger entries as paid.
    if (result.status === "paid") {
      await markEntriesPaid(ctx, payout.affiliateId, payout.merchantId, payout.currency, payout.amountCents);
      await emitWebhook(ctx, batch.merchantId, "payout.paid", { payoutId: payout.id, affiliateId: payout.affiliateId, amountCents: payout.amountCents });
    }
  }

  const anyFailed = results.some((p) => p.status === "failed");
  await db.payoutBatches.update(batchId, { status: anyFailed ? "failed" : "paid" });
  return results;
}

/** Retry a single failed payout (Section 9). */
export async function retryPayout(ctx: AppContext, payoutId: string): Promise<Payout> {
  const { db } = ctx;
  const payout = await db.payouts.require(payoutId);
  if (payout.status !== "failed") return payout;
  const account = await db.payoutAccounts.findOne((a) => a.affiliateId === payout.affiliateId && a.currency === payout.currency);
  const rail = ctx.rails.get(payout.method);
  const result = await rail.disburse({
    payoutId: payout.id,
    affiliateId: payout.affiliateId,
    accountRef: account?.accountRef ?? "unknown",
    amountCents: payout.amountCents,
    currency: payout.currency,
    idempotencyKey: `${payout.id}_retry`,
  });
  if (result.status === "paid") {
    await markEntriesPaid(ctx, payout.affiliateId, payout.merchantId, payout.currency, payout.amountCents);
  }
  return db.payouts.update(payoutId, { status: result.status, failureReason: result.failureReason });
}

async function markEntriesPaid(ctx: AppContext, affiliateId: string, merchantId: string, currency: string, amountCents: number): Promise<void> {
  const { db, clock } = ctx;
  const now = clock.now();
  const entries = (await db.ledger.find(
    (e) => e.affiliateId === affiliateId && e.merchantId === merchantId && e.currency === currency && e.status === "approved",
  )).filter((e) => !e.availableAt || new Date(e.availableAt).getTime() <= now.getTime());

  let remaining = amountCents;
  for (const entry of entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())) {
    if (remaining <= 0) break;
    await db.ledger.update(entry.id, { status: "paid" });
    remaining -= entry.amountCents;
  }
}

/** Manual adjustment (bonus, correction, negative-balance write-off) — Section 9. */
export async function addAdjustment(
  ctx: AppContext,
  params: { merchantId: string; affiliateId: string; amountCents: number; currency: string; reason: string; createdBy: string },
): Promise<void> {
  const { db, clock } = ctx;
  const now = clock.now();
  await db.payoutAdjustments.insert({ id: newId("adj"), ...params, ts: now.toISOString() });
  await db.ledger.insert({
    id: newId("led"),
    merchantId: params.merchantId,
    affiliateId: params.affiliateId,
    conversionId: null,
    type: "adjustment",
    amountCents: params.amountCents,
    currency: params.currency,
    status: "approved",
    availableAt: now.toISOString(),
    ts: now.toISOString(),
    reversesEntryId: null,
    metadata: { reason: params.reason, createdBy: params.createdBy },
  });
}
