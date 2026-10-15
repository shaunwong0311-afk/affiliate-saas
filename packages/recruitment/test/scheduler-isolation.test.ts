import { describe, it, expect } from "vitest";
import type { Mailbox } from "@affiliate/db";
import { getAutomationState, runScheduler, setAutomationState, tickScheduler, autonomousCycle, type RecruitmentDeps } from "../src/index.js";
import { DAY, NOW, FakeSender, inboundMail, makeDeps, prospectRow, recordingLogger, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O1 — the scheduler had no per-merchant isolation and swallowed errors
 * silently. One merchant's throw ended the tick: later merchants got no cycle, replies were
 * not ingested for anyone, and a prospect was stranded in `queued` on every tick.
 */

/** Two tenants: a broken one whose cycle throws, and a healthy one with a prospect to email. */
async function twoMerchants() {
  const db = await seededDb(); // m1 — healthy
  await db.prospects.insert(prospectRow({ id: "p-healthy", email: "creator@site.com", score: 90 }));
  const logger = recordingLogger();
  const polled: string[] = [];
  const sender = new FakeSender();
  const deps = makeDeps(db, {
    mailer: sender,
    logger,
    replyPoller: async (mailbox: Mailbox) => {
      polled.push(mailbox.id);
      return [];
    },
  });
  // "ghost" has automation running but its merchant row is gone → its cycle throws.
  // It is registered FIRST, so it runs before the healthy merchant.
  await setAutomationState(deps, "ghost", { status: "running" });
  await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, hitlTier: "A" });
  return { db, deps, logger, polled, sender };
}

describe("tickScheduler isolates merchants", () => {
  it("one merchant's failing cycle does not stop the others, and is reported — not swallowed", async () => {
    const { db, deps, logger, sender } = await twoMerchants();

    const tick = await tickScheduler(deps);

    // The healthy merchant still got its cycle and its prospect was emailed.
    expect(tick.merchants).toBe(2);
    expect(tick.cycles).toHaveLength(1);
    expect(sender.sent.map((e) => e.toEmail)).toEqual(["creator@site.com"]);
    expect((await db.prospects.require("p-healthy")).state).toBe("contacted");

    // The failure is returned, logged, and recorded where the operator can see it.
    expect(tick.errors).toHaveLength(1);
    expect(tick.errors[0]).toMatchObject({ merchantId: "ghost", phase: "cycle" });
    expect(logger.entries.some((e) => e.level === "error" && e.meta?.merchantId === "ghost")).toBe(true);
    expect((await getAutomationState(deps, "ghost")).lastError).toBeTruthy();
    // …and a clean cycle clears it.
    expect((await getAutomationState(deps, "m1")).lastError ?? null).toBeNull();
  });

  it("replies are ingested on every tick regardless of any merchant's cycle failing", async () => {
    const { deps, polled } = await twoMerchants();
    await tickScheduler(deps);
    await tickScheduler(deps);
    expect(polled).toEqual(["mbx1", "mbx1"]); // read both ticks, despite ghost throwing each time
  });

  it("replies are ingested even when no merchant has automation running", async () => {
    const db = await seededDb();
    const polled: string[] = [];
    const deps = makeDeps(db, { replyPoller: async (m: Mailbox) => { polled.push(m.id); return []; } });
    const tick = await tickScheduler(deps);
    expect(tick.merchants).toBe(0);
    expect(polled).toEqual(["mbx1"]);
  });

  it("reads the inbox BEFORE sending: a STOP that has arrived stops the follow-up in the same tick", async () => {
    const db = await seededDb();
    const p = await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", state: "contacted" }));
    // First touch went out 4 days ago → the step-2 follow-up (3-day delay) is due now.
    await db.outreachMessages.insert(sentMessage({ prospectId: p.id, sentAt: new Date(NOW.getTime() - 4 * DAY).toISOString(), providerMessageId: "<first@lumen.com>" }));
    const sender = new FakeSender();
    const deps = makeDeps(db, {
      mailer: sender,
      replyPoller: async () => [inboundMail({ fromEmail: "creator@site.com", body: "STOP", inReplyTo: "<first@lumen.com>" })],
    });
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0 });

    await tickScheduler(deps);

    expect(sender.attempts).toHaveLength(0); // no follow-up to someone who just said STOP
    expect((await db.prospects.require(p.id)).state).toBe("suppressed");
  });

  it("a failure inside reply ingestion is reported and the cycles still run", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", score: 90 }));
    const logger = recordingLogger();
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender, logger });
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0 });
    // Ingestion itself blows up (not just one mailbox): the mailbox listing throws once.
    const realFind = db.mailboxes.find.bind(db.mailboxes);
    let failures = 1;
    db.mailboxes.find = async (pred) => {
      if (failures-- > 0) throw new Error("mailboxes table unavailable");
      return realFind(pred);
    };
    const withPoller: RecruitmentDeps = { ...deps, replyPoller: async () => [] };

    const tick = await tickScheduler(withPoller);
    expect(tick.errors.some((e) => e.phase === "replies")).toBe(true);
    expect(logger.entries.some((e) => e.level === "error" && /reply ingestion/.test(e.message))).toBe(true);
    expect(sender.sent).toHaveLength(1); // the cycle ran anyway
  });
});

describe("a sender that throws does not crash the cycle or strand the prospect", () => {
  it("is recorded as a failed send; the prospect returns to scored, not stuck in queued", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", score: 90 }));
    const rogue = new FakeSender(() => {
      throw new Error("socket hang up");
    });
    const deps = makeDeps(db, { mailer: rogue });
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0 });

    const summary = await autonomousCycle(deps, "m1"); // must not throw
    expect(summary.autoSent).toBe(0);
    const message = (await db.outreachMessages.find((m) => m.prospectId === "p1"))[0]!;
    expect(message.status).toBe("failed");
    expect(message.blockedReason).toContain("socket hang up");
    expect((await db.prospects.require("p1")).state).toBe("scored");
    expect(await db.usageEvents.count((u) => u.kind === "send")).toBe(0);
  });
});

describe("runScheduler", () => {
  it("logs a tick that fails outright and keeps running", async () => {
    const db = await seededDb();
    const logger = recordingLogger();
    const deps = makeDeps(db, { logger });
    let calls = 0;
    db.automationStates.find = async () => {
      calls++;
      throw new Error("database unreachable");
    };
    const handle = runScheduler(deps, 5);
    // Wait for a second tick (bounded) rather than a fixed sleep: the box running this is shared.
    const deadline = Date.now() + 5_000;
    while (calls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // it kept ticking after the first failure
    expect(logger.entries.some((e) => e.level === "error" && /tick failed/.test(e.message))).toBe(true);
  });
});
