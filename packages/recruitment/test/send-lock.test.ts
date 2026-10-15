import { describe, it, expect } from "vitest";
import type { Database } from "@affiliate/db";
import { autonomousCycle, launchCampaign, queueFirstTouch, send, setAutomationState, withMerchantLock } from "../src/index.js";
import { FakeSender, makeDeps, prospectRow, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O3 — there was no claim or lock on sending. `queueFirstTouch` had no state
 * check and `send()` ignored the message's status, so two overlapping runs (a scheduler tick
 * and "Run cycle", a double-clicked launch, the API scheduler and the worker) emailed the
 * same prospects twice and overshot the mailbox's daily cap.
 *
 * The fake transport awaits a timer, like a real network call: that is what lets two runs
 * interleave (the in-memory store alone never yields to the event loop, which is why the old
 * suite could not see this).
 */

async function seedProspects(db: Database, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = await db.prospects.insert(prospectRow({ id: `p${i}`, email: `creator${i}@site${i}.com`, score: 90 - i }));
    ids.push(p.id);
  }
  return ids;
}

const recipients = (sender: FakeSender) => sender.attempts.map((e) => e.toEmail);

describe("overlapping runs cannot double-send or overshoot the cap", () => {
  it("two simultaneous launches email each prospect once and stop at the daily cap", async () => {
    const db = await seededDb({ mailbox: { dailyCap: 5 } });
    await seedProspects(db, 6);
    const sender = new FakeSender({ messageId: "", status: "sent" }, 3);
    const deps = makeDeps(db, { mailer: sender });

    const [a, b] = await Promise.all([launchCampaign(deps, "c1"), launchCampaign(deps, "c1")]);

    expect(new Set(recipients(sender)).size).toBe(recipients(sender).length); // nobody emailed twice
    expect(sender.sent).toHaveLength(5); // the cap, not 6 and not 10
    expect(a.sent + b.sent).toBe(5);
    // One message row per prospect — the second run did not queue its own copies.
    for (const p of await db.prospects.all()) {
      expect(await db.outreachMessages.count((m) => m.prospectId === p.id)).toBeLessThanOrEqual(1);
    }
  });

  it("a scheduler cycle overlapping a manual launch sends each first touch once", async () => {
    const db = await seededDb({ mailbox: { dailyCap: 5 } });
    await seedProspects(db, 6);
    const sender = new FakeSender({ messageId: "", status: "sent" }, 3);
    const deps = makeDeps(db, { mailer: sender });
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, hitlTier: "A" });

    await Promise.all([autonomousCycle(deps, "m1"), launchCampaign(deps, "c1"), autonomousCycle(deps, "m1")]);

    expect(new Set(recipients(sender)).size).toBe(recipients(sender).length);
    expect(sender.sent).toHaveLength(5);
  });
});

describe("withMerchantLock", () => {
  it("serializes callers on one merchant and lets different merchants run side by side", async () => {
    const db = await seededDb();
    const deps = makeDeps(db);
    const log: string[] = [];
    const work = (merchantId: string, name: string, ms: number) =>
      withMerchantLock(deps, merchantId, async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
        return name;
      });

    const results = await Promise.all([work("m1", "a", 15), work("m1", "b", 1), work("m2", "c", 1)]);
    expect(results).toEqual(["a", "b", "c"]);
    // b waited for a (same merchant); c did not (another merchant).
    expect(log.indexOf("b:start")).toBeGreaterThan(log.indexOf("a:end"));
    expect(log.indexOf("c:end")).toBeLessThan(log.indexOf("a:end"));
  });

  it("is re-entrant within one call chain (a locked function may call another)", async () => {
    const deps = makeDeps(await seededDb());
    const nested = withMerchantLock(deps, "m1", () => withMerchantLock(deps, "m1", async () => "inner"));
    const timeout = new Promise<string>((r) => setTimeout(() => r("deadlock"), 200));
    expect(await Promise.race([nested, timeout])).toBe("inner");
  });

  it("releases the lock when the work throws", async () => {
    const deps = makeDeps(await seededDb());
    await expect(withMerchantLock(deps, "m1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withMerchantLock(deps, "m1", async () => "next")).toBe("next");
  });

  it("delegates to db.withLock when the database provides it (the cross-process lock)", async () => {
    const db = await seededDb();
    const keys: string[] = [];
    const lockingDb = Object.assign(db, {
      async withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
        keys.push(key);
        return fn();
      },
    });
    const deps = makeDeps(lockingDb);
    expect(await withMerchantLock(deps, "m1", async () => 42)).toBe(42);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("m1");
    // Nested use takes the database lock once, not twice (which would deadlock a real one).
    await withMerchantLock(deps, "m1", () => withMerchantLock(deps, "m1", async () => 1));
    expect(keys).toHaveLength(2);
  });
});

describe("state checks: a second run cannot re-queue a prospect or re-send a message", () => {
  it("queueFirstTouch queues a prospect once", async () => {
    const db = await seededDb();
    const [id] = await seedProspects(db, 1);
    const deps = makeDeps(db, { mailer: new FakeSender() });
    const campaign = await db.campaigns.require("c1");

    const first = await queueFirstTouch(deps, id!, campaign);
    const second = await queueFirstTouch(deps, id!, campaign);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // already queued — not a scored prospect any more
    expect(await db.outreachMessages.count((m) => m.prospectId === id)).toBe(1);
  });

  it("send() leaves an already-sent message alone", async () => {
    const db = await seededDb();
    const [id] = await seedProspects(db, 1);
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });
    const message = (await queueFirstTouch(deps, id!, await db.campaigns.require("c1")))!;

    const first = await send(deps, message.id);
    const again = await send(deps, message.id);
    expect(first.status).toBe("sent");
    expect(again.status).toBe("sent");
    expect(sender.attempts).toHaveLength(1); // transmitted once
    expect(await db.usageEvents.count((u) => u.kind === "send")).toBe(1); // billed once
  });

  it("a prospect that slipped back to `scored` after its first touch went out is not emailed again", async () => {
    const db = await seededDb();
    const p = await db.prospects.insert(prospectRow({ id: "p0", state: "scored" }));
    await db.outreachMessages.insert(sentMessage({ prospectId: p.id }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });

    expect(await queueFirstTouch(deps, p.id, await db.campaigns.require("c1"))).toBeNull();
    const summary = await launchCampaign(deps, "c1");
    expect(summary.sent).toBe(0);
    expect(sender.attempts).toHaveLength(0);
    expect((await db.prospects.require(p.id)).state).toBe("contacted"); // put right, so it enters the sequence
  });

  it("send() refuses a message whose prospect has since replied, unsubscribed or bounced", async () => {
    for (const state of ["replied", "suppressed", "bounced", "converted", "dead"] as const) {
      const db = await seededDb();
      const [id] = await seedProspects(db, 1);
      const sender = new FakeSender();
      const deps = makeDeps(db, { mailer: sender });
      const message = (await queueFirstTouch(deps, id!, await db.campaigns.require("c1")))!;
      await db.prospects.update(id!, { state }); // the conversation moved on while it was queued

      const out = await send(deps, message.id);
      expect(out.status).toBe("failed");
      expect(out.blockedReason).toContain(state);
      expect(sender.attempts).toHaveLength(0);
      expect((await db.prospects.require(id!)).state).toBe(state); // and the state is not disturbed
    }
  });
});
