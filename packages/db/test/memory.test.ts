import { describe, it, expect } from "vitest";
import { createMemoryDatabase } from "../src/index.js";
import { adapterContract } from "./contract.js";

// AUDIT-2026-10 M3 (no rollback), M2 (no uniqueness, no locking) — in-memory half.
adapterContract(
  "in-memory",
  async () => createMemoryDatabase(),
  async (db) => db.close(),
);

describe("in-memory adapter specifics", () => {
  it("two databases in one process never share a transaction", async () => {
    const a = createMemoryDatabase();
    const b = createMemoryDatabase();
    await expect(
      a.transaction(async (tx) => {
        await tx.auditLogs.insert({ id: "a1" } as any);
        await b.auditLogs.insert({ id: "b1" } as any); // a different store: not part of a's transaction
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await a.auditLogs.count()).toBe(0);
    expect(await b.auditLogs.count()).toBe(1);
  });

  it("hands out copies: mutating a returned row does not change the stored one", async () => {
    const db = createMemoryDatabase();
    const inserted = await db.auditLogs.insert({ id: "r", metadata: { n: 1 } } as any);
    inserted.metadata.n = 99;
    const read = await db.auditLogs.require("r");
    read.metadata.n = 100;
    expect((await db.auditLogs.require("r")).metadata.n).toBe(1);
  });

  it("a rollback does not wipe unrelated writes made meanwhile outside the transaction", async () => {
    const db = createMemoryDatabase();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const failing = db
      .transaction(async (tx) => {
        await tx.auditLogs.insert({ id: "in-tx" } as any);
        await gate;
        throw new Error("boom");
      })
      .catch(() => "rolled back");
    await db.auditLogs.insert({ id: "bystander" } as any); // another request, no transaction
    release();
    expect(await failing).toBe("rolled back");
    expect((await db.auditLogs.all()).map((r) => r.id)).toEqual(["bystander"]);
  });

  it("reset empties every collection and frees the unique values", async () => {
    const db = createMemoryDatabase();
    await db.orders.insert({ id: "o1", merchantId: "m", txnId: "t" } as any);
    await db.reset();
    expect(await db.orders.count()).toBe(0);
    await db.orders.insert({ id: "o2", merchantId: "m", txnId: "t" } as any);
  });
});
