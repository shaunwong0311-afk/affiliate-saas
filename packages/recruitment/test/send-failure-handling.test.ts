import { describe, it, expect } from "vitest";
import type { Database } from "@affiliate/db";
import { MockMailboxSender, type LlmClient } from "@affiliate/integrations";
import { autonomousCycle, capacityAvailable, isSuppressed, mailboxHealth, send, queueFirstTouch, sendBackoffMs, sendReplyToProspect, setAutomationState } from "../src/index.js";
import { FakeSender, HOUR, MINUTE, NOW, makeDeps, movableClock, prospectRow, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O2 — sender-side, policy, quota and auth rejections were treated as recipient
 * hard bounces; and bounces did not consume the cap, so one cycle burned 30 of 30 prospects
 * through a 5/day mailbox.
 * AUDIT-2026-10 O4 — a mailbox-resolver exception fell back to the mock: `sent`, billed,
 * nothing delivered.
 * AUDIT-2026-10 O10 — no backoff, and LLM personalization was metered at queue time, so an
 * SMTP outage billed a personalization on every tick for nothing.
 */

async function seedProspects(db: Database, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await db.prospects.insert(prospectRow({ id: `p${i}`, email: `creator${i}@site${i}.com`, score: 90 - i }));
}

async function running(db: Database, deps: Parameters<typeof setAutomationState>[0]) {
  await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, hitlTier: "A" });
  void db;
}

describe("O2 — a rejection that is not the recipient's fault never burns the prospect", () => {
  it.each([
    ["sender rejected", { messageId: "", status: "failed" as const, reason: "553 5.1.8 Sender address rejected", failure: "sender" as const }],
    ["host quota", { messageId: "", status: "failed" as const, reason: "550 5.4.5 Daily user sending quota exceeded", failure: "quota" as const }],
    ["policy block", { messageId: "", status: "failed" as const, reason: "554 5.7.1 blocked using zen.spamhaus.org", failure: "policy" as const }],
    ["auth failure", { messageId: "", status: "failed" as const, reason: "535 Username and Password not accepted", failure: "auth" as const }],
  ])("%s: no suppression, no bounce, the mailbox backs off instead", async (_name, result) => {
    const db = await seededDb({ mailbox: { dailyCap: 5 } });
    await seedProspects(db, 8);
    const sender = new FakeSender(result);
    const deps = makeDeps(db, { mailer: sender });
    await running(db, deps);

    const summary = await autonomousCycle(deps, "m1");

    // ONE attempt, then the mailbox is held — the cycle did not walk the whole list.
    expect(sender.attempts).toHaveLength(1);
    expect(summary.autoSent).toBe(0);
    expect(await db.prospects.count((p) => p.state === "bounced")).toBe(0);
    expect(await db.suppressions.count(() => true)).toBe(0);
    expect(await db.prospects.count((p) => p.state === "scored")).toBe(8); // every prospect is still mailable
    const mailbox = await db.mailboxes.require("mbx1");
    expect(mailbox.sendFailures).toBe(1);
    expect(new Date(mailbox.sendBackoffUntil!).getTime()).toBe(NOW.getTime() + 5 * MINUTE);
    expect(mailbox.lastSendError).toContain(result.reason.slice(0, 20));
    expect(await capacityAvailable(deps, "m1", await db.campaigns.require("c1"), NOW)).toBe(false);
    // The health row carries it to the dashboard.
    expect(await mailboxHealth(deps, mailbox, NOW)).toMatchObject({ sendFailures: 1, lastSendError: expect.stringContaining(result.reason.slice(0, 20)) });
  });

  it("bounces consume the daily cap — a list of bad addresses cannot be mailed in full", async () => {
    const db = await seededDb({ mailbox: { dailyCap: 5 } });
    await seedProspects(db, 8);
    const sender = new FakeSender({ messageId: "", status: "bounced", reason: "550 5.1.1 User unknown" });
    const deps = makeDeps(db, { mailer: sender });
    await running(db, deps);

    await autonomousCycle(deps, "m1");

    expect(sender.attempts).toHaveLength(5); // the cap — it used to be all 8
    expect(await db.prospects.count((p) => p.state === "bounced")).toBe(5);
    expect(await db.prospects.count((p) => p.state === "scored")).toBe(3);
    expect(await capacityAvailable(deps, "m1", await db.campaigns.require("c1"), NOW)).toBe(false);
    // A real recipient bounce still suppresses — at merchant scope.
    expect(await isSuppressed(deps, "m1", "creator0@site0.com")).toBe(true);
    expect((await db.suppressions.all()).every((s) => s.scope === "merchant" && s.reason === "hard bounce")).toBe(true);
  });

  it("a soft, recipient-specific failure (greylisted) is retried later without holding the mailbox", async () => {
    const db = await seededDb();
    await seedProspects(db, 2);
    const sender = new FakeSender([{ messageId: "", status: "failed", reason: "450 4.7.1 Greylisted", failure: "recipient" }, { messageId: "", status: "sent" }]);
    const deps = makeDeps(db, { mailer: sender });
    await running(db, deps);

    const summary = await autonomousCycle(deps, "m1");
    expect(sender.attempts).toHaveLength(2); // the second prospect was still emailed
    expect(summary.autoSent).toBe(1);
    expect((await db.mailboxes.require("mbx1")).sendBackoffUntil ?? null).toBeNull();
    expect(await db.prospects.count((p) => p.state === "bounced")).toBe(0);
  });
});

