import { describe, it, expect } from "vitest";
import { advanceSequences, processInboundReply, queueFirstTouch, send } from "../src/index.js";
import { DAY, FakeSender, NOW, inboundMail, makeDeps, movableClock, prospectRow, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O9 — "always set our own Message-Id, storing that for threading on every
 * rail". The Gmail rail used to store the API's internal id and later reuse it as In-Reply-To.
 */
describe("the Message-Id we stamp is the one stored, threaded on, and correlated by", () => {
  it("stores OUR id even when the rail answers with a provider-internal id", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    // What the Gmail API returns: an opaque id that is not a Message-Id.
    const gmailLike = new FakeSender({ messageId: "18c5f0a2b3d4e5f6", status: "sent" });
    const deps = makeDeps(db, { mailer: gmailLike });

    const out = await send(deps, (await queueFirstTouch(deps, "p1", await db.campaigns.require("c1")))!.id);

    expect(gmailLike.sent[0]!.messageId).toMatch(/^<[0-9a-f-]{36}@lumen\.com>$/); // stamped on the sending domain
    expect(out.providerMessageId).toBe(gmailLike.sent[0]!.messageId); // …and that is what is stored
    expect(out.providerMessageId).not.toBe("18c5f0a2b3d4e5f6");
  });

  it("a follow-up threads onto the first touch by that id, and a reply to it is recognized", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    const sender = new FakeSender();
    const clock = movableClock();
    const deps = makeDeps(db, { mailer: sender, clock });
    const campaign = await db.campaigns.require("c1");

    await send(deps, (await queueFirstTouch(deps, "p1", campaign))!.id);
    const firstId = sender.sent[0]!.messageId!;
    clock.set(new Date("2026-07-07T15:00:00.000Z")); // five days on: the 3-day follow-up is due (a Tuesday morning in the US)
    expect((await advanceSequences(deps, "m1", campaign, clock.now())).emailsSent).toBe(1);

    const followUp = sender.sent[1]!;
    expect(followUp.inReplyTo).toBe(firstId);
    expect(followUp.references).toEqual([firstId]);
    expect(followUp.subject).toMatch(/^Re: /);
    expect(followUp.messageId).not.toBe(firstId); // its own id

    // The prospect answers the FOLLOW-UP from another address: still tied to them by the thread.
    const res = await processInboundReply(deps, inboundMail({ fromEmail: "other-address@gmail.com", body: "STOP", inReplyTo: followUp.messageId!, references: `${firstId} ${followUp.messageId}` }), { merchantId: "m1" });
    expect(res.prospectId).toBe("p1");
    expect(res.outcome?.action).toBe("suppress");
  });

  it("never threads on a legacy provider-internal id", async () => {
    const db = await seededDb();
    const p = await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", state: "contacted" }));
    // A first touch sent before the fix, holding Gmail's API id where a Message-Id belongs.
    await db.outreachMessages.insert(sentMessage({ prospectId: p.id, sentAt: new Date(NOW.getTime() - 4 * DAY).toISOString(), providerMessageId: "18c5f0a2b3d4e5f6" }));
    const sender = new FakeSender();

    await advanceSequences(makeDeps(db, { mailer: sender }), "m1", await db.campaigns.require("c1"), NOW);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.inReplyTo).toBeUndefined(); // it used to be sent as `In-Reply-To: 18c5f0a2b3d4e5f6`
    expect(sender.sent[0]!.references).toBeUndefined();
  });
});
