import { describe, it, expect } from "vitest";
import type { Database, Mailbox } from "@affiliate/db";
import { advanceSequences, autonomousCycle, inboundState, ingestReplies, isSuppressed, mailboxHealth, processInboundReply, setAutomationState } from "../src/index.js";
import { DAY, FakeSender, NOW, inboundMail, mailboxRow, makeDeps, merchantRow, prospectRow, recordingLogger, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O5 — mailboxes connected through Microsoft or Google OAuth had no inbound
 * path (the poller returned []), yet every footer says "reply STOP" and follow-ups continued
 * after a reply. And on SMTP, a STOP from an alias went unmatched even when its In-Reply-To
 * was our own Message-Id.
 */

/** A prospect whose first touch went out 4 days ago — the 3-day follow-up is due. */
async function withDueFollowUp(db: Database, over: { email?: string } = {}) {
  const p = await db.prospects.insert(prospectRow({ id: "p1", email: over.email ?? "creator@site.com", state: "contacted" }));
  await db.outreachMessages.insert(sentMessage({ prospectId: p.id, sentAt: new Date(NOW.getTime() - 4 * DAY).toISOString(), providerMessageId: "<first@lumen.com>" }));
  return p;
}

describe("O5(a) — a mailbox with no working inbound path sends no automated follow-ups", () => {
  it.each([
    ["no inbound path at all (Gmail via Google sign-in)", { inboundStatus: "unavailable" as const, inboundError: "reading replies is not built yet for Gmail connected with Google sign-in" }],
    ["an inbound path that is failing", { inboundStatus: "error" as const, inboundError: "IMAP login failed" }],
    ["an inbound path never verified", { inboundStatus: undefined }],
  ])("%s → the follow-up is held, with the reason", async (_name, mailbox) => {
    const db = await seededDb({ mailbox });
    await withDueFollowUp(db);
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });

    const res = await advanceSequences(deps, "m1", await db.campaigns.require("c1"), NOW);

    expect(res.emailsSent).toBe(0);
    expect(sender.attempts).toHaveLength(0);
    expect(res.blockedReason).toMatch(/on hold/);
    expect(await db.outreachMessages.count((m) => m.step === 2)).toBe(0); // not even queued
  });

  it("sends the follow-up once the inbox is being read", async () => {
    const db = await seededDb({ mailbox: { inboundStatus: "ok" } });
    await withDueFollowUp(db);
    const sender = new FakeSender();
    const res = await advanceSequences(makeDeps(db, { mailer: sender }), "m1", await db.campaigns.require("c1"), NOW);
    expect(res.emailsSent).toBe(1);
    expect(res.blockedReason).toBeUndefined();
  });

  it("first touches still go out — only follow-ups need replies to be readable", async () => {
    const db = await seededDb({ mailbox: { inboundStatus: "unavailable", inboundError: "no IMAP server is set" } });
    await withDueFollowUp(db);
    await db.prospects.insert(prospectRow({ id: "p2", email: "fresh@other.com", score: 90 }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0 });

    const summary = await autonomousCycle(deps, "m1");

    expect(sender.sent.map((e) => e.toEmail)).toEqual(["fresh@other.com"]);
    expect(summary.autoSent).toBe(1);
    expect(summary.followUpsSent).toBe(0);
    expect(summary.followUpsBlockedReason).toMatch(/no IMAP server/); // what the UI shows
  });

  it("a first touch from a mailbox that cannot hear replies does not promise 'reply STOP'", async () => {
    const send1 = async (mailbox: Partial<Mailbox>) => {
      const db = await seededDb({ mailbox });
      await db.prospects.insert(prospectRow({ id: "p2", email: "fresh@other.com", score: 90 }));
      const sender = new FakeSender();
      const deps = makeDeps(db, { mailer: sender });
      await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0 });
      await autonomousCycle(deps, "m1");
      return sender.sent[0]!.body;
    };
    const deaf = await send1({ inboundStatus: "unavailable", inboundError: "no IMAP server is set" });
    expect(deaf).not.toMatch(/reply STOP/); // an opt-out we could not hear is not offered…
    expect(deaf).toMatch(/Unsubscribe: https?:\/\/\S+\/track\/unsubscribe\?/); // …the signed link, which works, is
    expect(deaf).toContain("1 Market St, San Francisco, CA");
    expect(await send1({ inboundStatus: "ok" })).toMatch(/Unsubscribe: reply STOP, or https?:\/\//);
  });

  it("the state is exposed for the UI: inboundState() and the mailbox health row", async () => {
    const db = await seededDb({ mailbox: { inboundStatus: "unavailable", inboundError: "no IMAP server is set" } });
    const mailbox = await db.mailboxes.require("mbx1");
    expect(inboundState(mailbox)).toEqual({ working: false, reason: "no IMAP server is set" });
    expect(await mailboxHealth(makeDeps(db), mailbox, NOW)).toMatchObject({ inboundWorking: false, inboundReason: "no IMAP server is set" });
    expect(inboundState(mailboxRow({ inboundStatus: "ok" }))).toEqual({ working: true, reason: null });
    // A mailbox with no credentials can only reach the dev/test mock — nothing real to protect.
    expect(inboundState(mailboxRow({ credentialsRef: "", inboundStatus: undefined })).working).toBe(true);
  });
});

