import { newId, computeBalances, type Balance, type LedgerEntry } from "@affiliate/core";
import type { Database, PayoutAccount, PayoutBatch, Payout } from "@affiliate/db";
import type { PayoutRail, PayoutResult } from "@affiliate/integrations";
import type { AppContext } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { writeAudit } from "./audit.js";
import { emitWebhook } from "./webhooks.js";

/**
 * Operator-grade payout console (Section 9) over the orchestration-without-custody
 * model (Section 4). Compute payable balances → gate on tax form + threshold →
 * batch → merchant approval → the money leaves → settle.
 *
 * Money never passes through the platform. On approval each payout takes one of two
 * routes, decided per merchant by `ctx.rails.resolveRail`:
 *  - MANUAL (`awaiting_payment`): the merchant pays from their own account, helped by an
 *    export file, then marks the payout paid or failed;
 *  - AUTOMATED (`processing`): a rail the merchant connected with their own credentials.
 *
 * Every operation here runs under the merchant's money lock, and every group of writes
 * in one transaction (see `withMoneyLock` / `moneyTransaction`).
 */

// ---- Locking and transactions for the whole money path -----------------------

/** One key per merchant for everything that moves money: ingestion, refunds, approvals, payouts. */
export const moneyLockKey = (merchantId: string): string => `money:${merchantId}`;

/**
 * Run a multi-step money operation while no other one runs for the same merchant — in this
 * process or any other. Use for anything that is more than a single transaction.
 */
export function withMoneyLock<R>(ctx: AppContext, merchantId: string, fn: () => Promise<R>): Promise<R> {
  return ctx.db.withLock(moneyLockKey(merchantId), fn);
}

/**
 * One atomic step of a money operation: a transaction that also takes the merchant's money
 * lock on its own connection, so two money transactions of one merchant can never
 * interleave — even between processes, even if an outer `withMoneyLock` were lost.
 *
 * `fn` receives a context whose `db` IS the transaction. Pass that context to every helper;
 * never reach for the outer one inside. No external calls in here: they cannot be undone.
 */
export function moneyTransaction<R>(ctx: AppContext, merchantId: string, fn: (tx: AppContext) => Promise<R>): Promise<R> {
  return ctx.db.transaction((db) => fn({ ...ctx, db }), { lock: moneyLockKey(merchantId) });
}

/** A webhook to send once the transaction that caused it has committed. */
export interface PendingEvent {
  merchantId: string;
  type: string;
  payload: unknown;
}

/**
 * Webhooks go out AFTER commit: one must never announce something that was then rolled
 * back. A failure to record or send one must not undo or mask the committed work either.
 */
