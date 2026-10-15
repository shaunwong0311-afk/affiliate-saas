import { describe, it, expect } from "vitest";
import { UNIQUE_CONSTRAINTS, operationalDdl } from "../src/index.js";
import { uniqueKeyOf, uniqueIndexDdl } from "../src/constraints.js";
import { MEMORY_COLLECTIONS } from "../src/memory.js";
import { POSTGRES_COLLECTIONS } from "../src/postgres.js";

describe("uniqueness is declared once for both adapters", () => {
  it("both adapters know exactly the same collections", () => {
    expect([...MEMORY_COLLECTIONS].sort()).toEqual([...POSTGRES_COLLECTIONS].sort());
  });

  it("every rule targets a known collection and has a distinct name", () => {
    const names = UNIQUE_CONSTRAINTS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of UNIQUE_CONSTRAINTS) expect(MEMORY_COLLECTIONS).toContain(c.collection);
  });

  it("orders are unique per (merchant, txn id) — the rule the docs always claimed", () => {
    const rule = UNIQUE_CONSTRAINTS.find((c) => c.name === "orders_merchant_txn")!;
    expect(rule.collection).toBe("orders");
    expect(rule.fields).toEqual(["merchantId", "txnId"]);
  });

  it("the Postgres DDL carries a unique index for every rule, on the table the adapter writes", () => {
    const ddl = operationalDdl();
    expect(ddl).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_merchant_txn ON kv_orders ((doc->>'merchantId'), (doc->>'txnId'));`);
    expect(ddl).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON kv_users (lower((doc->>'email') COLLATE "C"));`);
    for (const c of UNIQUE_CONSTRAINTS) expect(ddl).toContain(`uq_${c.name} `);
    expect(ddl).toContain("seq bigserial NOT NULL");
  });

  it("derives the same key the index would: null-exempt, ASCII-case-folded only where asked", () => {
    const orders = UNIQUE_CONSTRAINTS.find((c) => c.name === "orders_merchant_txn")!;
    const users = UNIQUE_CONSTRAINTS.find((c) => c.name === "users_email")!;
    expect(uniqueKeyOf(orders, { merchantId: "m", txnId: "T1" })).not.toBe(uniqueKeyOf(orders, { merchantId: "m", txnId: "t1" }));
    expect(uniqueKeyOf(orders, { merchantId: "m", txnId: null })).toBeNull();
    expect(uniqueKeyOf(orders, { merchantId: "m" })).toBeNull();
    // No way to forge a collision by moving a separator between fields.
    expect(uniqueKeyOf(orders, { merchantId: "a", txnId: "b,c" })).not.toBe(uniqueKeyOf(orders, { merchantId: "a,b", txnId: "c" }));
    expect(uniqueKeyOf(users, { email: "A@B.com" })).toBe(uniqueKeyOf(users, { email: "a@b.COM" }));
    expect(uniqueKeyOf(users, { email: "É@b.com" })).not.toBe(uniqueKeyOf(users, { email: "é@b.com" }));
  });

  it("refuses a field name that could not be a plain JSON key", () => {
    expect(() => uniqueIndexDdl({ name: "x", collection: "orders", fields: ["a'); DROP TABLE kv_orders; --"], reason: "" }, "kv_orders")).toThrow(
      /invalid/,
    );
  });
});
