import { describe, it, expect } from "vitest";
import type { Database } from "@affiliate/db";
import type { DeliveryStatusReport, InboundReply } from "@affiliate/integrations";
import { deliverabilityHealth, ingestReplies, isSuppressed, mailboxHealth, monitorDeliverability, processInboundReply } from "../src/index.js";
import { NOW, inboundMail, makeDeps, merchantRow, prospectRow, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O6 — the breaker, the auto-pause and bounce suppression only saw synchronous
 * rejections. Nothing parsed the delivery-status notifications that land in the inbox, and
 * nothing ever wrote a "complaint" — yet the dashboard showed a complaint rate of zero.
 */

function dsn(report: Partial<DeliveryStatusReport>, over: Partial<InboundReply> = {}): InboundReply {
  return inboundMail({
    fromEmail: "mailer-daemon@mx.lumen.com",
    subject: "Undelivered Mail Returned to Sender",
    body: "your message could not be delivered",
    bounce: { recipients: [], action: "failed", status: "5.1.1", diagnostic: "550 5.1.1 User unknown", originalMessageIds: [], kind: "hard", ...report },
    ...over,
  });
}

async function contacted(db: Database, id = "p1", email = "creator@site.com", messageId = "<first@lumen.com>") {
  const p = await db.prospects.insert(prospectRow({ id, email, state: "contacted" }));
  const m = await db.outreachMessages.insert(sentMessage({ prospectId: p.id, providerMessageId: messageId }));
  return { p, m };
}

describe("a hard bounce reported later", () => {
  it("marks the prospect bounced, suppresses at merchant scope and turns the message into a bounce", async () => {
    const db = await seededDb();
    const { p, m } = await contacted(db);
    const deps = makeDeps(db);

    const res = await processInboundReply(deps, dsn({ recipients: ["creator@site.com"], originalMessageIds: ["first@lumen.com"] }), { merchantId: "m1" });

    expect(res.matched).toBe(false); // it is not a reply
    expect(res.bounce).toMatchObject({ prospectId: p.id, messageId: m.id, kind: "hard" });
    const prospect = await db.prospects.require(p.id);
    expect(prospect.state).toBe("bounced");
    expect(prospect.suppressionStatus).toBe("bounced");
    const message = await db.outreachMessages.require(m.id);
    expect(message.status).toBe("bounced");
    expect(message.deliveryError).toContain("User unknown");
    const suppressions = await db.suppressions.all();
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ scope: "merchant", merchantId: "m1", email: "creator@site.com", reason: "hard bounce" });
    expect(await isSuppressed(deps, "m1", "creator@site.com")).toBe(true);
    // Merchant scope: it does not block another merchant from writing to that address.
    expect(await isSuppressed(deps, "m2", "creator@site.com")).toBe(false);
    // No Reply row: a bounce is never routed as something the prospect said.
    expect(await db.replies.count(() => true)).toBe(0);
  });

  it("is matched by the failed recipient when the report quotes no Message-Id", async () => {
    const db = await seededDb();
    const { p } = await contacted(db);
    const res = await processInboundReply(makeDeps(db), dsn({ recipients: ["team@lumen.com", "creator@site.com"] }), { merchantId: "m1" });
    expect(res.bounce?.prospectId).toBe(p.id);
    expect((await db.prospects.require(p.id)).state).toBe("bounced");
  });

  it("is idempotent — reading the same notification again changes nothing", async () => {
    const db = await seededDb();
    await contacted(db);
    const deps = makeDeps(db);
    const mail = dsn({ recipients: ["creator@site.com"], originalMessageIds: ["first@lumen.com"] });
    await processInboundReply(deps, mail, { merchantId: "m1" });
    const again = await processInboundReply(deps, mail, { merchantId: "m1" });
    expect(again.ignoredReason).toMatch(/already recorded/);
    expect(await db.suppressions.count(() => true)).toBe(1);
  });

  it("counts in the mailbox's and the merchant's bounce rate, and can trip the auto-pause", async () => {
    const db = await seededDb();
    const deps = makeDeps(db);
    // 30 delivered sends; three of them bounce later (10% — far over the 2% ceiling).
    for (let i = 0; i < 30; i++) await contacted(db, `p${i}`, `creator${i}@site${i}.com`, `<m${i}@lumen.com>`);
    expect((await mailboxHealth(deps, await db.mailboxes.require("mbx1"), NOW)).bounced).toBe(0);

    const replies = [0, 1, 2].map((i) => dsn({ recipients: [`creator${i}@site${i}.com`], originalMessageIds: [`m${i}@lumen.com`] }));
    const res = await ingestReplies(makeDeps(db, { replyPoller: async () => replies }));
    expect(res.bounced).toBe(3);

    const health = await mailboxHealth(deps, await db.mailboxes.require("mbx1"), NOW);
    expect(health).toMatchObject({ sent: 30, bounced: 3, circuitOpen: true });
    expect((await deliverabilityHealth(deps, "m1")).bounced).toBe(3);
    const monitor = await monitorDeliverability(deps, "m1", NOW);
    expect(monitor.paused).toEqual(["mbx1"]);
    expect((await db.mailboxes.require("mbx1")).status).toBe("error");
  });
});

