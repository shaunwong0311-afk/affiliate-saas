import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMemoryDatabase, UniqueViolationError, type Database } from "@affiliate/db";
import { buildApp } from "../src/app.js";
import { ingestNormalizedOrder } from "../src/services/conversion-pipeline.js";
import { approveAndDisburse, createPayoutBatch } from "../src/services/payout-service.js";
import { reverseOrder } from "../src/services/reversal.js";
import { addSeller, balanceOf, ledgerOf, makeOrder, sale, signedPostback, world } from "./support.js";

/**
 * AUDIT-2026-10 M2 / M3 on the in-memory store. The suite used to pass only because the
 * tests never overlapped two requests; these do. The same scenarios run against real
 * Postgres in postgres.integration.test.ts.
 */
describe("one order, delivered many times at once", () => {
  it("records exactly one order, one conversion and one commission", async () => {
    const { ctx, db } = await world();
    await db.clicks.insert({ clickId: "clk", merchantId: "m1", affiliateId: "a1", offerId: "o1", ts: new Date(ctx.clock.now().getTime() - 60_000).toISOString(), ip: null, ua: null, landingUrl: null });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ingestNormalizedOrder(ctx, { order: makeOrder(ctx, "txn-1", 10_000), clickId: "clk", customerRef: "cust-1" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual(["attributed", "duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(await db.orders.count()).toBe(1);
    expect(await db.conversions.count()).toBe(1);
    expect(await db.customers.count()).toBe(1);
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
    // Every duplicate points at the one order that exists.
    const [order] = await db.orders.all();
    expect(new Set(results.map((r) => r.orderId))).toEqual(new Set([order!.id]));
    // A later re-delivery is still a duplicate.
    expect((await ingestNormalizedOrder(ctx, { order: makeOrder(ctx, "txn-1", 10_000), clickId: "clk", customerRef: "cust-1" })).status).toBe("duplicate");
  });

  it("overlapping DIFFERENT first orders of one affiliate award the first-sale bonus once", async () => {
    const { ctx, db } = await world({ offer: { bonuses: [{ id: "b_first", offerId: "o1", triggerType: "first_sale", threshold: 1, amountCents: 2_500 }] } });
    await Promise.all([sale(ctx, "a", 10_000), sale(ctx, "b", 10_000), sale(ctx, "c", 10_000)]);
    expect((await db.ledger.all()).filter((e) => e.type === "bonus")).toHaveLength(1);
    expect(await db.conversions.count()).toBe(3);
  });

  it("the unique rule is the backstop when the in-pipeline check misses", async () => {
    const { ctx, db } = await world();
    await sale(ctx, "txn-1", 10_000);
    // Inside the transaction the pipeline's own "is there already one?" check sees nothing
    // (what a second process, or a stale read, would see) — so only the store's rule can
    // stop the second copy. Outside the transaction the store is read normally.
    let violations = 0;
    const blindInsideTransactions = (inner: Database): Database =>
      new Proxy(inner, {
        get: (target, prop, receiver) => {
          if (prop !== "transaction") return Reflect.get(target, prop, receiver);
          return (fn: (tx: Database) => Promise<unknown>, opts?: Parameters<Database["transaction"]>[1]) =>
            target
              .transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get: (t, p, r) =>
                        p === "orders" ? new Proxy(t.orders, { get: (repo, q, rr) => (q === "findOne" ? async () => null : Reflect.get(repo, q, rr)) }) : Reflect.get(t, p, r),
                    }),
                  ),
                opts,
              )
              .catch((err) => {
                if (err instanceof UniqueViolationError) violations += 1;
                throw err;
              });
        },
      });
    const result = await ingestNormalizedOrder({ ...ctx, db: blindInsideTransactions(db) }, { order: makeOrder(ctx, "txn-1", 10_000), clickId: "clk_txn-1", customerRef: null });
    expect(violations).toBe(1); // the rule fired, and the transaction rolled back
    expect(result.status).toBe("duplicate"); // …and was reported as what it is
    expect(await db.orders.count()).toBe(1);
    expect(await db.conversions.count()).toBe(1);
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
  });
});

