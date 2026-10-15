import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPostgresDatabase, TransactionAbortedError, type SqlClient, type SqlConnection, type SqlQueryResult } from "../src/index.js";

/**
 * AUDIT-2026-10 M1, offline: no database, just a pool that records WHICH connection every
 * statement ran on. The old adapter sent BEGIN, each statement and COMMIT through the
 * pool's shared `query`, so under overlap they landed on different connections.
 */
const requestTag = new AsyncLocalStorage<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Statement {
  conn: number | "pool";
  verb: string;
  tag: string;
  text: string;
}

class RecordingPool implements SqlClient {
  readonly log: Statement[] = [];
  readonly checkedOut = new Set<number>();
  commitTag = "COMMIT";
  private readonly idle: number[];
  private readonly waiting: Array<(id: number) => void> = [];
  private seq = 0;

  constructor(
    size: number,
    private readonly lockPool?: RecordingPool,
  ) {
    this.idle = Array.from({ length: size }, (_, i) => i + 1);
  }

  private async exec(conn: number | "pool", text: string): Promise<SqlQueryResult> {
    const verb = text.trim().split(/\s+/)[0]!.toUpperCase();
    this.log.push({ conn, verb, tag: requestTag.getStore() ?? "-", text });
    this.seq += 1;
    await sleep(1 + (this.seq % 3)); // network latency, so overlapping work really interleaves
    if (text.includes("current_schema() AS schema")) return { rows: [{ schema: "public" }] };
    if (text.includes("pg_try_advisory")) return { rows: [{ locked: true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
    if (verb === "COMMIT") return { rows: [], command: this.commitTag };
    if (/RETURNING doc/.test(text)) return { rows: [{ doc: {} }], command: verb };
    return { rows: [], command: verb };
  }

  query(text: string): Promise<SqlQueryResult> {
    return this.exec("pool", text);
  }

  async connect(): Promise<SqlConnection> {
    const id = this.idle.shift() ?? (await new Promise<number>((resolve) => this.waiting.push(resolve)));
    this.checkedOut.add(id);
    return {
      query: (text: string) => this.exec(id, text),
      release: () => {
        this.checkedOut.delete(id);
        const next = this.waiting.shift();
        if (next) next(id);
        else this.idle.push(id);
      },
    };
  }

  lockConnect(): Promise<SqlConnection> {
    return (this.lockPool ?? this).connect();
  }
}

/** Replay each connection's statement stream the way a Postgres session would see it. */
function analyse(log: Statement[]) {
  const open = new Map<number | "pool", string>(); // connection -> the request whose BEGIN is open on it
  const out = { own: 0, autocommit: 0, foreign: 0, strayEnd: 0, nestedBegin: 0, leftOpen: 0 };
  for (const s of log) {
    const owner = open.get(s.conn);
    if (s.verb === "BEGIN") {
      if (owner) out.nestedBegin += 1;
      else open.set(s.conn, s.tag);
    } else if (s.verb === "COMMIT" || s.verb === "ROLLBACK") {
      if (!owner || owner !== s.tag) out.strayEnd += 1;
      open.delete(s.conn);
    } else if (!owner) out.autocommit += 1;
    else if (owner !== s.tag) out.foreign += 1;
    else out.own += 1;
  }
  out.leftOpen = open.size;
  return out;
}

async function setup(size = 10) {
  const locks = new RecordingPool(4);
  const pool = new RecordingPool(size, locks);
  const db = await createPostgresDatabase(pool);
  pool.log.length = 0; // drop the bootstrap statements
  return { db, pool, locks };
}

const threeWrites = (db: any, i: number, fail = false) =>
  requestTag.run(`T${i}`, () =>
    db.transaction(async (tx: any) => {
      await tx.orders.insert({ id: `order-${i}` });
      await tx.conversions.insert({ id: `conv-${i}` });
      if (fail) throw new Error("fail");
      await tx.ledger.insert({ id: `led-${i}` });
    }),
  );

describe("Postgres adapter binds a transaction to one connection (M1)", () => {
  it("refuses a client that cannot check out a dedicated connection", async () => {
    await expect(createPostgresDatabase({ query: async () => ({ rows: [] }) } as any)).rejects.toThrow(/dedicated connection/);
  });

  for (const n of [2, 12, 30]) {
    it(`${n} overlapping transactions on a pool of 10: every statement runs inside its own transaction`, async () => {
      const { db, pool } = await setup(10);
      await Promise.allSettled(Array.from({ length: n }, (_, i) => threeWrites(db, i, i % 3 === 0)));
      const failed = Math.ceil(n / 3);
      expect(analyse(pool.log)).toEqual({
        own: (n - failed) * 3 + failed * 2,
        autocommit: 0,
        foreign: 0,
        strayEnd: 0,
        nestedBegin: 0,
        leftOpen: 0,
      });
      expect(pool.log.filter((s) => s.verb === "ROLLBACK")).toHaveLength(failed);
      expect(pool.log.filter((s) => s.verb === "COMMIT")).toHaveLength(n - failed);
      expect(pool.log.every((s) => s.conn !== "pool")).toBe(true);
      expect(pool.checkedOut.size).toBe(0); // every connection went back
    });
  }

  it("statements issued through the OUTER handle inside a transaction join it", async () => {
    const { db, pool } = await setup();
    await requestTag.run("T1", () =>
      db.transaction(async () => {
        await db.auditLogs.insert({ id: "a" } as any);
        await db.auditLogs.get("a");
      }),
    );
    expect(analyse(pool.log)).toMatchObject({ own: 2, autocommit: 0, foreign: 0 });
  });

  it("a query left running when the transaction returns is still inside it; one issued later is not", async () => {
    const { db, pool } = await setup();
    let late!: Promise<unknown>;
    let afterCommit!: () => void;
    const committed = new Promise<void>((r) => (afterCommit = r));
    await requestTag.run("T1", () =>
      db.transaction(async (tx) => {
        await tx.orders.insert({ id: "o" } as any);
        void tx.webhookDeliveries.get("whd_1"); // un-awaited, queued before COMMIT
        late = (async () => {
          await committed;
          await tx.webhookDeliveries.get("whd_2"); // the emitWebhook -> `void deliver()` shape
        })();
      }),
    );
    afterCommit();
    await late;
    const lateStatement = pool.log.find((s) => s.text.includes("kv_webhook_deliveries") && pool.log.indexOf(s) > pool.log.findIndex((x) => x.verb === "COMMIT"));
    expect(lateStatement?.conn).toBe("pool");
    expect(analyse(pool.log)).toEqual({ own: 2, autocommit: 1, foreign: 0, strayEnd: 0, nestedBegin: 0, leftOpen: 0 });
    expect(pool.checkedOut.size).toBe(0);
  });

  it("nested transactions use savepoints on the same connection", async () => {
    const { db, pool } = await setup();
    await db.transaction(async (tx) => {
      await tx.auditLogs.insert({ id: "a" } as any);
      await tx.transaction(async (inner) => void (await inner.auditLogs.insert({ id: "b" } as any))).catch(() => {});
      await expect(
        tx.transaction(async () => {
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
    });
    const verbs = pool.log.map((s) => `${s.verb} ${s.text.trim().split(/\s+/).slice(1, 4).join(" ")}`.trim());
    expect(new Set(pool.log.map((s) => s.conn)).size).toBe(1);
    expect(verbs.filter((v) => v.startsWith("SAVEPOINT"))).toEqual(["SAVEPOINT sp_1", "SAVEPOINT sp_2"]);
    expect(verbs).toContain("RELEASE SAVEPOINT sp_1");
    expect(verbs).toContain("ROLLBACK TO SAVEPOINT sp_2");
    expect(pool.log.filter((s) => s.verb === "BEGIN")).toHaveLength(1);
    expect(pool.log.at(-1)!.verb).toBe("COMMIT");
  });

  it("a COMMIT that Postgres answers with ROLLBACK is reported as a failure, not success", async () => {
    const { db, pool } = await setup();
    pool.commitTag = "ROLLBACK"; // what COMMIT returns on a transaction a failed statement aborted
    await expect(db.transaction(async (tx) => void (await tx.auditLogs.insert({ id: "a" } as any)))).rejects.toBeInstanceOf(TransactionAbortedError);
  });

  it("a transaction lock is taken on the transaction's own connection, right after BEGIN", async () => {
    const { db, pool, locks } = await setup();
    await db.transaction(async (tx) => void (await tx.auditLogs.insert({ id: "a" } as any)), { lock: "money:m1" });
    expect(pool.log.map((s) => s.verb)).toEqual(["BEGIN", "SELECT", "INSERT", "COMMIT"]);
    expect(pool.log[1]!.text).toContain("pg_try_advisory_xact_lock");
    expect(new Set(pool.log.map((s) => s.conn)).size).toBe(1);
    expect(locks.log).toHaveLength(0);
  });

  it("withLock holds a session lock on a dedicated connection from the lock pool for the whole call", async () => {
    const { db, pool, locks } = await setup();
    await db.withLock("merchant:m1", async () => {
      await db.auditLogs.insert({ id: "a" } as any);
      await db.withLock("merchant:m1", async () => void (await db.auditLogs.insert({ id: "b" } as any))); // re-entrant
    });
    expect(locks.log.map((s) => s.text.match(/pg_\w+/)?.[0])).toEqual(["pg_try_advisory_lock", "pg_advisory_unlock"]);
    expect(new Set(locks.log.map((s) => s.conn)).size).toBe(1);
    expect(pool.log.map((s) => s.verb)).toEqual(["INSERT", "INSERT"]);
    expect(locks.checkedOut.size).toBe(0);
  });
});
