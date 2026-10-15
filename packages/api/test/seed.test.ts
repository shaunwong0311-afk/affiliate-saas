import { describe, it, expect } from "vitest";
import { createMemoryDatabase } from "@affiliate/db";
import { createContext } from "../src/context.js";
import { seedDemo } from "../src/dev/seed.js";
import { approveAndDisburse, computePayableLines, createPayoutBatch } from "../src/services/payout-service.js";

/**
 * AUDIT-2026-10 M16: `SEED_DEMO=true` against an already-seeded persistent database
 * inserted a second demo tenant and a second user with the same email on every boot.
 * (The in-memory store is new on every boot, so here the "second boot" is a second call
 * on the same store; the Postgres run is in postgres.integration.test.ts.)
 */
describe("demo seeding is idempotent", () => {
  it("seeding an already-seeded store changes nothing and returns the same tenant", async () => {
    const db = createMemoryDatabase();
    const ctx = createContext({ db });
    const first = await seedDemo(ctx);
    const counts = async () => ({
      users: await db.users.count(),
      merchants: await db.merchants.count(),
      affiliates: await db.affiliates.count(),
      orders: await db.orders.count(),
      ledger: await db.ledger.count(),
      prospects: await db.prospects.count(),
    });
    const before = await counts();
    expect(before.users).toBe(1);
    expect(before.merchants).toBe(1);

    const second = await seedDemo(createContext({ db })); // a later boot: new context, same store
    // Same tenant and credentials; the second call says it found the tenant instead of creating it.
    expect(first.alreadySeeded).toBeUndefined();
    expect(second).toEqual({ ...first, alreadySeeded: true });
    expect(await counts()).toEqual(before);
    expect(await db.users.find((u) => u.email === "owner@demo.test")).toHaveLength(1);
  });

  it("two processes seeding at once produce one tenant", async () => {
    const db = createMemoryDatabase();
    const [a, b] = await Promise.all([seedDemo(createContext({ db })), seedDemo(createContext({ db }))]);
    expect(a.merchantId).toBe(b.merchantId);
    expect(await db.users.count()).toBe(1);
    expect(await db.merchants.count()).toBe(1);
  });

  it("the seeded tenant takes the no-custody route: approved payouts wait for the merchant's own payment", async () => {
    const db = createMemoryDatabase();
    const ctx = createContext({ db });
    const { merchantId } = await seedDemo(ctx);
    const lines = (await computePayableLines(ctx, merchantId, 2_500)).filter((l) => l.eligible);
    expect(lines.map((l) => l.rail)).toEqual(["paypal", "paypal", "paypal"]);
    expect(lines.map((l) => l.availableCents)).toEqual([17_300, 7_400, 4_030]);
    const { batch } = await createPayoutBatch(ctx, merchantId, "USD", 2_500);
    const payouts = await approveAndDisburse(ctx, batch.id, "system");
    expect(payouts.map((p) => p.status)).toEqual(["awaiting_payment", "awaiting_payment", "awaiting_payment"]);
    expect(payouts.every((p) => p.accountRef?.endsWith("@creators.test"))).toBe(true);
    expect(ctx.rails.mock!.sent).toHaveLength(0); // nothing is stamped "paid" by a stub
  });
});
