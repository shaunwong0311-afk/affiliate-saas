import { describe, it, expect } from "vitest";
import {
  addAdjustment,
  approveAndDisburse,
  cancelPayoutBatch,
  computePayableLines,
  createPayoutBatch,
  deriveBatchStatus,
  exportPayoutBatch,
  markPayoutFailed,
  markPayoutPaid,
  retryPayout,
} from "../src/services/payout-service.js";
import { reverseOrder } from "../src/services/reversal.js";
import { moneyOps } from "../src/services/reporting.js";
import { addSeller, balanceOf, connectedRail, ledgerOf, paid, payoutsOf, sale, world } from "./support.js";

// ---- M4 ----------------------------------------------------------------------
describe("a refund that lands while a payout holds the entry (M4)", () => {
  it("draft batch: the entry leaves the payout and the refunded commission is never sent", async () => {
    const { ctx, db } = await world();
    const kept = await sale(ctx, "t1", 10_000);
    const refunded = await sale(ctx, "t2", 5_000);
    void kept;
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    expect(payouts[0]!.amountCents).toBe(3_000);

    await reverseOrder(ctx, refunded.orderId, "customer refund");
    expect((await db.payouts.require(payouts[0]!.id)).amountCents).toBe(2_000); // re-derived from what is still reserved

    await approveAndDisburse(ctx, batch.id, "u1");
    expect(ctx.rails.mock!.sent.map((s) => s.amountCents)).toEqual([2_000]); // was 3,000
    expect(await ledgerOf(db)).toEqual(["commission:2000:paid", "commission:1000:reversed", "reversal:-1000:reversed"]);
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 2_000, availableCents: 0, processingCents: 0 });
  });

  it("draft batch: a payout left with nothing is withdrawn, and so is a batch left with no payouts", async () => {
    const { ctx, db } = await world();
    const { orderId } = await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await reverseOrder(ctx, orderId, "customer refund");
    expect(await payoutsOf(db)).toEqual(["0:cancelled"]);
    expect((await db.payoutBatches.require(batch.id)).status).toBe("cancelled");
    await expect(approveAndDisburse(ctx, batch.id, "u1")).rejects.toMatchObject({ statusCode: 409 });
    expect(ctx.rails.mock!.sent).toHaveLength(0); // the refunded $20 used to be sent anyway
  });

  it("approved, awaiting the merchant's payment: the entry stays in the payout and is clawed back", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    const { orderId } = await sale(ctx, "t1", 10_000);
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, batch.id, "u1");
    expect(await payoutsOf(db)).toEqual(["2000:awaiting_payment"]);

    // The merchant may already have paid from the export file — the amount must not change.
    await reverseOrder(ctx, orderId, "customer refund");
    expect(await payoutsOf(db)).toEqual(["2000:awaiting_payment"]);
    expect(await ledgerOf(db)).toEqual(["commission:2000:processing", "reversal:-2000:approved"]);
    expect(await balanceOf(ctx)).toMatchObject({ processingCents: 2_000, availableCents: -2_000 });

    await markPayoutPaid(ctx, payouts[0]!.id, "u1", "PP-123");
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 2_000, availableCents: -2_000, processingCents: 0 }); // owes it back
  });

  it("approved, then the manual payment fails: the released entry and the clawback cancel out", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    const { orderId } = await sale(ctx, "t1", 10_000);
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, batch.id, "u1");
    await reverseOrder(ctx, orderId, "customer refund");
    await markPayoutFailed(ctx, payouts[0]!.id, "u1", "account closed");
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 0, availableCents: 0, processingCents: 0 });
    expect((await computePayableLines(ctx, "m1", 1)).filter((l) => l.eligible)).toHaveLength(0);
    void db;
  });

  it("two refunds of one order at once claw back once", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    const { orderId } = await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, batch.id, "u1");
    const results = await Promise.all([reverseOrder(ctx, orderId, "refund"), reverseOrder(ctx, orderId, "refund")]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await db.ledger.all()).filter((e) => e.type === "reversal")).toHaveLength(1);
  });
});