describe("a failed ingestion leaves nothing behind", () => {
  it("rolls back the order, customer and conversion when pricing throws", async () => {
    // A stored rate of 2000% (from before rates were validated): pricing refuses it.
    const { ctx, db } = await world({ offer: { payoutValue: 20 } });
    await expect(sale(ctx, "t1", 10_000, { customerRef: "cust-1" })).rejects.toThrow(/between 0 and 1/);
    expect({ orders: await db.orders.count(), customers: await db.customers.count(), conversions: await db.conversions.count(), ledger: await db.ledger.count(), usage: await db.usageEvents.count() }).toEqual({
      orders: 0,
      customers: 0,
      conversions: 0,
      ledger: 0,
      usage: 0,
    });
    // Once the offer is fixed, the SAME order is accepted — it is not a "duplicate" of a failure.
    await db.offers.update("o1", { payoutValue: 0.2 });
    expect((await sale(ctx, "t1", 10_000, { customerRef: "cust-1" })).status).toBe("attributed");
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
  });

  it("emits webhooks only for work that committed", async () => {
    const { ctx, db } = await world({ offer: { payoutValue: 20 } });
    await db.webhookSubscriptions.insert({ id: "wh1", merchantId: "m1", url: "https://hooks.example.test/in", events: ["conversion.created", "order.unattributed"], secret: "s", status: "active" });
    await expect(sale(ctx, "t1", 10_000)).rejects.toThrow();
    expect(await db.webhookDeliveries.count()).toBe(0);
    await db.offers.update("o1", { payoutValue: 0.2 });
    await sale(ctx, "t1", 10_000);
    const deliveries = await db.webhookDeliveries.all();
    expect(deliveries.map((d) => d.eventType)).toEqual(["conversion.created"]);
  });
});

describe("public postback body validation (HTTP)", () => {
  async function appWithMerchant(): Promise<{ app: FastifyInstance; db: Database }> {
    const db = createMemoryDatabase();
    const { ctx } = await world({ db, start: Date.now() });
    await db.clicks.insert({ clickId: "clk1", merchantId: "m1", affiliateId: "a1", offerId: "o1", ts: new Date(Date.now() - 3_600_000).toISOString(), ip: null, ua: null, landingUrl: null });
    const app = await buildApp({ db, clock: ctx.clock });
    return { app, db };
  }
  const post = (app: FastifyInstance, body: unknown, signature: string, ip: string) =>
    app.inject({ method: "POST", url: "/track/postback/m1", headers: { "content-type": "application/json", "x-affiliate-signature": signature, "x-forwarded-for": ip }, payload: body as any });

  it("rejects a fractional amount with 400 and writes nothing; the corrected retry is paid", async () => {
    const { app, db } = await appWithMerchant();
    const bad = signedPostback({ txnId: "tA", amountCents: 1999.5, clickId: "clk1" });
    const first = await post(app, bad.body, bad.signature, "10.0.0.1");
    expect(first.statusCode).toBe(400);
    expect(JSON.parse(first.body).error.message).toMatch(/amountCents/);
    expect({ orders: await db.orders.count(), conversions: await db.conversions.count(), ledger: await db.ledger.count() }).toEqual({ orders: 0, conversions: 0, ledger: 0 });

    const good = signedPostback({ txnId: "tA", amountCents: 2000, clickId: "clk1" });
    const retry = await post(app, good.body, good.signature, "10.0.0.1");
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body).data.status).toBe("attributed"); // was "duplicate", and never paid
    expect(await ledgerOf(db)).toEqual(["commission:400:approved"]);
  });

  it("rejects every other malformed field before touching the store", async () => {
    const { app, db } = await appWithMerchant();
    const malformed: Record<string, unknown>[] = [
      { amountCents: "2000" },
      { amountCents: -5 },
      { amountCents: null },
      { currency: "US" },
      { currency: 840 },
      { ts: "now" },
      { ts: 1.5 },
      { txnId: "" },
      { txnId: 42 },
      { couponCodes: "SAVE" },
      { clickId: { $gt: "" } },
      { merchantId: "someone-else" },
    ];
    for (const [i, overrides] of malformed.entries()) {
      const { body, signature } = signedPostback(overrides);
      const res = await post(app, body, signature, `10.0.1.${i}`);
      expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
    }
    expect(await db.orders.count()).toBe(0);
    expect(await db.customers.count()).toBe(0);
  });

  it("answers a forged or missing signature with 401, not 500", async () => {
    const { app, db } = await appWithMerchant();
    const { body } = signedPostback({ txnId: "tF" });
    expect((await post(app, body, "deadbeef", "10.0.2.1")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/track/postback/m1", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.2.2" }, payload: body as any })).statusCode).toBe(401);
    expect(await db.orders.count()).toBe(0);
  });
});

