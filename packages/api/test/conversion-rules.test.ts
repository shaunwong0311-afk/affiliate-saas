import { describe, it, expect } from "vitest";
import { createMemoryDatabase } from "@affiliate/db";
import { hashEmail } from "@affiliate/integrations";
import { buildApp } from "../src/app.js";
import { ingestNormalizedOrder } from "../src/services/conversion-pipeline.js";
import { approveAndDisburse, createPayoutBatch, markPayoutPaid } from "../src/services/payout-service.js";
import { approveConversion, rejectConversion, reverseOrder } from "../src/services/reversal.js";
import { resolveTrackingCode } from "../src/services/tracking.js";
import { addSeller, balanceOf, ledgerOf, makeOrder, sale, signedPostback, world } from "./support.js";

const DAY = 86_400_000;

// ---- M9 ----------------------------------------------------------------------
describe("hold period and attribution priority come from the sale's own program (M9)", () => {
  /** Program p1 (the merchant's FIRST offer lives here) and a second program p2 with its own settings. */
  async function twoPrograms(p1HoldDays: number, p2HoldDays: number) {
    const w = await world({ holdDays: p1HoldDays });
    await w.db.programs.insert({ id: "p2", merchantId: "m1", name: "P2", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: p2HoldDays });
    await w.db.offers.insert({ id: "o2", merchantId: "m1", programId: "p2", engine: "affiliate", name: "p2 offer", payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
    await addSeller(w.ctx, "b1", { programId: "p2" });
    return w;
  }
  const heldDays = async (w: Awaited<ReturnType<typeof twoPrograms>>) => {
    const entry = (await w.db.ledger.all()).at(-1)!;
    return (new Date(entry.availableAt!).getTime() - w.clock.now().getTime()) / DAY;
  };

  it("holds a commission for its own program's hold period, whichever program was created first", async () => {
    const a = await twoPrograms(30, 0);
    await sale(a.ctx, "e1", 10_000, { affiliateId: "b1", offerId: "o2" });
    expect(await heldDays(a)).toBe(0); // was 30: the first offer's program

    const b = await twoPrograms(0, 30);
    await sale(b.ctx, "e1", 10_000, { affiliateId: "b1", offerId: "o2" });
    expect(await heldDays(b)).toBe(30); // was 0 — payable immediately
  });

  it("manual approval uses the program's hold period, not the global default", async () => {
    const w = await twoPrograms(0, 45);
    const ctx = { ...w.ctx, config: { ...w.ctx.config, autoApproveConversions: false } };
    const { conversionId } = await sale(ctx, "e1", 10_000, { affiliateId: "b1", offerId: "o2" });
    expect(await ledgerOf(w.db)).toEqual(["commission:2000:pending"]);
    await approveConversion(ctx, conversionId!);
    expect(await ledgerOf(w.db)).toEqual(["commission:2000:approved"]);
    expect(await heldDays(w)).toBe(45); // the global default is 14
  });

  it("uses each program's own link-vs-code precedence", async () => {
    const w = await twoPrograms(0, 0);
    // p1 (first) says code wins; p2 says link wins. The sale is entirely within p2.
    await w.db.programs.update("p1", { attributionPriority: "code_first" });
    await w.db.programs.update("p2", { attributionPriority: "link_first" });
    await addSeller(w.ctx, "b2", { programId: "p2" });
    await w.db.codes.insert({ id: "code_b2", affiliateId: "b2", merchantId: "m1", code: "B2CODE", kind: "discount", discountValue: 10, usageCap: null, usageCount: 0, expiresAt: null });
    const result = await sale(w.ctx, "e1", 10_000, { affiliateId: "b1", offerId: "o2", order: { couponCodes: ["B2CODE"] } });
    expect(result.attribution).toMatchObject({ mechanism: "link", affiliateId: "b1" }); // was "code": p1's setting
  });
});

// ---- M10 ---------------------------------------------------------------------
describe("milestone bonuses (M10)", () => {
  const bonuses = [{ id: "b_count", offerId: "o1", triggerType: "conversion_count" as const, threshold: 2, amountCents: 5_000 }];
  const liveBonuses = async (db: Awaited<ReturnType<typeof world>>["db"]) => (await db.ledger.all()).filter((e) => e.type === "bonus" && e.status !== "reversed").map((e) => e.amountCents);

  it("is not earned again when a refund drops the count back under the threshold", async () => {
    const { ctx, db } = await world({ offer: { bonuses } });
    const first = await sale(ctx, "c1", 10_000);
    await sale(ctx, "c2", 10_000); // crosses 2 → bonus
    expect(await liveBonuses(db)).toEqual([5_000]);
    await reverseOrder(ctx, first.orderId, "refund of the FIRST order"); // count back to 1
    await sale(ctx, "c3", 10_000); // crosses 2 again
    expect(await liveBonuses(db)).toEqual([5_000]); // was [5000, 5000]
  });

  it("can be earned again once the bonus itself has been clawed back", async () => {
    const { ctx, db } = await world({ offer: { bonuses } });
    await sale(ctx, "c1", 10_000);
    const crossing = await sale(ctx, "c2", 10_000);
    await reverseOrder(ctx, crossing.orderId, "refund of the order that carried the bonus");
    expect(await liveBonuses(db)).toEqual([]);
    await sale(ctx, "c3", 10_000);
    expect(await liveBonuses(db)).toEqual([5_000]);
  });
});

// ---- M11 ---------------------------------------------------------------------
describe("status is enforced on the money path (M11)", () => {
  it("a banned relationship earns nothing from a click made before the ban", async () => {
    const { ctx, db } = await world();
    await db.relationships.update("r_a1_p1", { status: "banned" });
    const result = await sale(ctx, "d1", 10_000);
    expect(result.status).toBe("unattributed");
    expect(result.reason).toMatch(/banned relationship/);
    expect(await db.ledger.count()).toBe(0);
    expect(await db.conversions.count()).toBe(0);
  });

  it("a banned or paused affiliate earns nothing, by link or by their code", async () => {
    for (const status of ["banned", "paused"] as const) {
      const { ctx, db } = await world();
      await db.codes.insert({ id: "code_a1", affiliateId: "a1", merchantId: "m1", code: "A1CODE", kind: "referral", discountValue: null, usageCap: null, usageCount: 0, expiresAt: null });
      await db.affiliates.update("a1", { status });
      expect((await sale(ctx, "d1", 10_000)).status).toBe("unattributed");
      expect((await ingestNormalizedOrder(ctx, { order: makeOrder(ctx, "d2", 10_000, { couponCodes: ["A1CODE"] }), clickId: null, customerRef: null })).status).toBe("unattributed");
      expect(await db.ledger.count()).toBe(0);
      expect((await db.codes.require("code_a1")).usageCount).toBe(0);
    }
  });

  it("a paused offer earns nothing and its link no longer resolves", async () => {
    const { ctx, db } = await world();
    expect(await resolveTrackingCode(ctx, "a1.o1")).toEqual({ merchantId: "m1", affiliateId: "a1", offerId: "o1" });
    await db.offers.update("o1", { status: "paused" });
    expect(await resolveTrackingCode(ctx, "a1.o1")).toBeNull();
    expect((await sale(ctx, "d1", 10_000)).status).toBe("unattributed");
    expect(await db.ledger.count()).toBe(0);
  });

  it("a tracking code resolves only for an affiliate who can earn on that offer", async () => {
    const { ctx, db } = await world();
    expect(await resolveTrackingCode(ctx, "nobody.o1")).toBeNull(); // used to resolve for ANY id
    expect(await resolveTrackingCode(ctx, "a1.missing")).toBeNull();
    expect(await resolveTrackingCode(ctx, "garbage")).toBeNull();
    await db.relationships.update("r_a1_p1", { status: "pending" });
    expect(await resolveTrackingCode(ctx, "a1.o1")).toBeNull();
    await db.relationships.update("r_a1_p1", { status: "active" });
    await db.affiliates.update("a1", { status: "banned" });
    expect(await resolveTrackingCode(ctx, "a1.o1")).toBeNull();
  });

  it("POST /track/click refuses a code that cannot earn", async () => {
    const db = createMemoryDatabase();
    await world({ db });
    const app = await buildApp({ db });
    const click = (code: string) => app.inject({ method: "POST", url: "/track/click", headers: { "content-type": "application/json" }, payload: { code } });
    expect((await click("a1.o1")).statusCode).toBe(200);
    expect((await click("ghost.o1")).statusCode).toBe(400);
    await db.offers.update("o1", { status: "paused" });
    expect((await click("a1.o1")).statusCode).toBe(400);
    expect(await db.clicks.count()).toBe(1);
  });

  it("rejecting an APPROVED conversion takes its commission back", async () => {
    const { ctx, db } = await world();
    const { conversionId } = await sale(ctx, "s1", 10_000);
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
    await rejectConversion(ctx, conversionId!, "found to be fraud");
    expect(await db.conversions.require(conversionId!)).toMatchObject({ status: "rejected", reviewStatus: "rejected" });
    expect(await ledgerOf(db)).toEqual(["commission:2000:reversed", "reversal:-2000:reversed"]); // was still approved — and payable
    expect((await createPayoutBatch(ctx, "m1", "USD", 1)).payouts).toHaveLength(0);
  });

  it("rejecting a conversion that was already paid claws the money back", async () => {
    const { ctx, db } = await world({ method: "paypal" });
    const { conversionId } = await sale(ctx, "s1", 10_000);
    const { batch, payouts } = await createPayoutBatch(ctx, "m1", "USD", 1);
    await approveAndDisburse(ctx, batch.id, "u1");
    await markPayoutPaid(ctx, payouts[0]!.id, "u1");
    await rejectConversion(ctx, conversionId!, "chargeback");
    expect(await ledgerOf(db)).toEqual(["commission:2000:paid", "reversal:-2000:approved"]);
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 2_000, availableCents: -2_000 });
  });

  it("rejecting a conversion still in review voids its pending entries without a clawback", async () => {
    const w = await world();
    const ctx = { ...w.ctx, config: { ...w.ctx.config, autoApproveConversions: false } };
    const { conversionId } = await sale(ctx, "s1", 10_000);
    await rejectConversion(ctx, conversionId!, "not a real sale");
    expect(await ledgerOf(w.db)).toEqual(["commission:2000:reversed"]);
    expect((await w.db.ledger.all())[0]!.metadata).toMatchObject({ rejected: "not a real sale" });
  });

  it("only a pending conversion can be approved; a finished one cannot be rejected again", async () => {
    const w = await world();
    const pendingCtx = { ...w.ctx, config: { ...w.ctx.config, autoApproveConversions: false } };
    const rejected = await sale(pendingCtx, "s1", 10_000);
    await rejectConversion(pendingCtx, rejected.conversionId!, "fraud");
    await expect(approveConversion(pendingCtx, rejected.conversionId!)).rejects.toMatchObject({ statusCode: 409 }); // used to flip it back to approved
    await expect(rejectConversion(pendingCtx, rejected.conversionId!, "again")).rejects.toMatchObject({ statusCode: 409 });

    const refunded = await sale(w.ctx, "s2", 10_000);
    await reverseOrder(w.ctx, refunded.orderId, "refund");
    await expect(approveConversion(w.ctx, refunded.conversionId!)).rejects.toMatchObject({ statusCode: 409 });
    await expect(rejectConversion(w.ctx, refunded.conversionId!, "x")).rejects.toMatchObject({ statusCode: 409 });
    expect(await reverseOrder(w.ctx, refunded.orderId, "refund again")).toBeNull();
    expect((await w.db.conversions.require(refunded.conversionId!)).status).toBe("reversed");

    const approved = await sale(w.ctx, "s3", 10_000);
    await expect(approveConversion(w.ctx, approved.conversionId!)).rejects.toMatchObject({ statusCode: 409 }); // already approved
    expect(await balanceOf(w.ctx)).toMatchObject({ availableCents: 2_000 });
  });
});