// ---- M5 ----------------------------------------------------------------------
describe("rail errors and retries (M5)", () => {
  it("an error with an unknown outcome keeps the reservation: the next batch cannot pay the balance again", async () => {
    const rail = connectedRail("flaky", (request, call) => {
      if (call === 1) throw new Error("rail timeout");
      return paid(request);
    });
    const { ctx, db } = await world({ method: "flaky", rails: rail.rails });
    await sale(ctx, "t1", 10_000);

    const b1 = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [stuck] = await approveAndDisburse(ctx, b1.batch.id, "u1");
    expect(stuck).toMatchObject({ status: "processing", amountCents: 2_000 });
    expect(stuck!.failureReason).toMatch(/outcome unknown: rail timeout/);
    expect(await ledgerOf(db)).toEqual(["commission:2000:processing"]); // still reserved
    expect((await db.payoutBatches.require(b1.batch.id)).status).toBe("processing");

    // What used to happen next: a second batch found the balance free and paid it.
    const b2 = await createPayoutBatch(ctx, "m1", "USD", 1);
    expect(b2.payouts).toHaveLength(0);

    // The retry asks the rail again with the SAME idempotency key.
    const retried = await retryPayout(ctx, stuck!.id);
    expect(retried.status).toBe("paid");
    expect(rail.sent.map((s) => `${s.amountCents}:${s.idempotencyKey}`)).toEqual([`2000:${stuck!.id}:1`]);
    expect(rail.calls()).toBe(2);
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 2_000, availableCents: 0, processingCents: 0 });
    expect((await db.payoutBatches.require(b1.batch.id)).status).toBe("paid");
  });

  it("a definite failure releases the balance; retrying the old payout after another one paid it is refused", async () => {
    let refuse = true;
    const rail = connectedRail("strict", (request) => (refuse ? { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: "account closed" } : paid(request)));
    const { ctx, db } = await world({ method: "strict", rails: rail.rails });
    await sale(ctx, "t1", 10_000);

    const b1 = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [failed] = await approveAndDisburse(ctx, b1.batch.id, "u1");
    expect(failed).toMatchObject({ status: "failed", failureReason: "account closed" });
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
    expect((await db.payoutBatches.require(b1.batch.id)).status).toBe("failed");

    refuse = false;
    const b2 = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, b2.batch.id, "u1");
    expect(await payoutsOf(db)).toEqual(["2000:failed", "2000:paid"]);

    // Retry used to re-reserve "whatever is available" and send the ORIGINAL amount again.
    await expect(retryPayout(ctx, failed!.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/nothing is payable/) });
    expect(rail.sent.map((s) => s.amountCents)).toEqual([2_000]); // one payment for one commission
    expect(await payoutsOf(db)).toEqual(["2000:failed", "2000:paid"]);
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 2_000, availableCents: 0, processingCents: 0 });
  });

  it("retrying a failed payout pays what is payable NOW, as a new attempt", async () => {
    let refuse = true;
    const rail = connectedRail("strict", (request) => (refuse ? { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: "try later" } : paid(request)));
    const { ctx, db, clock } = await world({ method: "strict", rails: rail.rails });
    await sale(ctx, "t1", 10_000);
    const b1 = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [failed] = await approveAndDisburse(ctx, b1.batch.id, "u1");
    // Between the failure and the retry: one more sale, one correction.
    clock.advance(1_000);
    await sale(ctx, "t2", 5_000);
    await addAdjustment(ctx, { merchantId: "m1", affiliateId: "a1", amountCents: -500, currency: "USD", reason: "correction", createdBy: "u1" });

    refuse = false;
    const retried = await retryPayout(ctx, failed!.id);
    expect(retried).toMatchObject({ status: "paid", amountCents: 2_500, attempt: 2 }); // 2000 + 1000 − 500
    expect(rail.sent.at(-1)).toMatchObject({ amountCents: 2_500, idempotencyKey: `${failed!.id}:2`, merchantId: "m1" });
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 2_500, availableCents: 0, processingCents: 0 });
    void db;
  });

  it("a payout whose rail never answers can be handed to the merchant instead", async () => {
    const rail = connectedRail("down", () => {
      throw new Error("ECONNRESET");
    });
    const { ctx, db } = await world({ method: "down", rails: rail.rails });
    await sale(ctx, "t1", 10_000);
    const b1 = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [stuck] = await approveAndDisburse(ctx, b1.batch.id, "u1");
    expect((await retryPayout(ctx, stuck!.id)).status).toBe("processing"); // still unknown
    const manual = await retryPayout(ctx, stuck!.id, { manual: true });
    expect(manual).toMatchObject({ status: "awaiting_payment", mode: "manual" });
    expect(await ledgerOf(db)).toEqual(["commission:2000:processing"]);
    expect((await markPayoutPaid(ctx, stuck!.id, "u1")).status).toBe("paid");
  });

  it("only failed or unresolved payouts can be retried", async () => {
    const { ctx } = await world();
    await sale(ctx, "t1", 10_000);
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await expect(retryPayout(ctx, payouts[0]!.id)).rejects.toMatchObject({ statusCode: 409 }); // pending
    await approveAndDisburse(ctx, batch.id, "u1");
    await expect(retryPayout(ctx, payouts[0]!.id)).rejects.toMatchObject({ statusCode: 409 }); // paid
    await expect(retryPayout(ctx, "pay_missing")).rejects.toMatchObject({ statusCode: 404 });
    expect(ctx.rails.mock!.sent).toHaveLength(1);
  });
});