describe("O10 — backoff, and nothing billed for mail that did not go out", () => {
  it("holds the mailbox for a doubling interval and releases it on a success", async () => {
    expect([1, 2, 3, 4].map(sendBackoffMs)).toEqual([5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 40 * MINUTE]);
    expect(sendBackoffMs(50)).toBe(6 * HOUR); // capped

    const db = await seededDb();
    await seedProspects(db, 6);
    const clock = movableClock();
    let down = true;
    const sender = new FakeSender(() => (down ? { messageId: "", status: "failed", reason: "connect ECONNREFUSED", failure: "network" } : { messageId: "", status: "sent" }));
    const deps = makeDeps(db, { mailer: sender, clock });
    await running(db, deps);

    await autonomousCycle(deps, "m1"); // attempt 1 fails → 5 min hold
    for (let i = 0; i < 4; i++) {
      clock.advance(MINUTE); // four ticks inside the hold
      await autonomousCycle(deps, "m1");
    }
    expect(sender.attempts).toHaveLength(1); // not one attempt per tick

    clock.advance(2 * MINUTE); // hold over → one more attempt (a different prospect), fails → 10 min hold
    await autonomousCycle(deps, "m1");
    expect(sender.attempts).toHaveLength(2);
    expect((await db.mailboxes.require("mbx1")).sendFailures).toBe(2);
    clock.advance(6 * MINUTE);
    await autonomousCycle(deps, "m1");
    expect(sender.attempts).toHaveLength(2); // still inside the 10-minute hold

    down = false; // the server is back
    clock.advance(5 * MINUTE);
    const recovered = await autonomousCycle(deps, "m1");
    expect(recovered.autoSent).toBeGreaterThan(0);
    const mailbox = await db.mailboxes.require("mbx1");
    expect(mailbox.sendFailures).toBe(0);
    expect(mailbox.sendBackoffUntil ?? null).toBeNull();
    expect(mailbox.lastSendError ?? null).toBeNull();
  });

  it("an outage re-uses the same message: one LLM personalization, billed once, when it finally sends", async () => {
    const db = await seededDb({ merchant: { personalizationPlan: "llm" } });
    await db.prospects.insert(prospectRow({ id: "p0", email: "creator@site.com", score: 90 }));
    const clock = movableClock();
    let llmCalls = 0;
    const llm: LlmClient = {
      model: "fake-llm",
      async complete() {
        llmCalls++;
        return JSON.stringify({ subject: "Loved your trail reviews", body: "Hi Trail Geek — your shoe reviews are exactly what our customers read before buying. Would you be open to hearing how our partner program works?" });
      },
    };
    let down = true;
    const sender = new FakeSender(() => (down ? { messageId: "", status: "failed", reason: "connect ETIMEDOUT", failure: "network" } : { messageId: "", status: "sent" }));
    const deps = makeDeps(db, { mailer: sender, clock, llm });
    await running(db, deps);
    const personalizations = () => db.usageEvents.count((u) => u.kind === "personalization");

    await autonomousCycle(deps, "m1"); // attempt 1 fails
    for (let i = 0; i < 10; i++) {
      clock.advance(10 * MINUTE); // ten more ticks across the outage
      await autonomousCycle(deps, "m1");
    }
    expect(sender.attempts.length).toBeLessThanOrEqual(3); // not eleven
    expect(llmCalls).toBe(1); // written once, not once per tick
    expect(await personalizations()).toBe(0); // nothing went out → nothing billed
    expect(await db.outreachMessages.count((m) => m.prospectId === "p0")).toBe(1); // one row, retried

    down = false;
    clock.advance(24 * HOUR);
    await autonomousCycle(deps, "m1");
    const message = (await db.outreachMessages.find((m) => m.prospectId === "p0"))[0]!;
    expect(message.status).toBe("sent");
    expect(message.subject).toBe("Loved your trail reviews"); // the copy written at queue time
    expect(llmCalls).toBe(1);
    expect(await personalizations()).toBe(1); // billed exactly once, on the send
    expect(await db.outreachMessages.count((m) => m.prospectId === "p0")).toBe(1);
  });

  it("a retry re-sends under the SAME Message-Id", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p0", email: "creator@site.com" }));
    const clock = movableClock();
    const sender = new FakeSender([{ messageId: "", status: "failed", reason: "421 try later", failure: "network" }, { messageId: "", status: "sent" }]);
    const deps = makeDeps(db, { mailer: sender, clock });
    const campaign = await db.campaigns.require("c1");

    const first = await send(deps, (await queueFirstTouch(deps, "p0", campaign))!.id);
    expect(first.status).toBe("failed");
    clock.advance(2 * HOUR);
    const retry = await send(deps, (await queueFirstTouch(deps, "p0", campaign))!.id);
    expect(retry.status).toBe("sent");
    expect(retry.id).toBe(first.id);
    expect(sender.attempts[0]!.messageId).toMatch(/^<.+@lumen\.com>$/);
    expect(sender.attempts[1]!.messageId).toBe(sender.attempts[0]!.messageId);
    expect(retry.providerMessageId).toBe(sender.attempts[0]!.messageId);
  });
});

