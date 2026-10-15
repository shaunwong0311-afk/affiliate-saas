import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  DuplicateKeyError,
  LockTimeoutError,
  NotFoundError,
  TransactionAbortedError,
  UniqueViolationError,
  type Database,
} from "../src/index.js";

/**
 * The behaviour BOTH adapters must show. It runs against the in-memory store in every
 * `npm test`, and against real Postgres when TEST_DATABASE_URL is set — the same
 * assertions, so "passes in memory" can no longer mean "untested on Postgres".
 */
export function adapterContract(name: string, open: () => Promise<Database>, close: (db: Database) => Promise<void>): void {
  describe(`Database contract — ${name}`, () => {
    let db: Database;
    // The contract only needs rows with an id; these collections carry no uniqueness rule.
    const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra }) as any;
    const order = (id: string, merchantId: string | null, txnId: string | null) => ({ id, merchantId, txnId }) as any;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ids = async (repo: { all(): Promise<any[]> }) => (await repo.all()).map((r) => r.id);
    /**
     * Work that holds a lock until told to leave, and reports when it is really inside —
     * so a test never guesses how long acquiring took (a real database on a busy machine
     * can take a while).
     */
    const parked = () => {
      let entered!: () => void;
      let leave!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const gate = new Promise<void>((r) => (leave = r));
      return {
        inside,
        leave,
        work: async () => {
          entered();
          await gate;
        },
      };
    };

    beforeAll(async () => {
      db = await open();
    });
    afterAll(async () => {
      await close(db);
    });
    beforeEach(async () => {
      await db.reset();
    });

    describe("rows", () => {
      it("returns rows in insertion order, and keeps a row's place when it is updated or upserted", async () => {
        for (const id of ["c", "a", "b"]) await db.auditLogs.insert(row(id));
        await db.auditLogs.update("c", { action: "changed" } as any);
        await db.auditLogs.upsert(row("a", { action: "replaced" }));
        await db.auditLogs.upsert(row("d"));
        expect(await ids(db.auditLogs)).toEqual(["c", "a", "b", "d"]);
        expect((await db.auditLogs.findOne(() => true))!.id).toBe("c");
        expect((await db.auditLogs.find((r) => r.id !== "c")).map((r) => r.id)).toEqual(["a", "b", "d"]);
        expect(await db.auditLogs.count()).toBe(4);
        expect(await db.auditLogs.count((r) => r.id > "a")).toBe(3);
      });

      it("update merges shallowly, removes a key set to undefined, and rejects a missing row", async () => {
        await db.auditLogs.insert(row("r1", { action: "a", subjectType: "s", metadata: { x: 1 } }));
        const updated = await db.auditLogs.update("r1", { action: "b", subjectType: undefined, metadata: { y: 2 } } as any);
        expect(updated.action).toBe("b");
        expect((updated as any).subjectType).toBeUndefined();
        expect(updated.metadata).toEqual({ y: 2 });
        const stored = await db.auditLogs.require("r1");
        expect("subjectType" in stored && (stored as any).subjectType !== undefined).toBe(false);
        await expect(db.auditLogs.update("missing", { action: "x" } as any)).rejects.toBeInstanceOf(NotFoundError);
        await expect(db.auditLogs.require("missing")).rejects.toBeInstanceOf(NotFoundError);
        expect(await db.auditLogs.get("missing")).toBeNull();
      });

      it("two concurrent updates of different fields both survive", async () => {
        await db.auditLogs.insert(row("r1", { action: "a", subjectType: "s" }));
        await Promise.all([
          db.auditLogs.update("r1", { action: "A" } as any),
          db.auditLogs.update("r1", { subjectType: "S" } as any),
        ]);
        expect(await db.auditLogs.require("r1")).toMatchObject({ action: "A", subjectType: "S" });
      });

      it("rejects a second row with the same id", async () => {
        await db.auditLogs.insert(row("dup"));
        await expect(db.auditLogs.insert(row("dup"))).rejects.toBeInstanceOf(DuplicateKeyError);
        expect(await db.auditLogs.count()).toBe(1);
      });

      it("insertMany is all or nothing and keeps the given order", async () => {
        await db.auditLogs.insert(row("x2"));
        await expect(db.auditLogs.insertMany([row("x1"), row("x2"), row("x3")])).rejects.toBeInstanceOf(DuplicateKeyError);
        expect(await ids(db.auditLogs)).toEqual(["x2"]);
        await db.auditLogs.insertMany([row("y3"), row("y1"), row("y2")]);
        expect(await ids(db.auditLogs)).toEqual(["x2", "y3", "y1", "y2"]);
      });

      it("delete removes a row and is a no-op for a missing one", async () => {
        await db.auditLogs.insert(row("gone"));
        await db.auditLogs.delete("gone");
        await db.auditLogs.delete("never-there");
        expect(await db.auditLogs.count()).toBe(0);
      });
    });

    describe("uniqueness", () => {
      it("allows one order per (merchant, txn id) and names the rule it enforced", async () => {
        await db.orders.insert(order("o1", "m1", "t1"));
        const err = await db.orders.insert(order("o2", "m1", "t1")).catch((e) => e);
        expect(err).toBeInstanceOf(UniqueViolationError);
        expect(err.constraint).toBe("orders_merchant_txn");
        expect(err.statusCode).toBe(409);
        // Same txn id for another merchant, and another txn id for the same merchant, are fine.
        await db.orders.insert(order("o3", "m2", "t1"));
        await db.orders.insert(order("o4", "m1", "t2"));
        expect(await ids(db.orders)).toEqual(["o1", "o3", "o4"]);
      });

      it("enforces the rule on update and upsert too, but not against the row itself", async () => {
        await db.orders.insert(order("o1", "m1", "t1"));
        await db.orders.insert(order("o2", "m1", "t2"));
        await expect(db.orders.update("o2", { txnId: "t1" } as any)).rejects.toBeInstanceOf(UniqueViolationError);
        await expect(db.orders.upsert(order("o2", "m1", "t1"))).rejects.toBeInstanceOf(UniqueViolationError);
        await db.orders.update("o1", { txnId: "t1", amountCents: 5 } as any); // itself
        await db.orders.upsert(order("o1", "m1", "t1"));
        // Once o1 moves away, its old value is free again.
        await db.orders.update("o1", { txnId: "t9" } as any);
        await db.orders.update("o2", { txnId: "t1" } as any);
        await db.orders.delete("o2");
        await db.orders.insert(order("o5", "m1", "t1"));
      });

      it("exempts rows where a constrained field is null or missing", async () => {
        await db.ledger.insertMany([{ id: "l1", reversesEntryId: null }, { id: "l2", reversesEntryId: null }, { id: "l3" }] as any);
        await db.ledger.insert({ id: "l4", reversesEntryId: "l1" } as any);
        await expect(db.ledger.insert({ id: "l5", reversesEntryId: "l1" } as any)).rejects.toBeInstanceOf(UniqueViolationError);
        expect(await db.ledger.count()).toBe(4);
      });

      it("compares emails without regard to ASCII case", async () => {
        await db.users.insert({ id: "u1", email: "Dana@Example.com" } as any);
        await expect(db.users.insert({ id: "u2", email: "dana@example.COM" } as any)).rejects.toBeInstanceOf(UniqueViolationError);
        await db.users.insert({ id: "u3", email: "dana+other@example.com" } as any);
      });

      it("under 10 simultaneous inserts of the same key exactly one wins", async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, (_, i) => db.orders.insert(order(`race_${i}`, "m1", "same-txn"))),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(UniqueViolationError);
        expect(await db.orders.count()).toBe(1);
      });
    });

    describe("transaction", () => {
      it("commits everything when the work succeeds", async () => {
        const result = await db.transaction(async (tx) => {
          await tx.auditLogs.insert(row("t1"));
          await tx.auditLogs.insert(row("t2"));
          return "done";
        });
        expect(result).toBe("done");
        expect(await ids(db.auditLogs)).toEqual(["t1", "t2"]);
      });

      it("rolls back inserts, updates, upserts and deletes when the work throws", async () => {
        await db.auditLogs.insertMany([row("keep", { action: "original" }), row("del"), row("ups", { action: "original" })]);
        await expect(
          db.transaction(async (tx) => {
            await tx.auditLogs.insert(row("new"));
            await tx.auditLogs.update("keep", { action: "changed" } as any);
            await tx.auditLogs.upsert(row("ups", { action: "changed" }));
            await tx.auditLogs.upsert(row("ups-new"));
            await tx.auditLogs.delete("del");
            await tx.orders.insert(order("o1", "m1", "t1"));
            expect(await tx.auditLogs.count()).toBe(4); // it sees its own writes
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await ids(db.auditLogs)).toEqual(["keep", "del", "ups"]);
        expect((await db.auditLogs.require("keep")).action).toBe("original");
        expect((await db.auditLogs.require("ups")).action).toBe("original");
        expect(await db.orders.count()).toBe(0);
        // A rolled-back unique value is free again.
        await db.orders.insert(order("o2", "m1", "t1"));
      });

      it("also covers work done through the OUTER handle inside the transaction", async () => {
        await expect(
          db.transaction(async () => {
            await db.auditLogs.insert(row("via-outer-handle"));
            await Promise.resolve();
            await db.auditLogs.insert(row("via-outer-handle-2"));
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await db.auditLogs.count()).toBe(0);
      });

      it("a nested transaction rolls back alone; the outer one carries on", async () => {
        await db.transaction(async (tx) => {
          await tx.auditLogs.insert(row("outer-1"));
          await expect(
            tx.transaction(async (inner) => {
              await inner.auditLogs.insert(row("inner"));
              throw new Error("inner fails");
            }),
          ).rejects.toThrow("inner fails");
          await tx.transaction(async (inner) => {
            await inner.auditLogs.insert(row("inner-ok"));
          });
          await tx.auditLogs.insert(row("outer-2"));
        });
        expect(await ids(db.auditLogs)).toEqual(["outer-1", "inner-ok", "outer-2"]);
      });

      it("an outer rollback also undoes a nested transaction that had succeeded", async () => {
        await expect(
          db.transaction(async (tx) => {
            await tx.transaction(async (inner) => {
              await inner.auditLogs.insert(row("inner-ok"));
            });
            throw new Error("outer fails");
          }),
        ).rejects.toThrow("outer fails");
        expect(await db.auditLogs.count()).toBe(0);
      });

      it("a failed write aborts the transaction: later statements fail and it cannot commit", async () => {
        await db.orders.insert(order("o1", "m1", "t1"));
        let later: unknown;
        const outcome = await db
          .transaction(async (tx) => {
            await tx.auditLogs.insert(row("before"));
            await tx.orders.insert(order("o2", "m1", "t1")).catch(() => {}); // swallowed
            later = await tx.auditLogs.insert(row("after")).catch((e) => e);
          })
          .catch((e) => e);
        expect(later).toBeInstanceOf(TransactionAbortedError);
        expect(outcome).toBeInstanceOf(TransactionAbortedError);
        expect(await db.auditLogs.count()).toBe(0);
      });

      it("a write that may fail can be isolated in a nested transaction", async () => {
        await db.orders.insert(order("o1", "m1", "t1"));
        await db.transaction(async (tx) => {
          await tx.auditLogs.insert(row("before"));
          const err = await tx.transaction((inner) => inner.orders.insert(order("o2", "m1", "t1"))).catch((e) => e);
          expect(err).toBeInstanceOf(UniqueViolationError);
          await tx.auditLogs.insert(row("after"));
        });
        expect(await ids(db.auditLogs)).toEqual(["before", "after"]);
      });

      it("a handle used after its transaction ended behaves like the plain database", async () => {
        let leaked!: Database;
        await db.transaction(async (tx) => {
          leaked = tx;
          await tx.auditLogs.insert(row("in-tx"));
        });
        await leaked.auditLogs.insert(row("late"));
        expect(await ids(db.auditLogs)).toEqual(["in-tx", "late"]);
      });

      it("work left running when the transaction ends cannot corrupt it", async () => {
        let background!: Promise<unknown>;
        await db.transaction(async (tx) => {
          await tx.auditLogs.insert(row("in-tx"));
          // The emitWebhook shape: started inside, finishes after commit.
          background = (async () => {
            await sleep(20);
            await tx.auditLogs.insert(row("late-1"));
            await db.auditLogs.insert(row("late-2"));
          })();
        });
        await background;
        expect(await ids(db.auditLogs)).toEqual(["in-tx", "late-1", "late-2"]);
      });

      it("20 overlapping transactions: failed ones leave nothing, successful ones lose nothing", async () => {
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            db
              .transaction(async (tx) => {
                await tx.auditLogs.insert(row(`c${i}_1`));
                await sleep(1 + (i % 4) * 3);
                if (i % 2) throw new Error("fail");
                await tx.auditLogs.insert(row(`c${i}_2`));
              })
              .then(
                () => "ok",
                () => "failed",
              ),
          ),
        );
        const present = new Set(await ids(db.auditLogs));
        let orphans = 0;
        let lost = 0;
        results.forEach((r, i) => {
          if (r === "failed" && (present.has(`c${i}_1`) || present.has(`c${i}_2`))) orphans += 1;
          if (r === "ok" && !(present.has(`c${i}_1`) && present.has(`c${i}_2`))) lost += 1;
        });
        expect(results.filter((r) => r === "failed")).toHaveLength(10);
        expect({ orphans, lost }).toEqual({ orphans: 0, lost: 0 });
        expect(present.size).toBe(20);
      });

      it("transactions that name the same lock run one at a time (no lost update)", async () => {
        await db.auditLogs.insert(row("counter", { metadata: { n: 0 } }));
        let inside = 0;
        let maxInside = 0;
        await Promise.all(
          Array.from({ length: 25 }, () =>
            db.transaction(
              async (tx) => {
                inside += 1;
                maxInside = Math.max(maxInside, inside);
                const current = await tx.auditLogs.require("counter");
                await sleep(1);
                await tx.auditLogs.update("counter", { metadata: { n: (current.metadata.n as number) + 1 } } as any);
                inside -= 1;
              },
              { lock: "counter" },
            ),
          ),
        );
        expect(maxInside).toBe(1);
        expect((await db.auditLogs.require("counter")).metadata.n).toBe(25);
      });

      it("a transaction lock is re-entrant inside the transaction and released when it ends", async () => {
        await db.transaction(
          async (tx) => {
            await tx.transaction(async (inner) => void (await inner.auditLogs.insert(row("nested"))), { lock: "k" });
            await tx.transaction(async (inner) => void (await inner.auditLogs.insert(row("nested-2"))), { lock: "k" });
          },
          { lock: "k" },
        );
        // Released: the next one gets it at once.
        await db.transaction(async (tx) => void (await tx.auditLogs.insert(row("next"))), { lock: "k", lockTimeoutMs: 500 });
        expect(await db.auditLogs.count()).toBe(3);
      });

      it("gives up waiting for a transaction lock after the timeout, and the queue keeps moving", async () => {
        const first = parked();
        const holder = db.transaction(first.work, { lock: "busy" });
        await first.inside;
        const waiter = db.transaction(async (tx) => void (await tx.auditLogs.insert(row("never"))), { lock: "busy", lockTimeoutMs: 60 });
        const queued = db.transaction(async (tx) => void (await tx.auditLogs.insert(row("after"))), { lock: "busy", lockTimeoutMs: 20_000 });
        const err = await waiter.catch((e) => e);
        expect(err).toBeInstanceOf(LockTimeoutError);
        expect(err.statusCode).toBe(503);
        first.leave();
        await holder;
        await queued;
        expect(await ids(db.auditLogs)).toEqual(["after"]);
      });
    });

    describe("withLock", () => {
      it("runs callers on the same key one at a time and callers on other keys freely", async () => {
        let inside = 0;
        let maxInside = 0;
        const order: number[] = [];
        const work = (i: number) => async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(3);
          order.push(i);
          inside -= 1;
        };
        await Promise.all(Array.from({ length: 8 }, (_, i) => db.withLock("merchant:m1", work(i))));
        expect(maxInside).toBe(1);
        expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // first come, first served

        // Other keys do not wait for each other: three holders can all be inside at once.
        // (Each stays until all three are in, so this cannot pass by luck of timing.)
        let holding = 0;
        let allIn!: () => void;
        const everyoneInside = new Promise<void>((r) => (allIn = r));
        const together = Promise.all(
          ["a", "b", "c"].map((k) =>
            db.withLock(`merchant:${k}`, async () => {
              holding += 1;
              if (holding === 3) allIn();
              await everyoneInside;
            }),
          ),
        );
        const outcome = await Promise.race([together.then(() => "all three held their locks together"), sleep(3_000).then(() => "blocked each other")]);
        expect(outcome).toBe("all three held their locks together");
      });

      it("is re-entrant, returns the work's result, and releases when the work throws", async () => {
        const value = await db.withLock("k", () => db.withLock("k", async () => db.withLock("k", async () => 42)));
        expect(value).toBe(42);
        await expect(db.withLock("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
        expect(await db.withLock("k", async () => "free", { timeoutMs: 500 })).toBe("free");
      });

      it("work that outlives the lock cannot keep using it", async () => {
        let late!: Promise<string>;
        let goOn!: () => void;
        const newHolderIsIn = new Promise<void>((r) => (goOn = r));
        await db.withLock("k", async () => {
          late = (async () => {
            await newHolderIsIn;
            // The lock this work started under is long released, and someone else holds it
            // now: this must really queue behind them, not walk in on the old claim.
            return db.withLock("k", async () => "acquired", { timeoutMs: 60 }).catch((e) => e.name as string);
          })();
        });
        const next = parked();
        const holder = db.withLock("k", next.work);
        await next.inside;
        goOn();
        expect(await late).toBe("LockTimeoutError");
        next.leave();
        await holder;
      });

      it("times out with a retryable error instead of waiting for ever", async () => {
        const first = parked();
        const holder = db.withLock("stuck", first.work);
        await first.inside;
        const err = await db.withLock("stuck", async () => "x", { timeoutMs: 60 }).catch((e) => e);
        expect(err).toBeInstanceOf(LockTimeoutError);
        first.leave();
        await holder;
      });

      it("is not a transaction, and its keys do not collide with transaction locks", async () => {
        await expect(
          db.withLock("k", async () => {
            await db.auditLogs.insert(row("kept"));
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await db.auditLogs.count()).toBe(1);
        await db.withLock("same", () => db.transaction(async (tx) => void (await tx.auditLogs.insert(row("both"))), { lock: "same", lockTimeoutMs: 1_000 }));
        expect(await db.auditLogs.count()).toBe(2);
      });
    });
  });
}
