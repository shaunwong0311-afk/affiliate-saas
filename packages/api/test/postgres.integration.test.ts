import { describe, it, expect, afterAll } from "vitest";
import type { Database } from "@affiliate/db";
import { TEST_DATABASE_URL, openTestPostgres, type TestPostgres } from "../../db/test/pg-helper.js";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { seedDemo } from "../src/dev/seed.js";
import { approveAndDisburse, createPayoutBatch, markPayoutFailed, markPayoutPaid } from "../src/services/payout-service.js";
import { reverseOrder } from "../src/services/reversal.js";
import { addSeller, balanceOf, ledgerOf, sale, signedPostback, world } from "./support.js";

/**
 * AUDIT-2026-10 M1 / M2 on REAL Postgres, with TWO Database instances on one schema
 * standing in for two API processes. Skipped unless TEST_DATABASE_URL is set, so a plain
 * `npm test` stays offline. These are the scenarios that paid affiliates twice.
 */
if (!TEST_DATABASE_URL) {
  describe.skip("money path on Postgres (set TEST_DATABASE_URL to run)", () => {
    it("is skipped offline", () => {});
  });
} else {
  describe("money path on Postgres, two processes", { timeout: 90_000 }, () => {
    const opened: TestPostgres[] = [];
    afterAll(async () => {
      for (const pg of opened) await pg.drop();
    });

    /** A seeded merchant plus a second, independent connection pool on the same schema. */
    async function twoProcesses(label: string, opts: Parameters<typeof world>[0] = {}) {
      const pg = await openTestPostgres(label);
      opened.push(pg);
      const first = await world({ ...opts, db: pg.db });
      const otherDb: Database = await pg.another();
      const second = { ...first.ctx, db: otherDb };
      return { pg, a: first.ctx, b: second, db: pg.db, clock: first.clock };
    }

    it("five simultaneous deliveries of one order over HTTP record exactly one conversion", async () => {
      const { a, b, db } = await twoProcesses("dup", { start: Date.now() });
      await db.clicks.insert({ clickId: "clk1", merchantId: "m1", affiliateId: "a1", offerId: "o1", ts: new Date(Date.now() - 3_600_000).toISOString(), ip: null, ua: null, landingUrl: null });
      const apps = [await buildApp({ db: a.db, clock: a.clock }), await buildApp({ db: b.db, clock: a.clock })];
      const { body, signature } = signedPostback({ txnId: "order-1", clickId: "clk1", customerRef: "cust-1" });

      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          apps[i % 2]!.inject({
            method: "POST",
            url: "/track/postback/m1",
            headers: { "content-type": "application/json", "x-affiliate-signature": signature, "x-forwarded-for": `10.1.0.${i}` },
            payload: body as any,
          }),
        ),
      );
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(responses.map((r) => JSON.parse(r.body).data.status).sort()).toEqual(["attributed", "duplicate", "duplicate", "duplicate", "duplicate"]);
      expect({ orders: await db.orders.count(), conversions: await db.conversions.count(), customers: await db.customers.count() }).toEqual({ orders: 1, conversions: 1, customers: 1 });
      expect(await ledgerOf(db)).toEqual(["commission:2000:approved"]);
      for (const app of apps) await app.close();
    });

    it("two simultaneous batch creations pay each affiliate exactly once", async () => {
      const { a, b, db } = await twoProcesses("batch", { method: "paypal" });
      await addSeller(a, "a2", { method: "paypal" });
      await addSeller(a, "a3", { method: "wise" });
      await sale(a, "t1", 10_000);
      await sale(a, "t2", 30_000, { affiliateId: "a2" });
      await sale(a, "t3", 7_500, { affiliateId: "a3" });
      const owed = 2_000 + 6_000 + 1_500;

      const created = await Promise.all([createPayoutBatch(a, "m1", "USD", 1), createPayoutBatch(b, "m1", "USD", 1), createPayoutBatch(a, "m1", "USD", 1), createPayoutBatch(b, "m1", "USD", 1)]);
      expect(created.map((c) => c.payouts.length).sort()).toEqual([0, 0, 0, 3]);

      // Approve every batch from both processes at once.
      const batches = await db.payoutBatches.all();
      await Promise.allSettled(batches.flatMap((batch) => [approveAndDisburse(a, batch.id, "u1"), approveAndDisburse(b, batch.id, "u2")]));
      const payouts = await db.payouts.all();
      expect(payouts.map((p) => `${p.affiliateId}:${p.amountCents}:${p.status}`).sort()).toEqual(["a1:2000:awaiting_payment", "a2:6000:awaiting_payment", "a3:1500:awaiting_payment"]);
      expect(payouts.reduce((s, p) => s + p.amountCents, 0)).toBe(owed);

      // The merchant pays; marking from both processes at once settles each payout once.
      await Promise.allSettled(payouts.flatMap((p) => [markPayoutPaid(a, p.id, "u1", "ref"), markPayoutPaid(b, p.id, "u2", "ref"), markPayoutFailed(b, p.id, "u3", "oops")]));
      const settled = await db.payouts.all();
      expect(settled.filter((p) => p.status === "paid" || p.status === "failed")).toHaveLength(3);
      const paidTotal = settled.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountCents, 0);
      const ledgerPaid = (await db.ledger.find((e) => e.status === "paid")).reduce((s, e) => s + e.amountCents, 0);
      expect(ledgerPaid).toBe(paidTotal); // the ledger says "paid" for exactly what the payouts say
      expect((await db.ledger.find((e) => e.status === "processing")).length).toBe(0);
    });

    it("twenty overlapping ingestions, half failing: failed ones leave no rows, successful ones lose none", async () => {
      const { a, b, db } = await twoProcesses("rollback");
      // A second offer whose stored rate is unpayable: pricing throws AFTER the order,
      // customer and conversion rows were written inside the transaction.
      await db.offers.insert({ id: "o_bad", merchantId: "m1", programId: "p1", engine: "affiliate", name: "bad", payoutType: "percentage", payoutValue: 20, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          sale(i % 3 === 0 ? b : a, `t${i}`, 1_000 + i, { offerId: i % 2 ? "o_bad" : "o1", customerRef: `cust-${i}` }).then(
            () => "ok",
            () => "failed",
          ),
        ),
      );
      expect(outcomes.filter((o) => o === "failed")).toHaveLength(10);
      const orders = await db.orders.all();
      const conversions = await db.conversions.all();
      const ledger = await db.ledger.all();
      const good = new Set(Array.from({ length: 20 }, (_, i) => i).filter((i) => i % 2 === 0).map((i) => `t${i}`));
      expect(new Set(orders.map((o) => o.txnId))).toEqual(good); // no orphan from a failed attempt, none missing
      expect(conversions).toHaveLength(10);
      expect(ledger).toHaveLength(10);
      expect(await db.customers.count()).toBe(10);
      expect(await db.usageEvents.count()).toBe(10);
      expect(conversions.every((c) => orders.some((o) => o.id === c.orderId) && ledger.some((e) => e.conversionId === c.id))).toBe(true);
    });

    it("a refund racing a batch creation and its approval never pays the refunded commission", async () => {
      const { a, b, db } = await twoProcesses("refund", { method: "paypal" });
      const kept = await sale(a, "t1", 10_000);
      const refunded = await sale(a, "t2", 5_000);
      void kept;
      const [created] = await Promise.all([createPayoutBatch(a, "m1", "USD", 1), reverseOrder(b, refunded.orderId, "refund")]);
      await approveAndDisburse(b, created.batch.id, "u1");
      const [payout] = await db.payouts.find((p) => p.status === "awaiting_payment");
      // Whichever came first, the payout is for the kept sale only.
      expect(payout).toMatchObject({ amountCents: 2_000 });
      await markPayoutPaid(a, payout!.id, "u1");
      expect(await balanceOf(a)).toMatchObject({ paidCents: 2_000, availableCents: 0, processingCents: 0 });
    });

    it("seeding the demo tenant twice — and from two processes at once — leaves one tenant", async () => {
      const pg = await openTestPostgres("seed");
      opened.push(pg);
      const other = await pg.another();
      const [x, y] = await Promise.all([seedDemo(createContext({ db: pg.db })), seedDemo(createContext({ db: other }))]);
      expect(x.merchantId).toBe(y.merchantId);
      const again = await seedDemo(createContext({ db: other })); // "the next boot"
      expect(again.merchantId).toBe(x.merchantId);
      expect(await pg.db.users.count()).toBe(1);
      expect(await pg.db.merchants.count()).toBe(1);
      expect(await pg.db.orders.count()).toBe(5);
    }, 120_000);
  });
}