describe("O4 — a resolver exception yields a failing sender, never the mock", () => {
  it("send(): the message fails with the reason; nothing is sent, recorded or billed", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p0", email: "creator@site.com" }));
    const mock = new MockMailboxSender(); // what it used to fall back to
    const deps = makeDeps(db, {
      mailer: mock,
      mailboxResolver: async () => {
        throw new Error("secret store unreachable");
      },
    });
    const message = (await queueFirstTouch(deps, "p0", await db.campaigns.require("c1")))!;

    const out = await send(deps, message.id);

    expect(out.status).toBe("failed");
    expect(out.sentAt).toBeNull();
    expect(out.blockedReason).toContain("secret store unreachable");
    expect(mock.outbox).toHaveLength(0); // the mock was never asked
    expect(await db.usageEvents.count((u) => u.kind === "send")).toBe(0);
    expect((await db.prospects.require("p0")).state).toBe("scored");
  });

  it("sendReplyToProspect(): reports the failure instead of 'sending' through the mock", async () => {
    const db = await seededDb();
    const p = await db.prospects.insert(prospectRow({ id: "p0", email: "creator@site.com", state: "replied" }));
    await db.outreachMessages.insert(sentMessage({ prospectId: p.id }));
    const mock = new MockMailboxSender();
    const deps = makeDeps(db, {
      mailer: mock,
      mailboxResolver: async () => {
        throw new Error("token store offline");
      },
    });

    const res = await sendReplyToProspect(deps, { prospectId: p.id, body: "Here are the details." });

    expect(res.sent).toBe(false);
    expect(res.reason).toContain("token store offline");
    expect(mock.outbox).toHaveLength(0);
    expect(await db.outreachMessages.count((m) => m.variant === "reply")).toBe(0);
  });
});