export async function emitAfterCommit(ctx: AppContext, events: PendingEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await emitWebhook(ctx, event.merchantId, event.type, event.payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[webhooks] could not emit ${event.type} for ${event.merchantId}: ${(err as Error).message}`);
    }
  }
}

// ---- Payable balances --------------------------------------------------------

export interface PayableLine {
  affiliateId: string;
  affiliateName: string;
  currency: string;
  availableCents: number;
  onHoldCents: number;
  pendingCents: number;
  /** Already reserved by an open payout (draft, awaiting payment or with a rail). */
  processingCents: number;
  taxOnFile: boolean;
  payoutAccountRef: string | null;
  rail: string | null;
  eligible: boolean;
  blockedReason: string | null;
}

/** The account a payout goes to: the affiliate's most recently added ACTIVE one for the currency. */
async function currentPayoutAccount(db: Database, affiliateId: string, currency: string): Promise<PayoutAccount | null> {
  const accounts = await db.payoutAccounts.find((a) => a.affiliateId === affiliateId && a.currency === currency && a.status === "active");
  return accounts[accounts.length - 1] ?? null;
}

export async function computePayableLines(
  ctx: AppContext,
  merchantId: string,
  minPayoutCents: number,
  /** "Now" for hold periods. A batch passes the instant it reserves at, so both agree to the millisecond. */
  now: Date = ctx.clock.now(),
): Promise<PayableLine[]> {
  const { db } = ctx;
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
      const account = await currentPayoutAccount(db, affiliateId, currency);
      const { eligible, blockedReason } = payoutEligibility(b, !!taxDoc, account?.accountRef ?? null, minPayoutCents);
      lines.push({
        affiliateId,
        affiliateName: affiliate?.name ?? affiliateId,
        currency,
        availableCents: b.availableCents,
        onHoldCents: b.onHoldCents,
        pendingCents: b.pendingCents,
        processingCents: b.processingCents,
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

// ---- Reservation -------------------------------------------------------------
//
// A payout RESERVES the ledger entries it pays: they move to `processing`, stamped with the
// payout id, and leave the available balance — so no second payout can claim them. The
// payout's amount is always the sum of what it has reserved, never a number carried over
// from somewhere else. Settled → `paid`; released → back to `approved`.

/**
 * Reserve EXACTLY the entries that are payable to the affiliate right now — negative ones
 * (clawbacks, negative adjustments) included — and return their sum. Reserving only "enough
 * positive entries to cover an amount" left a later negative entry netted into the amount
 * but still `approved`, so it was deducted again from the next payout.
 */
async function reservePayable(tx: AppContext, payout: Pick<Payout, "id" | "merchantId" | "affiliateId" | "currency">, now: Date): Promise<number> {
  const nowMs = now.getTime();
  const entries = (
    await tx.db.ledger.find(
      (e) => e.merchantId === payout.merchantId && e.affiliateId === payout.affiliateId && e.currency === payout.currency && e.status === "approved",
    )
  ).filter((e) => !e.availableAt || new Date(e.availableAt).getTime() <= nowMs);

  let sum = 0;
  for (const entry of entries) {
    await tx.db.ledger.update(entry.id, { status: "processing", metadata: { ...entry.metadata, payoutId: payout.id } });
    sum += entry.amountCents;
  }
  return sum;
}

const reservedBy = (tx: AppContext, payoutId: string): Promise<LedgerEntry[]> =>
  tx.db.ledger.find((e) => e.status === "processing" && e.metadata?.["payoutId"] === payoutId);

/** Reserved entries for a payout → paid. They keep the payout id: it records what paid them. */
async function settleReservation(tx: AppContext, payoutId: string): Promise<void> {
  for (const e of await reservedBy(tx, payoutId)) await tx.db.ledger.update(e.id, { status: "paid" });
}

/** Reserved entries for a payout → back to approved (claim released). */
async function releaseReservation(tx: AppContext, payoutId: string): Promise<void> {
  for (const e of await reservedBy(tx, payoutId)) {
    const { payoutId: _released, ...metadata } = e.metadata;
    await tx.db.ledger.update(e.id, { status: "approved", metadata });
  }
}

/** A batch's status follows from its payouts. */
export function deriveBatchStatus(payouts: readonly Pick<Payout, "status">[]): PayoutBatch["status"] {
  const live = payouts.filter((p) => p.status !== "cancelled");
  if (live.length === 0) return "cancelled";
  if (live.some((p) => p.status === "pending")) return "draft";
  if (live.some((p) => p.status === "processing" || p.status === "awaiting_payment" || p.status === "held")) return "processing";
  if (live.some((p) => p.status === "failed")) return "failed";
  return "paid";
}

async function refreshBatchStatus(tx: AppContext, batchId: string | null): Promise<void> {
  if (!batchId) return;
  const payouts = await tx.db.payouts.find((p) => p.batchId === batchId);
  await tx.db.payoutBatches.update(batchId, { status: deriveBatchStatus(payouts) });
}

/**
 * A draft payout lost one of its entries (a refund landed before approval): bring its
 * amount back in line with what it still has reserved, or withdraw it when nothing is left.
 * Called by the refund path, inside the same transaction.
 */
export async function resyncDraftPayout(tx: AppContext, payoutId: string): Promise<void> {
  const payout = await tx.db.payouts.get(payoutId);
  if (!payout || payout.status !== "pending") return;
  const amountCents = (await reservedBy(tx, payoutId)).reduce((s, e) => s + e.amountCents, 0);
  if (amountCents > 0) {
    await tx.db.payouts.update(payoutId, { amountCents });
    return;
  }
  await releaseReservation(tx, payoutId);
  await tx.db.payouts.update(payoutId, { status: "cancelled", amountCents: 0, failureReason: "nothing left to pay after a refund" });
  await refreshBatchStatus(tx, payout.batchId);
}

// ---- Batches -----------------------------------------------------------------

export interface BatchResult {
  batch: PayoutBatch;
  payouts: Payout[];
  skipped: PayableLine[];
}

/**
 * Create a draft payout batch and RESERVE the claimed ledger entries.
 *
 * Runs under the merchant's money lock and in one transaction: two requests at the same
 * moment (a double click, two operators) are served one after the other, and the second
 * finds the balance already reserved — its batch is empty. A failure part-way leaves
 * nothing behind.
 */
export async function createPayoutBatch(
  ctx: AppContext,
  merchantId: string,
  currency: string,
  minPayoutCents: number,
): Promise<BatchResult> {
  return withMoneyLock(ctx, merchantId, () =>
    moneyTransaction(ctx, merchantId, async (tx) => {
      // ONE instant decides what is past its hold period, for the lines and the reservation alike.
      const at = tx.clock.now();
      const lines = (await computePayableLines(tx, merchantId, minPayoutCents, at)).filter((l) => l.currency === currency);
      const eligible = lines.filter((l) => l.eligible);
      const skipped = lines.filter((l) => !l.eligible);
      const now = at.toISOString();

      const batch: PayoutBatch = {
        id: newId("batch"),
        merchantId,
        rail: "mixed", // each payout leaves by its own affiliate's method
        currency,
        status: "draft",
        approvedBy: null,
        approvedAt: null,
        ts: now,
      };
      await tx.db.payoutBatches.insert(batch);

      const payouts: Payout[] = [];
      for (const line of eligible) {
        const id = newId("pay");
        const amountCents = await reservePayable(tx, { id, merchantId, affiliateId: line.affiliateId, currency }, at);
        // Both figures come from the same ledger inside this transaction. If they ever
        // differed, stop — do not pay a number nobody can account for.
        if (amountCents !== line.availableCents) {
          throw new Error(`payout reservation mismatch for ${line.affiliateId}: reserved ${amountCents}, payable ${line.availableCents}`);
        }
        const payout: Payout = {
          id,
          batchId: batch.id,
          merchantId,
          affiliateId: line.affiliateId,
          amountCents,
          currency,
          method: line.rail ?? "manual",
          status: "pending",
          failureReason: null,
          mode: null,
          accountRef: line.payoutAccountRef,
          reference: null,
          attempt: 1,
          paidAt: null,
          ts: now,
        };
        await tx.db.payouts.insert(payout);
        payouts.push(payout);
      }
      return { batch, payouts, skipped };
    }),
  );
}

/**
 * Give a payout its final amount (what it has reserved — refunds since the draft are
 * already out) and its destination (the affiliate's current account). Returns null when
 * there is nothing to send: it is then cancelled or failed, with its reservation released.
 */
async function finalizePayout(tx: AppContext, payout: Payout): Promise<Payout | null> {
  const amountCents = (await reservedBy(tx, payout.id)).reduce((s, e) => s + e.amountCents, 0);
  if (amountCents <= 0) {
    await releaseReservation(tx, payout.id);
    await tx.db.payouts.update(payout.id, { status: "cancelled", amountCents: 0, failureReason: "nothing left to pay" });
    return null;
  }
  const account = await currentPayoutAccount(tx.db, payout.affiliateId, payout.currency);
  if (!account) {
    await releaseReservation(tx, payout.id);
    await tx.db.payouts.update(payout.id, { status: "failed", amountCents, failureReason: "no payout account" });
    return null;
  }
  return tx.db.payouts.update(payout.id, { amountCents, method: account.rail, accountRef: account.accountRef });
}

/** Decide how a finalized payout leaves and record it. Returns the rail to call after commit, if any. */
async function routePayout(tx: AppContext, payout: Payout, opts: { forceManual?: boolean } = {}): Promise<PayoutRail | null> {
  const resolved = opts.forceManual
    ? ({ mode: "manual", reason: "handed over for manual payment" } as const)
    : await tx.rails.resolveRail({ id: payout.merchantId }, payout.method);
  if (resolved.mode === "automated") {
    await tx.db.payouts.update(payout.id, { status: "processing", mode: "automated", failureReason: null });
    return resolved.rail;
  }
  await tx.db.payouts.update(payout.id, { status: "awaiting_payment", mode: "manual", failureReason: null });
  return null;
}

/**
 * Merchant approves a batch. State-guarded: only a draft can be approved, once.
 *
 * Step 1 (one transaction): every payout gets its final amount and its route — manual
 * payouts become `awaiting_payment` and stay reserved until the merchant marks them;
 * payouts with a rail the merchant connected become `processing`. Nothing has been sent.
 * Step 2 (after commit): the automated ones are sent, one result per transaction.
 */
export async function approveAndDisburse(ctx: AppContext, batchId: string, approverId: string): Promise<Payout[]> {
  const found = await ctx.db.payoutBatches.get(batchId);
  if (!found) throw notFound("payout batch");
  const { merchantId } = found;

  return withMoneyLock(ctx, merchantId, async () => {
    const events: PendingEvent[] = [];
    const toSend = await moneyTransaction(ctx, merchantId, async (tx) => {
      const batch = await tx.db.payoutBatches.require(batchId);
      // Idempotency / double-spend guard: only a draft batch can be approved.
      if (batch.status !== "draft") throw conflict(`batch is ${batch.status}, not draft`);

      const sends: Array<{ payoutId: string; rail: PayoutRail }> = [];
      for (const pending of await tx.db.payouts.find((p) => p.batchId === batchId && p.status === "pending")) {
        const payout = await finalizePayout(tx, pending);
        if (!payout) continue;
        const rail = await routePayout(tx, payout);
        if (rail) sends.push({ payoutId: payout.id, rail });
      }
      await tx.db.payoutBatches.update(batchId, { approvedBy: approverId, approvedAt: tx.clock.now().toISOString() });
      await refreshBatchStatus(tx, batchId);
      await writeAudit(tx, { merchantId, actorId: approverId, action: "payout.batch.approved", subjectType: "payout_batch", subjectId: batchId });
      return sends;
    });

    for (const { payoutId, rail } of toSend) await disburse(ctx, merchantId, payoutId, rail, events);
    await emitAfterCommit(ctx, events);
    return ctx.db.payouts.find((p) => p.batchId === batchId);
  });
}

/**
 * Send one `processing` payout through the rail the merchant connected, then record the
 * outcome. The rail call is outside any transaction (it cannot be rolled back); the payout
 * was committed as `processing` first, so a crash here leaves a payout that says so and can
 * be retried with the same idempotency key.
 */
async function disburse(ctx: AppContext, merchantId: string, payoutId: string, rail: PayoutRail, events: PendingEvent[]): Promise<void> {
  const payout = await ctx.db.payouts.require(payoutId);
  let result: PayoutResult;
  try {
    result = await rail.disburse({
      payoutId: payout.id,
      merchantId,
      affiliateId: payout.affiliateId,
      accountRef: payout.accountRef ?? "",
      amountCents: payout.amountCents,
      currency: payout.currency,
      // Stable for an attempt: sent again after an unknown outcome so the rail can deduplicate.
      idempotencyKey: `${payout.id}:${payout.attempt ?? 1}`,
    });
  } catch (err) {
    // UNKNOWN outcome — a timeout or 5xx may or may not have moved the money. Treating it
    // as a failure released the reservation, and the next batch paid the same balance again.
    // The payout stays `processing`, reserved, until a retry gets a definite answer.
    await moneyTransaction(ctx, merchantId, (tx) =>
      tx.db.payouts.update(payoutId, {
        failureReason: `outcome unknown: ${(err as Error).message}. Retry to ask the rail again (same idempotency key), or check the rail before paying another way.`,
      }),
    );
    return;
  }

  await moneyTransaction(ctx, merchantId, async (tx) => {
    const current = await tx.db.payouts.require(payoutId);
    if (current.status !== "processing") return;
    if (result.status === "paid") {
      await settleReservation(tx, payoutId);
      await tx.db.payouts.update(payoutId, { status: "paid", reference: result.railReference, paidAt: tx.clock.now().toISOString(), failureReason: null });
      events.push({ merchantId, type: "payout.paid", payload: { payoutId, affiliateId: current.affiliateId, amountCents: current.amountCents } });
    } else if (result.status === "failed") {
      await releaseReservation(tx, payoutId);
      await tx.db.payouts.update(payoutId, { status: "failed", failureReason: result.failureReason ?? "the rail refused the payout" });
    } else {
      // Accepted, not final yet: stays `processing` and reserved.
      await tx.db.payouts.update(payoutId, { reference: result.railReference, failureReason: null });
    }
    await refreshBatchStatus(tx, current.batchId);
  });
}

/**
 * Retry a payout (Section 9).
 *
 *  - `failed` — it was definitely not paid and its reservation was released. A NEW attempt
 *    reserves what is payable NOW and pays exactly that: entries another payout has paid
 *    since are not payable, so they cannot be paid twice. Nothing payable → 409.
 *  - `processing` — outcome unknown (rail error, asynchronous rail, crash mid-send). The
 *    reservation is still held; the SAME attempt is sent again with the same idempotency key.
 *
 * `manual: true` hands the payout to the merchant instead (`awaiting_payment`) — the way out
 * when a rail will not give a definite answer.
 */
export async function retryPayout(ctx: AppContext, payoutId: string, opts: { manual?: boolean } = {}): Promise<Payout> {
  const found = await ctx.db.payouts.get(payoutId);
  if (!found) throw notFound("payout");
  const { merchantId } = found;

  return withMoneyLock(ctx, merchantId, async () => {
    const events: PendingEvent[] = [];
    const rail = await moneyTransaction(ctx, merchantId, async (tx) => {
      let payout = await tx.db.payouts.require(payoutId);
      if (payout.status === "failed") {
        const amountCents = await reservePayable(tx, payout, tx.clock.now());
        if (amountCents <= 0) {
          throw conflict("nothing is payable for this payout any more — its entries were paid by another payout or reversed");
        }
        // The same gates a new batch applies: a tax form on file and somewhere to send it.
        const taxDoc = await tx.db.taxDocuments.findOne((t) => t.affiliateId === payout.affiliateId && t.status === "on_file");
        if (!taxDoc) throw conflict("the affiliate has no tax form on file");
        const account = await currentPayoutAccount(tx.db, payout.affiliateId, payout.currency);
        if (!account) throw conflict("the affiliate has no active payout account");
        payout = await tx.db.payouts.update(payoutId, {
          amountCents,
          method: account.rail,
          accountRef: account.accountRef,
          attempt: (payout.attempt ?? 1) + 1,
        });
      } else if (payout.status !== "processing") {
        throw conflict(`payout is ${payout.status}; only a failed payout, or one whose outcome is unknown, can be retried`);
      }
      const next = await routePayout(tx, payout, { forceManual: opts.manual === true });
      await refreshBatchStatus(tx, payout.batchId);
      return next;
    });

    if (rail) await disburse(ctx, merchantId, payoutId, rail, events);
    await emitAfterCommit(ctx, events);
    return ctx.db.payouts.require(payoutId);
  });
}

/** The merchant paid a manual payout from their own account: settle its reservation. */
export async function markPayoutPaid(ctx: AppContext, payoutId: string, actorId: string | null, reference?: string | null): Promise<Payout> {
  const found = await ctx.db.payouts.get(payoutId);
  if (!found) throw notFound("payout");
  const { merchantId } = found;

  return withMoneyLock(ctx, merchantId, async () => {
    const events: PendingEvent[] = [];
    const updated = await moneyTransaction(ctx, merchantId, async (tx) => {
      const payout = await tx.db.payouts.require(payoutId);
      if (payout.status !== "awaiting_payment") throw conflict(`payout is ${payout.status}, not awaiting_payment`);
      await settleReservation(tx, payoutId);
      const paid = await tx.db.payouts.update(payoutId, {
        status: "paid",
        reference: reference?.trim() || null,
        paidAt: tx.clock.now().toISOString(),
        failureReason: null,
      });
      await refreshBatchStatus(tx, payout.batchId);
      await writeAudit(tx, {
        merchantId,
        actorId,
        action: "payout.marked_paid",
        subjectType: "payout",
        subjectId: payoutId,
        metadata: { amountCents: payout.amountCents, currency: payout.currency, reference: paid.reference ?? null },
      });
      events.push({ merchantId, type: "payout.paid", payload: { payoutId, affiliateId: payout.affiliateId, amountCents: payout.amountCents } });
      return paid;
    });
    await emitAfterCommit(ctx, events);
    return updated;
  });
}

/** A manual payout did not go through: release its reservation so the balance is payable again. */
export async function markPayoutFailed(ctx: AppContext, payoutId: string, actorId: string | null, reason: string): Promise<Payout> {
  const found = await ctx.db.payouts.get(payoutId);
  if (!found) throw notFound("payout");
  const { merchantId } = found;

  return withMoneyLock(ctx, merchantId, () =>
    moneyTransaction(ctx, merchantId, async (tx) => {
      const payout = await tx.db.payouts.require(payoutId);
      if (payout.status !== "awaiting_payment") throw conflict(`payout is ${payout.status}, not awaiting_payment`);
      await releaseReservation(tx, payoutId);
      const failed = await tx.db.payouts.update(payoutId, { status: "failed", failureReason: reason });
      await refreshBatchStatus(tx, payout.batchId);
      await writeAudit(tx, {
        merchantId,
        actorId,
        action: "payout.marked_failed",
        subjectType: "payout",
        subjectId: payoutId,
        metadata: { amountCents: payout.amountCents, currency: payout.currency, reason },
      });
      return failed;
    }),
  );
}

/** Withdraw a draft batch: every reservation is released and nothing is sent. */
export async function cancelPayoutBatch(ctx: AppContext, batchId: string, actorId: string | null): Promise<PayoutBatch> {
  const found = await ctx.db.payoutBatches.get(batchId);
  if (!found) throw notFound("payout batch");
  const { merchantId } = found;

  return withMoneyLock(ctx, merchantId, () =>
    moneyTransaction(ctx, merchantId, async (tx) => {
      const batch = await tx.db.payoutBatches.require(batchId);
      if (batch.status !== "draft") throw conflict(`batch is ${batch.status}; only a draft can be cancelled`);
      for (const payout of await tx.db.payouts.find((p) => p.batchId === batchId && p.status === "pending")) {
        await releaseReservation(tx, payout.id);
        await tx.db.payouts.update(payout.id, { status: "cancelled", failureReason: "batch cancelled" });
      }
      await writeAudit(tx, { merchantId, actorId, action: "payout.batch.cancelled", subjectType: "payout_batch", subjectId: batchId });
      return tx.db.payoutBatches.update(batchId, { status: "cancelled" });
    }),
  );
}

/** Manual adjustment (bonus, correction, negative-balance write-off) — Section 9. */
export async function addAdjustment(
  ctx: AppContext,
  params: { merchantId: string; affiliateId: string; amountCents: number; currency: string; reason: string; createdBy: string },
): Promise<void> {
  await withMoneyLock(ctx, params.merchantId, () =>
    moneyTransaction(ctx, params.merchantId, async (tx) => {
      const now = tx.clock.now().toISOString();
      await tx.db.payoutAdjustments.insert({ id: newId("adj"), ...params, ts: now });
      await tx.db.ledger.insert({
        id: newId("led"),
        merchantId: params.merchantId,
        affiliateId: params.affiliateId,
        conversionId: null,
        type: "adjustment",
        amountCents: params.amountCents,
        currency: params.currency,
        status: "approved",
        availableAt: now,
        ts: now,
        reversesEntryId: null,
        metadata: { reason: params.reason, createdBy: params.createdBy },
      });
    }),
  );
}

// ---- Export for manual payment -----------------------------------------------

export type PayoutExportFormat = "paypal" | "wise" | "csv";

export interface PayoutExport {
  filename: string;
  csv: string;
  /** Payouts written to the file. */
  included: number;
  /** Payouts awaiting payment that are NOT in it because they use another method. */
  omitted: number;
}

/**
 * One CSV cell. Names and account references come from affiliates and the file is opened
 * in a spreadsheet, so anything that would be read as a formula is forced to text.
 */
function csvCell(value: string | null | undefined): string {
  let v = (value ?? "").replace(/[\r\n]+/g, " ").trim();
  // A bare international phone number (a valid PayPal recipient) is inert; leave it usable.
  if (/^[=+\-@\t]/.test(v) && !/^\+\d{6,15}$/.test(v)) v = `'${v}`;
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const csvLine = (cells: Array<string | null | undefined>): string => cells.map(csvCell).join(",");

/** Minor units as a plain decimal ("20.00"). The platform assumes two-decimal currencies throughout. */
const decimalAmount = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

const hexId = (payoutId: string): string => payoutId.replace(/^pay_/, "").replace(/-/g, "");
const looksLikeEmail = (v: string | null | undefined): v is string => !!v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
const asIban = (v: string | null | undefined): string | null => {
  const compact = (v ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact) ? compact : null;
};

/**
 * The file a merchant uses to pay a batch from their own account. It lists the payouts
 * that are `awaiting_payment` — so downloading again after marking some paid gives only
 * what is still owed. A draft cannot be exported: its amounts are not final.
 *
 *  - `csv`    every payout, generic columns;
 *  - `paypal` payouts by PayPal, in the PayPal mass-payment layout (no header row:
 *             recipient, amount, currency, unique id, note);
 *  - `wise`   payouts by Wise, in the Wise batch-transfer layout.
 *
 * The PayPal and Wise layouts are written from their published file formats and have NOT
 * been validated by an upload — check the first file against the provider's current
 * template. A row the layout cannot express safely is left incomplete rather than guessed
 * (Wise: receiverType is never invented; an account reference that is neither an email nor
 * an IBAN leaves the recipient blank).
 */
export async function exportPayoutBatch(ctx: AppContext, batchId: string, format: PayoutExportFormat, actorId: string | null): Promise<PayoutExport> {
  const batch = await ctx.db.payoutBatches.get(batchId);
  if (!batch) throw notFound("payout batch");
  if (batch.status === "draft") throw conflict("approve the batch before exporting it: amounts are final only once it is approved");

  const awaiting = await ctx.db.payouts.find((p) => p.batchId === batchId && p.status === "awaiting_payment");
  const rows = format === "csv" ? awaiting : awaiting.filter((p) => p.method.trim().toLowerCase() === format);
  if (rows.length === 0) {
    throw conflict(
      awaiting.length === 0
        ? "no payouts in this batch are awaiting payment"
        : `none of the ${awaiting.length} payouts awaiting payment use ${format} — download the generic CSV instead`,
    );
  }
  const merchant = await ctx.db.merchants.get(batch.merchantId);

  const lines: string[] = [];
  if (format === "csv") lines.push(csvLine(["affiliate", "email", "method", "account_reference", "amount", "currency", "payout_id"]));
  if (format === "wise") {
    lines.push(csvLine(["name", "recipientEmail", "paymentReference", "receiverType", "amountCurrency", "amount", "sourceCurrency", "targetCurrency", "IBAN"]));
  }
  for (const payout of rows) {
    const affiliate = await ctx.db.affiliates.get(payout.affiliateId);
    const amount = decimalAmount(payout.amountCents);
    if (format === "csv") {
      lines.push(csvLine([affiliate?.name, affiliate?.primaryEmail, payout.method, payout.accountRef, amount, payout.currency, payout.id]));
    } else if (format === "paypal") {
      // PayPal's unique id is limited to 30 characters; the full payout id is in the note.
      lines.push(csvLine([payout.accountRef, amount, payout.currency, hexId(payout.id).slice(0, 30), `Affiliate commission payout ${payout.id}`]));
    } else {
      lines.push(
        csvLine([
          affiliate?.name,
          looksLikeEmail(payout.accountRef) ? payout.accountRef : "",
          hexId(payout.id).slice(0, 10),
          "",
          "target",
          amount,
          merchant?.defaultCurrency ?? payout.currency,
          payout.currency,
          asIban(payout.accountRef) ?? "",
        ]),
      );
    }
  }

  await writeAudit(ctx, {
    merchantId: batch.merchantId,
    actorId,
    action: "payout.batch.exported",
    subjectType: "payout_batch",
    subjectId: batchId,
    metadata: { format, payouts: rows.length },
  });
  return { filename: `payouts-${batchId}-${format}.csv`, csv: lines.join("\r\n") + "\r\n", included: rows.length, omitted: awaiting.length - rows.length };
}
