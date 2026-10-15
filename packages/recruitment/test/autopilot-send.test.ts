import { describe, it, expect } from "vitest";
import type { Database, Merchant } from "@affiliate/db";
import type { LlmClient } from "@affiliate/integrations";
import { ingestReplies, processInboundReply, setAutomationState, suppress } from "../src/index.js";
import { FakeSender, inboundMail, makeDeps, prospectRow, seededDb, sentMessage } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 O8 — autopilot returned `autoSend: true` with no consumer and no handoff: the
 * reply was stored and nothing else happened. It must do something real: send the
 * deterministic knowledge-base answers through the existing reply transport, and create a
 * handoff for everything else.
 */

async function setup(opts: { merchant?: Partial<Merchant> } = {}): Promise<{ db: Database; prospectId: string }> {
  const db = await seededDb({ merchant: opts.merchant });
  await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: "https://lumen/terms", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
  await db.offers.insert({ id: "off1", merchantId: "m1", programId: "prog1", engine: "affiliate", name: "Default", payoutType: "percentage", payoutValue: 0.15, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
  const p = await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", state: "contacted" }));
  await db.outreachMessages.insert(sentMessage({ prospectId: p.id, providerMessageId: "<first@lumen.com>" }));
  return { db, prospectId: p.id };
}

/** A threaded reply to our first touch, with a real inbound Message-Id. */
const reply = (body: string) => inboundMail({ body, messageId: "their-reply-1@site.com", inReplyTo: "<first@lumen.com>" });
const AUTOPILOT = { merchantId: "m1", aiSdrMode: "autopilot" as const };

describe("autopilot sends a deterministic knowledge-base answer for real", () => {
  it("emails the answer, threaded onto their reply, and marks the reply handled by the AI-SDR", async () => {
    const { db, prospectId } = await setup();
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });

    const res = await processInboundReply(deps, reply("How long is the cookie window?"), AUTOPILOT);

    expect(res.outcome).toMatchObject({ action: "ai_sdr", autoSend: true });
    // It actually went out — to the prospect, as the merchant, in their thread.
    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0]!;
    expect(email.toEmail).toBe("creator@site.com");
    expect(email.fromEmail).toBe("team@lumen.com");
    expect(email.body).toContain("30 days");
    expect(email.inReplyTo).toBe("<their-reply-1@site.com>");
    expect(email.references).toEqual(["<first@lumen.com>", "<their-reply-1@site.com>"]);
    expect(email.subject).toMatch(/^Re: /);
    // An automated message carries the compliance footer.
    expect(email.body).toContain("1 Market St, San Francisco, CA");
    expect(email.body).toMatch(/reply STOP/);
    // Recorded as a sent reply; the inbound reply shows who handled it; nobody is paged.
    const sentReply = await db.outreachMessages.findOne((m) => m.variant === "reply");
    expect(sentReply).toMatchObject({ prospectId, status: "sent" });
    expect(sentReply!.providerMessageId).toMatch(/@lumen\.com>$/);
    expect((await db.replies.find((r) => r.prospectId === prospectId))[0]!.handledBy).toBe("ai_sdr");
    expect(res.outcome!.handoff).toBeUndefined();
    expect(await db.handoffs.count(() => true)).toBe(0);
  });

  it("when the send fails, a handoff carries the answer — never silence, never a claimed send", async () => {
    const { db, prospectId } = await setup();
    const sender = new FakeSender({ messageId: "", status: "failed", reason: "smtp down", failure: "network" });
    const res = await processInboundReply(makeDeps(db, { mailer: sender }), reply("How long is the cookie window?"), AUTOPILOT);

    expect(res.outcome).toMatchObject({ action: "ai_sdr", autoSend: false, needsHuman: true });
    expect(res.outcome!.autoSendError).toContain("smtp down");
    expect(res.outcome!.handoff).toMatchObject({ reason: "approval", status: "open" });
    expect(res.outcome!.handoff!.suggestedReply).toContain("30 days");
    expect(res.outcome!.handoff!.summary).toMatch(/autopilot could not send/);
    expect(await db.outreachMessages.count((m) => m.variant === "reply")).toBe(0);
    expect((await db.replies.find((r) => r.prospectId === prospectId))[0]!.handledBy).toBeNull();
  });

  it("two readers handing over the same reply at once answer it ONCE", async () => {
    // The API's in-process scheduler and the worker both tick; each reads the same inbox.
    const { db, prospectId } = await setup();
    const sender = new FakeSender({ messageId: "", status: "sent" }, 3);
    const poller = async () => {
      await new Promise((r) => setTimeout(r, 2)); // a real inbox read takes a moment
      return [reply("How long is the cookie window?")];
    };
    const deps = makeDeps(db, { mailer: sender, replyPoller: poller });
    await setAutomationState(deps, "m1", { aiSdrMode: "autopilot" });

    await Promise.all([ingestReplies(deps), ingestReplies(deps)]);

    expect(sender.sent).toHaveLength(1); // one answer, not two
    expect(await db.replies.count((r) => r.prospectId === prospectId)).toBe(1);
    expect(await db.outreachMessages.count((m) => m.variant === "reply")).toBe(1);
  });

  it("without the merchant's postal address an automated reply is not sent — handoff instead", async () => {
    const { db } = await setup({ merchant: { physicalAddress: null } });
    const sender = new FakeSender();
    const res = await processInboundReply(makeDeps(db, { mailer: sender }), reply("What's the commission rate?"), AUTOPILOT);
    expect(sender.attempts).toHaveLength(0);
    expect(res.outcome!.autoSend).toBe(false);
    expect(res.outcome!.autoSendError).toMatch(/postal address/);
    expect(res.outcome!.handoff?.suggestedReply).toContain("15%");
  });
});