// ---- M6 ----------------------------------------------------------------------
describe("a payout reserves exactly the entries it pays, negatives included (M6)", () => {
  it("a negative adjustment is settled with the payout that netted it, not deducted again later", async () => {
    const { ctx, db, clock } = await world();
    await sale(ctx, "t1", 50_000);
    clock.advance(1_000);
    await addAdjustment(ctx, { merchantId: "m1", affiliateId: "a1", amountCents: -3_000, currency: "USD", reason: "correction", createdBy: "u1" });

    const b1 = await createPayoutBatch(ctx, "m1", "USD", 1);
    expect(b1.payouts[0]!.amountCents).toBe(7_000);
    expect(await ledgerOf(db)).toEqual(["commission:10000:processing", "adjustment:-3000:processing"]);
    await approveAndDisburse(ctx, b1.batch.id, "u1");
    expect(await ledgerOf(db)).toEqual(["commission:10000:paid", "adjustment:-3000:paid"]);
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 7_000, availableCents: 0 }); // ledger "paid" == payouts

    clock.advance(1_000);
    await sale(ctx, "t2", 50_000);
    const b2 = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, b2.batch.id, "u1");
    const sent = ctx.rails.mock!.sent.map((s) => s.amountCents);
    expect(sent).toEqual([7_000, 10_000]); // was [7000, 7000]: the adjustment was taken twice
    expect(sent.reduce((a, b) => a + b, 0)).toBe(10_000 - 3_000 + 10_000);
  });

  it("an affiliate who owes more than they earned is not paid, and the debt carries forward", async () => {
    const { ctx, db } = await world();
    await sale(ctx, "t1", 10_000);
    await addAdjustment(ctx, { merchantId: "m1", affiliateId: "a1", amountCents: -5_000, currency: "USD", reason: "chargeback", createdBy: "u1" });
    const { payouts, skipped } = await createPayoutBatch(ctx, "m1", "USD", 1);
    expect(payouts).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ affiliateId: "a1", availableCents: -3_000, blockedReason: "no available balance" });
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved", "adjustment:-5000:approved"]);
  });

  it("decides what is past its hold period at ONE instant, however long the batch takes to build", async () => {
    const { ctx, db } = await world();
    await sale(ctx, "t1", 10_000);
    await sale(ctx, "t2", 5_000);
    // The second commission leaves its hold period two milliseconds from now — while the
    // batch is being built. Reading the clock once for the payable lines and again for the
    // reservation made the two disagree (2,000 payable, 3,000 reserved).
    const start = ctx.clock.now().getTime();
    const [, second] = await db.ledger.all();
    await db.ledger.update(second!.id, { availableAt: new Date(start + 2).toISOString() });
    let ticks = 0;
    const ticking = { ...ctx, clock: { now: () => new Date(start + (ticks += 1)) } }; // time passes on every look at the clock

    const { payouts } = await createPayoutBatch(ticking, "m1", "USD", 1);
    expect(payouts.map((p) => p.amountCents)).toEqual([2_000]);
    expect(await ledgerOf(db)).toEqual(["commission:2000:processing", "commission:1000:approved"]);
    // It is payable a moment later, for the next batch.
    expect((await createPayoutBatch(ticking, "m1", "USD", 1)).payouts.map((p) => p.amountCents)).toEqual([1_000]);
  });

  it("pays to the affiliate's most recent active account", async () => {
    const { ctx, db } = await world({ method: "paypal", accountRef: "old@x.test" });
    await db.payoutAccounts.insert({ id: "pa_new", affiliateId: "a1", rail: "wise", accountRef: "new@x.test", status: "active", currency: "USD" });
    await db.payoutAccounts.insert({ id: "pa_off", affiliateId: "a1", rail: "paypal", accountRef: "disabled@x.test", status: "disabled", currency: "USD" });
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [payout] = await approveAndDisburse(ctx, batch.id, "u1");
    expect(payout).toMatchObject({ method: "wise", accountRef: "new@x.test", status: "awaiting_payment" });
  });
});