describe("a delivery failure that is NOT the recipient's address", () => {
  it("does not suppress the prospect; it is noted on the message and holds the mailbox back — once", async () => {
    const db = await seededDb();
    const { p, m } = await contacted(db);
    const deps = makeDeps(db);
    const blocked = dsn({ kind: "other", status: "5.7.1", diagnostic: "554 5.7.1 blocked using zen.spamhaus.org", recipients: ["creator@site.com"], originalMessageIds: ["first@lumen.com"] });

    const res = await processInboundReply(deps, blocked, { merchantId: "m1" });

    expect(res.bounce?.kind).toBe("other");
    expect((await db.prospects.require(p.id)).state).toBe("contacted");
    expect(await db.suppressions.count(() => true)).toBe(0);
    const message = await db.outreachMessages.require(m.id);
    expect(message.status).toBe("sent");
    expect(message.deliveryError).toContain("spamhaus");
    expect((await db.mailboxes.require("mbx1")).sendFailures).toBe(1);

    await processInboundReply(deps, blocked, { merchantId: "m1" }); // read again
    expect((await db.mailboxes.require("mbx1")).sendFailures).toBe(1);
  });

  it("a delay notice changes nothing", async () => {
    const db = await seededDb();
    const { p } = await contacted(db);
    const res = await processInboundReply(makeDeps(db), dsn({ kind: "soft", action: "delayed", status: "4.4.1", recipients: ["creator@site.com"], originalMessageIds: ["first@lumen.com"] }), { merchantId: "m1" });
    expect(res.bounce).toBeUndefined();
    expect((await db.prospects.require(p.id)).state).toBe("contacted");
  });
});

describe("a notification that is not about our mail", () => {
  it("is ignored: unknown recipient, or a prospect we never emailed", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "never", email: "never@site.com", state: "scored" }));
    const deps = makeDeps(db);
    const a = await processInboundReply(deps, dsn({ recipients: ["someone-else@elsewhere.com"] }), { merchantId: "m1" });
    const b = await processInboundReply(deps, dsn({ recipients: ["never@site.com"] }), { merchantId: "m1" });
    expect(a.bounce).toBeUndefined();
    expect(b.bounce).toBeUndefined();
    expect((await db.prospects.require("never")).state).toBe("scored");
    expect(await db.suppressions.count(() => true)).toBe(0);
  });

  it("never crosses merchants", async () => {
    const db = await seededDb();
    const { p } = await contacted(db);
    await db.merchants.insert(merchantRow({ id: "m2", name: "Rival" }));
    const res = await processInboundReply(makeDeps(db), dsn({ recipients: ["creator@site.com"], originalMessageIds: ["first@lumen.com"] }), { merchantId: "m2" });
    expect(res.bounce).toBeUndefined();
    expect((await db.prospects.require(p.id)).state).toBe("contacted");
  });

  it("a bounce that names our Message-Id in its thread headers is still a bounce, not a reply", async () => {
    const db = await seededDb();
    const { p } = await contacted(db);
    await processInboundReply(makeDeps(db), dsn({ recipients: ["creator@site.com"], originalMessageIds: ["first@lumen.com"] }, { inReplyTo: "<first@lumen.com>" }), { merchantId: "m1" });
    expect((await db.prospects.require(p.id)).state).toBe("bounced"); // not "replied"
    expect(await db.replies.count(() => true)).toBe(0);
  });
});

describe("complaints are reported as not available, not as zero", () => {
  it("with no complaint feed, the figures are null and say so", async () => {
    const db = await seededDb();
    for (let i = 0; i < 25; i++) await contacted(db, `p${i}`, `creator${i}@site${i}.com`, `<m${i}@lumen.com>`);
    const health = await deliverabilityHealth(makeDeps(db), "m1");
    expect(health.sent).toBe(25);
    expect(health.complaintsAvailable).toBe(false);
    expect(health.complaints).toBeNull();
    expect(health.complaintRate).toBeNull();
    expect(health.circuitOpen).toBe(false); // an unknown is not a breach
  });

  it("once a complaint has been recorded, they are counted and feed the breaker", async () => {
    const db = await seededDb();
    for (let i = 0; i < 100; i++) await contacted(db, `p${i}`, `creator${i}@site${i}.com`, `<m${i}@lumen.com>`);
    await db.suppressions.insert({ id: "s1", merchantId: "m1", email: "angry@x.com", domain: null, reason: "complaint", scope: "global", ts: NOW.toISOString() });
    const health = await deliverabilityHealth(makeDeps(db), "m1");
    expect(health).toMatchObject({ complaintsAvailable: true, complaints: 1, circuitOpen: true });
    expect(health.complaintRate).toBeCloseTo(0.01);
  });
});