describe("O5(a) — every inbox read records whether the mailbox can hear replies", () => {
  async function readWith(poller: (m: Mailbox) => Promise<any>, mailbox: Partial<Mailbox> = { inboundStatus: undefined }) {
    const db = await seededDb({ mailbox });
    const logger = recordingLogger();
    const res = await ingestReplies(makeDeps(db, { replyPoller: poller, logger }));
    return { db, logger, res, mailbox: await db.mailboxes.require("mbx1") };
  }

  it("a successful read → ok (even with nothing new)", async () => {
    const { mailbox } = await readWith(async () => []);
    expect(mailbox.inboundStatus).toBe("ok");
    expect(mailbox.inboundError ?? null).toBeNull();
    expect(mailbox.lastPolledAt).toBeTruthy();
  });

  it("a rail with no inbound path → unavailable, with the poller's reason", async () => {
    const { mailbox, res } = await readWith(async () => ({ unavailable: "reading replies is not built yet for Gmail connected with Google sign-in" }));
    expect(mailbox.inboundStatus).toBe("unavailable");
    expect(mailbox.inboundError).toMatch(/Gmail/);
    expect(res.mailboxes).toBe(0); // it was not read
    expect(mailbox.lastPolledAt ?? null).toBeNull();
  });

  it("a failed read → error, logged with the reason; a later good read clears it", async () => {
    const { db, logger, mailbox } = await readWith(async () => {
      throw new Error("IMAP login failed: invalid credentials");
    }, { inboundStatus: "ok" });
    expect(mailbox.inboundStatus).toBe("error");
    expect(mailbox.inboundError).toContain("invalid credentials");
    expect(logger.entries.some((e) => e.level === "warn" && e.meta?.mailboxId === "mbx1")).toBe(true);

    await ingestReplies(makeDeps(db, { replyPoller: async () => [] }));
    expect((await db.mailboxes.require("mbx1")).inboundStatus).toBe("ok");
  });

  it("stores the poller's resume cursor, and hands it back on the next read", async () => {
    const seen: Array<string | null | undefined> = [];
    const poller = async (m: Mailbox) => {
      seen.push(m.inboundCursor);
      return { replies: [], cursor: "imap:1700000000:41" };
    };
    const { db } = await readWith(poller);
    await ingestReplies(makeDeps(db, { replyPoller: poller }));
    expect(seen).toEqual([undefined, "imap:1700000000:41"]);
  });

  it("a mailbox whose read starts failing has its follow-ups held on the very next cycle", async () => {
    const db = await seededDb({ mailbox: { inboundStatus: "ok" } });
    await withDueFollowUp(db);
    const sender = new FakeSender();
    const deps = makeDeps(db, {
      mailer: sender,
      replyPoller: async () => {
        throw new Error("IMAP connection refused");
      },
    });
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0 });

    const summary = await autonomousCycle(deps, "m1"); // reads the inbox first, then decides

    expect(sender.attempts).toHaveLength(0);
    expect(summary.followUpsBlockedReason).toMatch(/IMAP connection refused/);
  });
});

describe("O5(c) — a reply is matched by its thread before its From address", () => {
  it("a STOP sent from an alias still stops the sequence and suppresses", async () => {
    const db = await seededDb();
    const p = await withDueFollowUp(db, { email: "hello@trailgeek.com" });
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });

    // The creator answers from another address; the client kept our Message-Id in the thread headers.
    const res = await processInboundReply(deps, inboundMail({ fromEmail: "jamie.personal@gmail.com", body: "STOP", inReplyTo: "<first@lumen.com>", references: "<first@lumen.com>" }), { merchantId: "m1" });

    expect(res.matched).toBe(true);
    expect(res.prospectId).toBe(p.id);
    expect(res.outcome?.action).toBe("suppress");
    expect((await db.prospects.require(p.id)).state).toBe("suppressed");
    // Both the address we write to and the one they answered from are suppressed.
    expect(await isSuppressed(deps, "m1", "hello@trailgeek.com")).toBe(true);
    expect(await isSuppressed(deps, "m1", "jamie.personal@gmail.com")).toBe(true);
    expect((await db.replies.find((r) => r.prospectId === p.id))[0]!.fromEmail).toBe("jamie.personal@gmail.com");

    // …and the follow-up that was due does not go out.
    const adv = await advanceSequences(deps, "m1", await db.campaigns.require("c1"), NOW);
    expect(adv.emailsSent).toBe(0);
    expect(sender.attempts).toHaveLength(0);
  });

  it("an alias reply that is merely interested is routed to the right prospect too", async () => {
    const db = await seededDb();
    const p = await withDueFollowUp(db, { email: "hello@trailgeek.com" });
    const res = await processInboundReply(makeDeps(db), inboundMail({ fromEmail: "jamie.personal@gmail.com", body: "This sounds great, sign me up!", references: "<something-else@x.com> <first@lumen.com>" }), { merchantId: "m1" });
    expect(res.matched).toBe(true);
    expect(res.prospectId).toBe(p.id);
    expect((await db.prospects.require(p.id)).state).toBe("replied");
  });

  it("the thread match stays inside the mailbox's own merchant", async () => {
    const db = await seededDb();
    await withDueFollowUp(db);
    await db.merchants.insert(merchantRow({ id: "m2", name: "Rival" }));
    // Merchant m2's mailbox receives mail that names m1's Message-Id: it is not m2's to route.
    const res = await processInboundReply(makeDeps(db), inboundMail({ fromEmail: "stranger@nowhere.com", body: "STOP", inReplyTo: "<first@lumen.com>" }), { merchantId: "m2" });
    expect(res.matched).toBe(false);
    expect(await db.suppressions.count(() => true)).toBe(0);
  });
});