// ---- M15 ---------------------------------------------------------------------
describe("no custody: manual payouts (M15)", () => {
  it("a payout the merchant has not connected a rail for waits as awaiting_payment, still reserved", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [payout] = await approveAndDisburse(ctx, batch.id, "u1");
    expect(payout).toMatchObject({ status: "awaiting_payment", mode: "manual", amountCents: 2_000, method: "paypal", accountRef: "a1@x.test" });
    expect(await ledgerOf(db)).toEqual(["commission:2000:processing"]);
    const stored = await db.payoutBatches.require(batch.id);
    expect(stored).toMatchObject({ status: "processing", approvedBy: "u1" });
    expect(stored.approvedAt).toBeTruthy();
    // Reserved: a second batch cannot claim it while the merchant has not paid.
    expect((await createPayoutBatch(ctx, "m1", "USD", 1)).payouts).toHaveLength(0);
    expect(await moneyOps(ctx, "m1")).toMatchObject({ unpaidLiabilityCents: 2_000, inPayoutsCents: 2_000, awaitingPaymentCents: 2_000, payableNowCents: 0, paidCents: 0 });
  });

  it("mark-paid settles the reservation; mark-failed releases it; both only from awaiting_payment", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    await addSeller(ctx, "a2", { method: "wise" });
    await sale(ctx, "t1", 10_000);
    await sale(ctx, "t2", 30_000, { affiliateId: "a2" });
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const p1 = payouts.find((p) => p.affiliateId === "a1")!;
    const p2 = payouts.find((p) => p.affiliateId === "a2")!;

    await expect(markPayoutPaid(ctx, p1.id, "u1")).rejects.toMatchObject({ statusCode: 409 }); // still pending
    await expect(markPayoutFailed(ctx, p1.id, "u1", "x")).rejects.toMatchObject({ statusCode: 409 });
    await approveAndDisburse(ctx, batch.id, "u1");

    const settled = await markPayoutPaid(ctx, p1.id, "u1", "  PAYPAL-TX-9  ");
    expect(settled).toMatchObject({ status: "paid", reference: "PAYPAL-TX-9" });
    expect(settled.paidAt).toBeTruthy();
    expect(await balanceOf(ctx, "a1")).toMatchObject({ paidCents: 2_000, processingCents: 0 });
    expect((await db.payoutBatches.require(batch.id)).status).toBe("processing"); // a2 still outstanding

    const failed = await markPayoutFailed(ctx, p2.id, "u1", "recipient not found");
    expect(failed).toMatchObject({ status: "failed", failureReason: "recipient not found" });
    expect(await balanceOf(ctx, "a2")).toMatchObject({ paidCents: 0, availableCents: 6_000, processingCents: 0 }); // payable again
    expect((await db.payoutBatches.require(batch.id)).status).toBe("failed");

    await expect(markPayoutPaid(ctx, p1.id, "u1")).rejects.toMatchObject({ statusCode: 409 }); // already paid
    await expect(markPayoutPaid(ctx, p2.id, "u1")).rejects.toMatchObject({ statusCode: 409 }); // failed
    await expect(markPayoutPaid(ctx, "pay_missing", "u1")).rejects.toMatchObject({ statusCode: 404 });

    const audit = (await db.auditLogs.all()).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["payout.batch.approved", "payout.marked_paid", "payout.marked_failed"]));
  });

  it("marking a payout paid twice at once settles it once", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    await sale(ctx, "t1", 10_000);
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, batch.id, "u1");
    const outcomes = await Promise.allSettled([markPayoutPaid(ctx, payouts[0]!.id, "u1"), markPayoutPaid(ctx, payouts[0]!.id, "u2"), markPayoutFailed(ctx, payouts[0]!.id, "u3", "oops")]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await ledgerOf(db)).toEqual(["commission:2000:paid"]);
  });

  it("in production the mock rail does not exist: a 'mock' account is paid by hand, never stamped paid", async () => {
    const { ctx, db } = await world({ method: "mock", config: { isProduction: true } });
    expect(ctx.rails.mock).toBeNull();
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [payout] = await approveAndDisburse(ctx, batch.id, "u1");
    expect(payout).toMatchObject({ status: "awaiting_payment", mode: "manual" });
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 0, processingCents: 2_000 });
    void db;
  });

  it("a merchant's connected rail is used for that merchant; the request names them", async () => {
    const rail = connectedRail("stripe", (request) => paid(request));
    const { ctx } = await world({ method: "stripe", rails: rail.rails });
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [payout] = await approveAndDisburse(ctx, batch.id, "u1");
    expect(payout).toMatchObject({ status: "paid", mode: "automated", reference: `tr_${payout!.id}:1` });
    expect(rail.sent[0]).toMatchObject({ merchantId: "m1", amountCents: 2_000, accountRef: "a1@x.test" });
  });
});

