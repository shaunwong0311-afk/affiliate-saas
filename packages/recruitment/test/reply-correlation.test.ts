import { describe, it, expect } from "vitest";
import type { Database } from "@affiliate/db";
import { parseInboundWebhook } from "@affiliate/integrations";
import { handleReply, isSuppressed, processInboundReply } from "../src/index.js";
import { inboundMail, makeDeps, prospectRow, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O7 — for a contacted prospect ANY mail from their address was routed, and the
 * word "unsubscribe" anywhere meant global suppression: their own newsletter suppressed them.
 * `Name <addr>` never matched, "STOP please" was `unknown`, and webhook payloads without an
 * id were deduplicated on from+subject.
 */

async function contacted(db: Database, email = "creator@site.com") {
  const p = await db.prospects.insert(prospectRow({ id: "p1", email, state: "contacted" }));
  await db.outreachMessages.insert(sentMessage({ prospectId: p.id, subject: "Partnering with Lumen Skincare", providerMessageId: "<first@lumen.com>" }));
  return p;
}

const NEWSLETTER = "This week on the blog: 5 trail shoes worth your money.\n\nRead more at trailgeek.com\n\nUnsubscribe | Manage preferences";

describe("a prospect's own newsletter does not suppress them", () => {
  it("list/bulk mail from a contacted prospect's address is not a reply at all", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const deps = makeDeps(db);

    const res = await processInboundReply(deps, inboundMail({ subject: "This week on the blog", body: NEWSLETTER, bulk: true }), { merchantId: "m1" });

    expect(res.matched).toBe(false);
    expect(res.ignoredReason).toMatch(/bulk/);
    expect(await db.replies.count(() => true)).toBe(0);
    expect((await db.prospects.require(p.id)).state).toBe("contacted"); // the sequence is untouched
    expect(await isSuppressed(deps, "m1", "creator@site.com")).toBe(false);
  });

  it("even without the bulk headers (a webhook that forwards none), its footer suppresses nobody", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const deps = makeDeps(db);

    const res = await processInboundReply(deps, inboundMail({ subject: "This week on the blog", body: NEWSLETTER }), { merchantId: "m1" });

    expect(res.outcome?.action).not.toBe("suppress");
    expect(await db.suppressions.count(() => true)).toBe(0);
    expect((await db.prospects.require(p.id)).suppressionStatus).toBe("none");
  });
});

describe("suppression needs an opt-out REQUEST in a reply that is tied to our outreach", () => {
  it("'STOP please' in a threaded reply unsubscribes", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const deps = makeDeps(db);
    const res = await processInboundReply(deps, inboundMail({ body: "STOP please", inReplyTo: "<first@lumen.com>" }), { merchantId: "m1" });
    expect(res.outcome).toMatchObject({ classification: "unsubscribe", action: "suppress" });
    expect((await db.prospects.require(p.id)).state).toBe("suppressed");
    expect(await isSuppressed(deps, "m1", "creator@site.com")).toBe(true);
  });

  it("a reply recognized only by its 'Re: <our subject>' still counts as tied to our outreach", async () => {
    const db = await seededDb();
    await contacted(db);
    const deps = makeDeps(db);
    // Some clients drop In-Reply-To; the subject is still "Re: " + what we sent.
    const res = await processInboundReply(deps, inboundMail({ subject: "RE: Partnering with Lumen Skincare", body: "Please remove me from your list." }), { merchantId: "m1" });
    expect(res.outcome?.action).toBe("suppress");
  });

  it("an opt-out worded message that is NOT tied to our outreach stops the sequence but suppresses nobody", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const deps = makeDeps(db);
    // From the prospect's address, but a fresh message on another subject with no thread headers.
    const res = await processInboundReply(deps, inboundMail({ subject: "Question about my own list", body: "A reader wrote: unsubscribe me. How do you handle that?\n\nUnsubscribe me" }), { merchantId: "m1" });

    expect(res.matched).toBe(true);
    expect(res.outcome).toMatchObject({ classification: "unsubscribe", action: "review", needsHuman: true });
    expect(await db.suppressions.count(() => true)).toBe(0); // a person decides
    expect((await db.prospects.require(p.id)).state).toBe("replied"); // …and no follow-up goes out meanwhile
  });

  it("a reply an operator pastes in by hand is trusted as before", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const deps = makeDeps(db);
    expect((await handleReply(deps, p.id, "STOP")).action).toBe("suppress");
  });
});

describe("the sender is matched by address, however it is written", () => {
  it("`Name <addr>` matches the prospect", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const res = await processInboundReply(makeDeps(db), inboundMail({ fromEmail: "Trail Geek <Creator@Site.com>", body: "Sounds good, tell me more", inReplyTo: "<first@lumen.com>" }), { merchantId: "m1" });
    expect(res.matched).toBe(true);
    expect(res.prospectId).toBe(p.id);
  });

  it("an inbound-parse webhook payload in display-name form is routed end to end", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const inbound = parseInboundWebhook({ from: '"Trail Geek" <creator@site.com>', to: "Lumen <team@lumen.com>", subject: "Re: Partnering with Lumen Skincare", text: "Sounds good, tell me more" })!;
    const res = await processInboundReply(makeDeps(db), inbound, { merchantId: "m1" });
    expect(res.matched).toBe(true);
    expect(res.prospectId).toBe(p.id);
  });

  it("two different replies without a Message-Id are BOTH routed; a retry of one is not", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    const deps = makeDeps(db);
    const payload = (text: string) => parseInboundWebhook({ from: "creator@site.com", to: "team@lumen.com", subject: "Re: Partnering with Lumen Skincare", text })!;

    const first = await processInboundReply(deps, payload("What's the commission?"), { merchantId: "m1" });
    const retry = await processInboundReply(deps, payload("What's the commission?"), { merchantId: "m1" });
    const second = await processInboundReply(deps, payload("Also, how long is the cookie window?"), { merchantId: "m1" });

    expect(first.matched).toBe(true);
    expect(retry.ignoredReason).toMatch(/duplicate/);
    expect(second.matched).toBe(true); // it used to share the from+subject key and vanish
    expect(await db.replies.count((r) => r.prospectId === p.id)).toBe(2);
  });
});

describe("a reply never undoes a state it must not", () => {
  it("a recruit who already joined is not turned back into a lead by a later reply", async () => {
    const db = await seededDb();
    const p = await contacted(db);
    await db.prospects.update(p.id, { state: "converted" });
    const res = await processInboundReply(makeDeps(db), inboundMail({ body: "Thanks, sounds good!", inReplyTo: "<first@lumen.com>" }), { merchantId: "m1" });
    expect(res.matched).toBe(true);
    expect((await db.prospects.require(p.id)).state).toBe("converted");
  });
});