// ---- M12 ---------------------------------------------------------------------
describe("self-referral detection can fire (M12)", () => {
  it("rejects a sale whose buyer is the attributed affiliate, and pays nothing", async () => {
    const { ctx, db } = await world();
    const result = await sale(ctx, "self-1", 10_000, { customerRef: "cust-9", customerEmailHash: hashEmail(" A1@X.test ") });
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/self-referral/);
    expect(await db.ledger.count()).toBe(0);
    expect((await db.conversions.all())[0]).toMatchObject({ status: "rejected" });
    // The hash is finally stored on the customer (it was only ever written as null)…
    expect((await db.customers.all())[0]!.emailHash).toBe(hashEmail("a1@x.test"));
    // …so a later order from the same customer is caught even when its feed carries no email.
    const later = await sale(ctx, "self-2", 10_000, { customerRef: "cust-9" });
    expect(later.status).toBe("rejected");
  });

  it("does not touch a sale to anybody else, and learns a returning customer's email", async () => {
    const { ctx, db } = await world();
    expect((await sale(ctx, "ok-1", 10_000, { customerRef: "cust-1" })).status).toBe("attributed");
    expect((await db.customers.all())[0]!.emailHash).toBeNull();
    expect((await sale(ctx, "ok-2", 10_000, { customerRef: "cust-1", customerEmailHash: hashEmail("buyer@elsewhere.test") })).status).toBe("attributed");
    expect((await db.customers.all())[0]!.emailHash).toBe(hashEmail("buyer@elsewhere.test"));
    expect(await db.customers.count()).toBe(1);
  });

  it("works end to end from a signed postback whose customer reference is the buyer's email", async () => {
    const db = createMemoryDatabase();
    const { ctx } = await world({ db, start: Date.now() });
    await db.clicks.insert({ clickId: "clk1", merchantId: "m1", affiliateId: "a1", offerId: "o1", ts: new Date(Date.now() - 3_600_000).toISOString(), ip: null, ua: null, landingUrl: null });
    const app = await buildApp({ db, clock: ctx.clock });
    const { body, signature } = signedPostback({ txnId: "self-http", clickId: "clk1", customerRef: "A1@x.test" });
    const res = await app.inject({ method: "POST", url: "/track/postback/m1", headers: { "content-type": "application/json", "x-affiliate-signature": signature }, payload: body as any });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).data).toMatchObject({ status: "rejected", reason: expect.stringMatching(/self-referral/) });
    expect(await db.ledger.count()).toBe(0);
  });
});