describe("payout batches created or approved at the same moment", () => {
  it("two simultaneous batch creations pay each affiliate exactly once", async () => {
    const { ctx, db } = await world();
    await addSeller(ctx, "a2");
    await sale(ctx, "t1", 10_000);
    await sale(ctx, "t2", 30_000, { affiliateId: "a2" });

    const [first, second] = await Promise.all([createPayoutBatch(ctx, "m1", "USD", 1), createPayoutBatch(ctx, "m1", "USD", 1)]);
    expect([first.payouts.length, second.payouts.length].sort()).toEqual([0, 2]);
    for (const batch of await db.payoutBatches.all()) await approveAndDisburse(ctx, batch.id, "u1").catch(() => undefined);

    const payouts = await db.payouts.all();
    expect(payouts.map((p) => `${p.affiliateId}:${p.amountCents}:${p.status}`).sort()).toEqual(["a1:2000:paid", "a2:6000:paid"]);
    expect(ctx.rails.mock!.sent.map((s) => s.amountCents).sort((a, b) => a - b)).toEqual([2_000, 6_000]);
    expect(await balanceOf(ctx, "a1")).toMatchObject({ paidCents: 2_000, availableCents: 0, processingCents: 0 });
    expect(await balanceOf(ctx, "a2")).toMatchObject({ paidCents: 6_000, availableCents: 0, processingCents: 0 });
  });

  it("two simultaneous approvals of one batch send the money once", async () => {
    const { ctx, db } = await world();
    await sale(ctx, "t1", 10_000);
    const { batch } = await createPayoutBatch(ctx, "m1", "USD", 1);
    const outcomes = await Promise.allSettled([approveAndDisburse(ctx, batch.id, "u1"), approveAndDisburse(ctx, batch.id, "u2")]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason.statusCode).toBe(409);
    expect(ctx.rails.mock!.sent).toHaveLength(1);
    expect((await db.payoutBatches.require(batch.id)).status).toBe("paid");
  });

  it("a batch creation that fails part-way reserves nothing", async () => {
    const { ctx, db } = await world();
    await addSeller(ctx, "a2");
    await sale(ctx, "t1", 10_000);
    await sale(ctx, "t2", 30_000, { affiliateId: "a2" });
    // Fail on the SECOND payout row, after the first affiliate's entries were reserved.
    let inserts = 0;
    const failing = (inner: Database): Database =>
      new Proxy(inner, {
        get: (target, prop, receiver) => {
          if (prop === "transaction") {
            return (fn: (tx: Database) => Promise<unknown>, opts?: Parameters<Database["transaction"]>[1]) => target.transaction((tx) => fn(failing(tx)), opts);
          }
          if (prop === "payouts") {
            return new Proxy(target.payouts, {
              get: (repo, p, r) =>
                p === "insert"
                  ? async (row: Parameters<Database["payouts"]["insert"]>[0]) => {
                      inserts += 1;
                      if (inserts === 2) throw new Error("disk full");
                      return repo.insert(row);
                    }
                  : Reflect.get(repo, p, r),
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    await expect(createPayoutBatch({ ...ctx, db: failing(db) }, "m1", "USD", 1)).rejects.toThrow("disk full");
    expect(await db.payoutBatches.count()).toBe(0);
    expect(await db.payouts.count()).toBe(0);
    expect(await ledgerOf(db)).toEqual(["commission:2000:approved", "commission:6000:approved"]);
  });

  it("a refund and a batch creation at the same moment cannot both act on the entry", async () => {
    const { ctx, db } = await world();
    const { orderId } = await sale(ctx, "t1", 10_000);
    const [batch] = await Promise.all([createPayoutBatch(ctx, "m1", "USD", 1), reverseOrder(ctx, orderId, "refund")]);
    // The batch is empty or already withdrawn, depending on which went first.
    await approveAndDisburse(ctx, batch.batch.id, "u1").catch((err) => expect(err.statusCode).toBe(409));
    // Either way the refunded commission is never paid out.
    expect(ctx.rails.mock!.sent).toHaveLength(0);
    expect(await balanceOf(ctx)).toMatchObject({ paidCents: 0, availableCents: 0, processingCents: 0 });
    expect((await db.payouts.all()).every((p) => p.status === "cancelled")).toBe(true);
  });
});