describe("export files for manual payment (M15)", () => {
  async function approvedBatch() {
    const w = await world({ method: "paypal", accountRef: "pay-a1@x.test" });
    await addSeller(w.ctx, "a2", { method: "wise", accountRef: "DE89 3704 0044 0532 0130 00" });
    await addSeller(w.ctx, "a3", { method: "wise", accountRef: "wise-a3@x.test" });
    await addSeller(w.ctx, "a4", { method: "bank", accountRef: "=HYPERLINK(\"http://evil.test\",\"x\")" });
    await w.db.affiliates.update("a4", { name: '=cmd|" /C calc"!A0, Inc' });
    await sale(w.ctx, "t1", 10_000);
    await sale(w.ctx, "t2", 30_050, { affiliateId: "a2" });
    await sale(w.ctx, "t3", 20_000, { affiliateId: "a3" });
    await sale(w.ctx, "t4", 5_000, { affiliateId: "a4" });
    const { batch, payouts } = await createPayoutBatch(w.ctx, "m1", "USD", 1);
    return { ...w, batch, payouts };
  }

  it("a draft cannot be exported: its amounts are not final", async () => {
    const { ctx, batch } = await approvedBatch();
    await expect(exportPayoutBatch(ctx, batch.id, "csv", "u1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("generic CSV: affiliate, email, method, account reference, amount, currency, payout id", async () => {
    const { ctx, db, batch, payouts } = await approvedBatch();
    await approveAndDisburse(ctx, batch.id, "u1");
    const file = await exportPayoutBatch(ctx, batch.id, "csv", "u1");
    const lines = file.csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("affiliate,email,method,account_reference,amount,currency,payout_id");
    expect(lines).toHaveLength(5);
    const a2 = payouts.find((p) => p.affiliateId === "a2")!;
    expect(lines).toContain(`Affiliate a2,a2@x.test,wise,DE89 3704 0044 0532 0130 00,60.10,USD,${a2.id}`);
    expect(file).toMatchObject({ filename: `payouts-${batch.id}-csv.csv`, included: 4, omitted: 0 });
    // Formula injection: an affiliate-chosen name or account that starts a formula is forced to text.
    const a4 = lines.find((l) => l.includes(payouts.find((p) => p.affiliateId === "a4")!.id))!;
    expect(a4.startsWith(`"'=cmd|"" /C calc""!A0, Inc"`)).toBe(true);
    expect(a4).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect((await db.auditLogs.all()).some((a) => a.action === "payout.batch.exported" && a.metadata["format"] === "csv")).toBe(true);
  });

  it("PayPal mass-payment layout: no header; recipient, amount, currency, short unique id, note — PayPal payouts only", async () => {
    const { ctx, batch, payouts } = await approvedBatch();
    await approveAndDisburse(ctx, batch.id, "u1");
    const file = await exportPayoutBatch(ctx, batch.id, "paypal", "u1");
    const a1 = payouts.find((p) => p.affiliateId === "a1")!;
    const uniqueId = a1.id.replace(/^pay_/, "").replace(/-/g, "").slice(0, 30);
    expect(file.csv).toBe(`pay-a1@x.test,20.00,USD,${uniqueId},Affiliate commission payout ${a1.id}\r\n`);
    expect(uniqueId).toHaveLength(30);
    expect(file).toMatchObject({ included: 1, omitted: 3 });
  });

  it("Wise batch layout: Wise payouts only; an IBAN or an email is placed, nothing is guessed", async () => {
    const { ctx, batch } = await approvedBatch();
    await approveAndDisburse(ctx, batch.id, "u1");
    const file = await exportPayoutBatch(ctx, batch.id, "wise", "u1");
    const lines = file.csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("name,recipientEmail,paymentReference,receiverType,amountCurrency,amount,sourceCurrency,targetCurrency,IBAN");
    expect(lines).toHaveLength(3);
    const byIban = lines.find((l) => l.startsWith("Affiliate a2,"))!.split(",");
    expect(byIban.slice(1)).toEqual(["", expect.stringMatching(/^[0-9a-f]{10}$/), "", "target", "60.10", "USD", "USD", "DE89370400440532013000"]);
    const byEmail = lines.find((l) => l.startsWith("Affiliate a3,"))!.split(",");
    expect(byEmail[1]).toBe("wise-a3@x.test");
    expect(byEmail[3]).toBe(""); // receiverType is not known, so it is not invented
    expect(byEmail[8]).toBe("");
    expect(file).toMatchObject({ included: 2, omitted: 2 });
  });

  it("lists only what is still awaiting payment, and says so when there is nothing", async () => {
    const { ctx, batch, payouts } = await approvedBatch();
    await approveAndDisburse(ctx, batch.id, "u1");
    await markPayoutPaid(ctx, payouts.find((p) => p.affiliateId === "a1")!.id, "u1");
    await expect(exportPayoutBatch(ctx, batch.id, "paypal", "u1")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/generic CSV/) });
    expect((await exportPayoutBatch(ctx, batch.id, "csv", "u1")).included).toBe(3);
    for (const p of payouts.filter((x) => x.affiliateId !== "a1")) await markPayoutPaid(ctx, p.id, "u1");
    await expect(exportPayoutBatch(ctx, batch.id, "csv", "u1")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no payouts/) });
    await expect(exportPayoutBatch(ctx, "batch_missing", "csv", "u1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---- M13 ---------------------------------------------------------------------
describe("lifecycle dead ends (M13)", () => {
  it("a draft batch can be cancelled: reservations are released and nothing is sent", async () => {
    const { ctx, db } = await world();
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    expect(await balanceOf(ctx)).toMatchObject({ availableCents: 0, processingCents: 2_000 });

    const cancelled = await cancelPayoutBatch(ctx, batch.id, "u1");
    expect(cancelled.status).toBe("cancelled");
    expect(await payoutsOf(db)).toEqual(["2000:cancelled"]);
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
    expect((await db.ledger.all())[0]!.metadata).not.toHaveProperty("payoutId");
    expect(await balanceOf(ctx)).toMatchObject({ availableCents: 2_000, processingCents: 0 });

    await expect(cancelPayoutBatch(ctx, batch.id, "u1")).rejects.toMatchObject({ statusCode: 409 });
    await expect(approveAndDisburse(ctx, batch.id, "u1")).rejects.toMatchObject({ statusCode: 409 });
    expect(ctx.rails.mock!.sent).toHaveLength(0);
    // The balance is free for the next batch.
    expect((await createPayoutBatch(ctx, "m1", "USD", 1)).payouts[0]!.amountCents).toBe(2_000);
  });

  it("an approved batch cannot be cancelled", async () => {
    const { ctx } = await world({ method: "paypal" });
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, batch.id, "u1");
    await expect(cancelPayoutBatch(ctx, batch.id, "u1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a rail that answers 'processing' leaves a payout that can be settled later", async () => {
    let final = false;
    const rail = connectedRail("slow", (request) => (final ? paid(request) : { payoutId: request.payoutId, status: "processing", railReference: "batch_77", failureReason: null }));
    const { ctx, db } = await world({ method: "slow", rails: rail.rails });
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const [pending] = await approveAndDisburse(ctx, batch.id, "u1");
    expect(pending).toMatchObject({ status: "processing", reference: "batch_77", failureReason: null });
    expect(await ledgerOf(db)).toEqual(["commission:2000:processing"]);
    final = true;
    expect((await retryPayout(ctx, pending!.id)).status).toBe("paid");
    expect(await ledgerOf(db)).toEqual(["commission:2000:paid"]);
  });

  it("derives a batch's status from its payouts", () => {
    const of = (...statuses: string[]) => deriveBatchStatus(statuses.map((status) => ({ status }) as any));
    expect(of("pending", "pending")).toBe("draft");
    expect(of("awaiting_payment", "paid")).toBe("processing");
    expect(of("processing", "failed")).toBe("processing");
    expect(of("paid", "paid", "cancelled")).toBe("paid");
    expect(of("paid", "failed")).toBe("failed");
    expect(of("cancelled")).toBe("cancelled");
    expect(of()).toBe("cancelled");
  });
});
