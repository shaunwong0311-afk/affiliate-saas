import { describe, it, expect, afterAll, vi } from "vitest";
import { createPostgresDatabase, LockTimeoutError, UniqueViolationError, type Database } from "../src/index.js";
import { adapterContract } from "./contract.js";
import { TEST_DATABASE_URL, openTestPostgres, type TestPostgres } from "./pg-helper.js";

/**
 * AUDIT-2026-10 M1 / M2 / M14 against a REAL Postgres. Skipped unless TEST_DATABASE_URL is
 * set (see pg-helper.ts), so `npm test` stays offline.
 */
if (!TEST_DATABASE_URL) {
  describe.skip("Postgres adapter (set TEST_DATABASE_URL to run)", () => {
    it("is skipped offline", () => {});
  });
} else {
  // A real database on a shared machine: allow for slow round trips rather than flake.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  let contractPg: TestPostgres;
  adapterContract(
    "Postgres",
    async () => {
      contractPg = await openTestPostgres("contract");
      return contractPg.db;
    },
    async () => contractPg.drop(),
  );

  describe("Postgres adapter specifics", () => {
    const opened: TestPostgres[] = [];
    const open = async (label: string, opts?: { bootstrap?: boolean }) => {
      const pg = await openTestPostgres(label, opts);
      opened.push(pg);
      return pg;
    };
    afterAll(async () => {
      for (const pg of opened) await pg.drop();
    });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("five processes booting at once against an empty database all come up", async () => {
      const pg = await open("boot", { bootstrap: false });
      const dbs = await Promise.all(Array.from({ length: 5 }, () => pg.another()));
      await dbs[0]!.auditLogs.insert({ id: "a" } as any);
      expect(await dbs[4]!.auditLogs.count()).toBe(1);
      const indexes = (await pg.sql.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")).rows.map((r) => r.indexname);
      expect(indexes).toContain("uq_orders_merchant_txn");
      expect(indexes).toContain("kv_orders_seq_idx");
    });

    it("two processes: withLock on one key never overlaps across them", async () => {
      const pg = await open("xlock");
      const [a, b] = [pg.db, await pg.another()];
      let inside = 0;
      let maxInside = 0;
      const work = async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(8);
        inside -= 1;
      };
      await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).withLock("merchant:m1", work)));
      expect(maxInside).toBe(1);
    });

    it("two processes: a lock held in one makes the other time out, then frees up", async () => {
      const pg = await open("xlock2");
      const [a, b] = [pg.db, await pg.another()];
      let release!: () => void;
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const holder = a.withLock("merchant:m1", () => {
        entered();
        return new Promise<void>((r) => (release = r));
      });
      await inside; // however long acquiring took, process A now holds the lock
      await expect(b.withLock("merchant:m1", async () => "x", { timeoutMs: 120 })).rejects.toBeInstanceOf(LockTimeoutError);
      await expect(b.transaction(async () => "independent namespace", { lock: "merchant:m1", lockTimeoutMs: 500 })).resolves.toBe("independent namespace");
      release();
      await holder;
      await expect(b.withLock("merchant:m1", async () => "free", { timeoutMs: 2_000 })).resolves.toBe("free");
    });

    it("two processes: transactions naming the same lock never interleave (no lost update)", async () => {
      const pg = await open("txlock");
      const [a, b] = [pg.db, await pg.another()];
      await a.auditLogs.insert({ id: "counter", metadata: { n: 0 } } as any);
      const bump = (db: Database) =>
        db.transaction(
          async (tx) => {
            const current = await tx.auditLogs.require("counter");
            await sleep(2);
            await tx.auditLogs.update("counter", { metadata: { n: (current.metadata.n as number) + 1 } } as any);
          },
          { lock: "money:m1" },
        );
      await Promise.all(Array.from({ length: 30 }, (_, i) => bump(i % 2 ? a : b)));
      expect((await a.auditLogs.require("counter")).metadata.n).toBe(30);
    });

    it("two processes inserting the same order at once: exactly one row, the loser gets the typed error", async () => {
      const pg = await open("uniq");
      const [a, b] = [pg.db, await pg.another()];
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? a : b).transaction(async (tx) => {
            await tx.orders.insert({ id: `o${i}`, merchantId: "m1", txnId: "same" } as any);
            await tx.conversions.insert({ id: `c${i}`, orderId: `o${i}` } as any);
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(UniqueViolationError);
      expect(await a.orders.count()).toBe(1);
      expect(await a.conversions.count()).toBe(1); // the losers' conversions rolled back with them
    });

    it("upgrades tables created before rows carried a sequence, keeping their rows", async () => {
      const pg = await open("legacy", { bootstrap: false });
      await pg.sql.query("CREATE TABLE kv_audit_logs (id text PRIMARY KEY, doc jsonb NOT NULL)");
      await pg.sql.query(`INSERT INTO kv_audit_logs (id, doc) VALUES ('old1', '{"id":"old1"}'), ('old2', '{"id":"old2"}')`);
      const db = await pg.another();
      await db.auditLogs.insert({ id: "new" } as any);
      expect((await db.auditLogs.all()).map((r) => r.id)).toEqual(["old1", "old2", "new"]);
    });

    it("refuses to boot on rows that already break a uniqueness rule, and says which", async () => {
      const pg = await open("dups", { bootstrap: false });
      await pg.sql.query("CREATE TABLE kv_orders (id text PRIMARY KEY, doc jsonb NOT NULL)");
      await pg.sql.query(
        `INSERT INTO kv_orders (id, doc) VALUES ('o1', '{"id":"o1","merchantId":"m1","txnId":"t1"}'), ('o2', '{"id":"o2","merchantId":"m1","txnId":"t1"}')`,
      );
      await expect(createPostgresDatabase(pg.sql)).rejects.toThrow(/cannot enforce uniqueness of orders\(merchantId, txnId\).*Resolve the duplicates/s);
      // Nothing half-applied: the failed boot rolled its DDL back.
      const tables = (await pg.sql.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")).rows.map((r) => r.tablename);
      expect(tables).toEqual(["kv_orders"]);
    });

    it("another connection does not see a transaction's writes until it commits", async () => {
      const pg = await open("iso");
      const other = await pg.another();
      let seenByOther = -1;
      await pg.db.transaction(async (tx) => {
        await tx.auditLogs.insert({ id: "uncommitted" } as any);
        seenByOther = await other.auditLogs.count(); // read committed: another connection sees nothing yet
      });
      expect(seenByOther).toBe(0);
      expect(await other.auditLogs.count()).toBe(1);
    });
  });
}