// ---- M8 (pipeline side) ------------------------------------------------------
describe("an order in a currency the offer cannot price (M8)", () => {
  it("is recorded and flagged, with no commission in the wrong currency", async () => {
    const { ctx, db } = await world({ offer: { payoutType: "flat", payoutValue: 1_000, currency: "USD", bonuses: [{ id: "b", offerId: "o1", triggerType: "first_sale", threshold: 1, amountCents: 5_000 }] } });
    const result = await sale(ctx, "jpy-1", 500_000, { order: { currency: "JPY" } });
    expect(result.status).toBe("attributed");
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.reason).toMatch(/not priced: order is in JPY but the offer's amounts \(flat payout, bonuses\) are in USD/);
    expect(await db.ledger.count()).toBe(0); // was commission 1000 JPY + bonus 5000 JPY
    const conversion = (await db.conversions.all())[0]!;
    expect(conversion).toMatchObject({ status: "pending", reviewStatus: "flagged", currency: "JPY" });
    expect(conversion.flagReason).toMatch(/not priced/);

    // It cannot be approved into a silent zero; it is resolved by hand.
    await expect(approveConversion(ctx, conversion.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/manual adjustment/) });
    await rejectConversion(ctx, conversion.id, "resolved by adjustment");
    expect((await db.conversions.require(conversion.id)).status).toBe("rejected");
  });

  it("a plain percentage offer still prices it, in the order's currency", async () => {
    const { ctx, db } = await world({ offer: { currency: "USD" } });
    const result = await sale(ctx, "jpy-2", 500_000, { order: { currency: "JPY" } });
    expect(result.ledgerEntryIds).toHaveLength(1);
    expect((await db.ledger.all())[0]).toMatchObject({ amountCents: 100_000, currency: "JPY", status: "approved" });
    expect((await db.conversions.all())[0]!.flagReason ?? null).toBeNull();
  });

  it("a same-currency order on the same offer is priced as before", async () => {
    const { ctx, db } = await world({ offer: { payoutType: "flat", payoutValue: 1_000 } });
    await sale(ctx, "usd-1", 500_000);
    expect(await ledgerOf(db)).toEqual(["commission:1000:approved"]);
  });
});