describe("autopilot hands everything else to a person", () => {
  it.each([
    ["a gated topic (rate negotiation)", "Love it — can we negotiate a higher commission rate?", "gated_topic"],
    ["a question the knowledge base cannot answer", "Do you have a wondering question about your loyalty tiers?", "ungrounded"],
  ])("%s → handoff, nothing sent", async (_name, text, reason) => {
    const { db } = await setup();
    const sender = new FakeSender();
    const res = await processInboundReply(makeDeps(db, { mailer: sender }), reply(text), AUTOPILOT);
    expect(sender.attempts).toHaveLength(0);
    expect(res.outcome!.handoff?.reason).toBe(reason);
    expect(res.outcome!.autoSend ?? false).toBe(false);
  });

  it("a GENERATIVE answer is never auto-sent, even in autopilot", async () => {
    const { db } = await setup();
    await db.merchantFaqs.insert({ id: "f1", merchantId: "m1", question: "Do you ship internationally?", answer: "Yes, to 40 countries.", createdAt: new Date().toISOString() });
    const llm: LlmClient = { model: "fake-llm", async complete(prompt) { return /Classify/.test(prompt) ? '{"classification":"question"}' : "We do offer sample kits for partners — happy to send one over."; } };
    const sender = new FakeSender();
    const res = await processInboundReply(makeDeps(db, { mailer: sender, llm }), reply("Could partners get product samples to try first?"), AUTOPILOT);
    expect(sender.attempts).toHaveLength(0);
    expect(res.outcome).toMatchObject({ action: "ai_sdr", autoSend: false, needsHuman: true });
    expect(res.outcome!.handoff?.suggestedReply).toContain("sample kits");
  });

  it("HITL mode is unchanged: the answer is queued for approval", async () => {
    const { db } = await setup();
    const sender = new FakeSender();
    const res = await processInboundReply(makeDeps(db, { mailer: sender }), reply("How long is the cookie window?"), { merchantId: "m1", aiSdrMode: "hitl" });
    expect(sender.attempts).toHaveLength(0);
    expect(res.outcome!.handoff?.suggestedReply).toContain("30 days");
  });

  it("never auto-answers mail that is not tied to our outreach", async () => {
    const { db } = await setup();
    const sender = new FakeSender();
    const res = await processInboundReply(makeDeps(db, { mailer: sender }), inboundMail({ subject: "Quick one", body: "How long is the cookie window?" }), AUTOPILOT);
    expect(sender.attempts).toHaveLength(0);
    expect(res.outcome!.handoff?.suggestedReply).toContain("30 days");
  });

  it("does not answer someone who has since unsubscribed", async () => {
    const { db } = await setup();
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });
    await suppress(deps, { merchantId: "m1", email: "creator@site.com", reason: "unsubscribe", scope: "global" });
    const res = await processInboundReply(deps, reply("How long is the cookie window?"), AUTOPILOT);
    expect(sender.attempts).toHaveLength(0);
    expect(res.outcome!.autoSend).toBe(false);
    expect(res.outcome!.autoSendError).toMatch(/unsubscribed/);
  });
});
