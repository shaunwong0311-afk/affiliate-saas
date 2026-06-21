import { newId, computeBalances, type Balance, type LedgerEntry } from "@affiliate/core";
import type { PayoutBatch, Payout } from "@affiliate/db";
import type { AppContext } from "../context.js";
import { conflict, notFound } from "../errors.js";
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

/**
 * Create a draft payout batch and RESERVE the claimed ledger entries.
 *
 * Reservation is what makes payouts safe: each affiliate's available `approved`
 * entries are moved to `processing` and stamped with the payout id. They drop out
 * of the available balance immediately, so a second `createPayoutBatch` for the
 * same merchant sees zero — no double payment. On disburse success they become
 * `paid`; on failure they are released back to `approved`.
 *
 * The whole claim runs inside a transaction so a mid-claim failure can't leave a
 * partially-reserved balance.
 */
export async function createPayoutBatch(
  ctx: AppContext,
  merchantId: string,
  currency: string,
  minPayoutCents: number,
): Promise<BatchResult> {
  const { clock } = ctx;
  return ctx.db.transaction(async (db) => {
    const txCtx = { ...ctx, db };
    const lines = (await computePayableLines(txCtx, merchantId, minPayoutCents)).filter((l) => l.currency === currency);
    const eligible = lines.filter((l) => l.eligible);
    const skipped = lines.filter((l) => !l.eligible);

    const batch: PayoutBatch = {
      id: newId("batch"),
      merchantId,
      rail: "mixed", // each payout disburses through its own affiliate's rail
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
      // Reserve the exact entries that fund this payout.
      await reserveEntries(txCtx, payout);
      payouts.push(payout);
    }
    return { batch, payouts, skipped };
  });
}

/** Move an affiliate's available approved entries to `processing`, stamped with the payout id. */
async function reserveEntries(ctx: AppContext, payout: Payout): Promise<void> {
  const { db, clock } = ctx;
  const now = clock.now();
  const entries = (
    await db.ledger.find(
      (e) =>
        e.affiliateId === payout.affiliateId &&
        e.merchantId === payout.merchantId &&
        e.currency === payout.currency &&
        e.status === "approved",
    )
  )
    .filter((e) => !e.availableAt || new Date(e.availableAt).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  let remaining = payout.amountCents;
  for (const entry of entries) {
    if (remaining <= 0) break;
    await db.ledger.update(entry.id, { status: "processing", metadata: { ...entry.metadata, payoutId: payout.id } });
    remaining -= entry.amountCents;
  }
}

/**
 * Merchant approves a batch, then disburses. State-guarded (a batch can only be
 * disbursed once, from `draft`) and disburses each payout through ITS OWN
 * affiliate's rail — mixed methods never share a rail.
 */
export async function approveAndDisburse(ctx: AppContext, batchId: string, approverId: string): Promise<Payout[]> {
  const { db } = ctx;
  const batch = await db.payoutBatches.get(batchId);
  if (!batch) throw notFound("payout batch");
  // Idempotency / double-spend guard: only a draft batch can be disbursed.
  if (batch.status !== "draft") throw conflict(`batch is ${batch.status}, not draft`);
  await db.payoutBatches.update(batchId, { status: "processing", approvedBy: approverId });
  await writeAudit(ctx, { merchantId: batch.merchantId, actorId: approverId, action: "payout.batch.approved", subjectType: "payout_batch", subjectId: batchId });

  const payouts = await db.payouts.find((p) => p.batchId === batchId);
  const results: Payout[] = [];

  for (const payout of payouts) {
    const updated = await disburseOne(ctx, payout, payout.id);
    results.push(updated);
  }

  const anyFailed = results.some((p) => p.status === "failed");
  await db.payoutBatches.update(batchId, { status: anyFailed ? "failed" : "paid" });
  return results;
}

/** Disburse one payout through its affiliate's rail. Idempotency key is stable per payout. */
async function disburseOne(ctx: AppContext, payout: Payout, idempotencyKey: string): Promise<Payout> {
  const { db } = ctx;
  const account = await db.payoutAccounts.findOne((a) => a.affiliateId === payout.affiliateId && a.currency === payout.currency);
  if (!account) {
    await releaseReservation(ctx, payout.id);
    return db.payouts.update(payout.id, { status: "failed", failureReason: "no payout account" });
  }

  let result;
  try {
    // Use the affiliate's OWN rail; unknown/unconfigured rails throw (fail closed),
    // they are NOT silently sent through the mock rail.
    const rail = ctx.rails.get(account.rail);
    result = await rail.disburse({
      payoutId: payout.id,
      affiliateId: payout.affiliateId,
      accountRef: account.accountRef,
      amountCents: payout.amountCents,
      currency: payout.currency,
      idempotencyKey,
    });
  } catch (err) {
    await releaseReservation(ctx, payout.id);
    return db.payouts.update(payout.id, { status: "failed", failureReason: (err as Error).message });
  }

  if (result.status === "paid") {
    await settleReservation(ctx, payout.id);
    await emitWebhook(ctx, payout.merchantId, "payout.paid", { payoutId: payout.id, affiliateId: payout.affiliateId, amountCents: payout.amountCents });
  } else if (result.status === "failed") {
    await releaseReservation(ctx, payout.id);
  }
  return db.payouts.update(payout.id, { status: result.status, failureReason: result.failureReason });
}

/** Reserved entries for a payout → paid. */
async function settleReservation(ctx: AppContext, payoutId: string): Promise<void> {
  const entries = await ctx.db.ledger.find((e) => e.status === "processing" && e.metadata?.["payoutId"] === payoutId);
  for (const e of entries) await ctx.db.ledger.update(e.id, { status: "paid" });
}

/** Reserved entries for a payout → back to approved (claim released). */
async function releaseReservation(ctx: AppContext, payoutId: string): Promise<void> {
  const entries = await ctx.db.ledger.find((e) => e.status === "processing" && e.metadata?.["payoutId"] === payoutId);
  for (const e of entries) await ctx.db.ledger.update(e.id, { status: "approved" });
}

/** Retry a single failed payout (Section 9). Re-reserves, then retries with a STABLE key. */
export async function retryPayout(ctx: AppContext, payoutId: string): Promise<Payout> {
  const { db } = ctx;
  const payout = await db.payouts.require(payoutId);
  if (payout.status !== "failed") throw conflict(`payout is ${payout.status}, not failed`);
  // Re-reserve the entries this payout funds (they were released on failure).
  await reserveEntries(ctx, payout);
  // Stable idempotency key (the payout id) so an ambiguous prior response cannot
  // produce a duplicate transfer at the rail.
  return disburseOne(ctx, payout, payout.id);
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
