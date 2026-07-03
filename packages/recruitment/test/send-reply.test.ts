import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES, type MailboxSender, type OutboundEmail, type SendResult } from "@affiliate/integrations";
import { newId } from "@affiliate/core";
import { sendReplyToProspect, type RecruitmentDeps } from "../src/index.js";

let db: Database;
const NOW = new Date("2026-07-02T12:00:00.000Z");
const clock = { now: () => NOW };

class RecordingSender implements MailboxSender {
  readonly provider = "rec";
  sent: OutboundEmail[] = [];
  async send(email: OutboundEmail): Promise<SendResult> {
    this.sent.push(email);
    return { messageId: "<reply-1@lumen>", status: "sent" };
  }
}

function makeDeps(sender: MailboxSender): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: sender, discoverySources: DEFAULT_DISCOVERY_SOURCES, clock };
}

const prospect = (over: Partial<Prospect> = {}): Prospect => ({ id: "p1", merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: "https://tg.com", channelUrl: null, email: "creator@site.com", state: "replied", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over }) as Prospect;

beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: NOW.toISOString() });
  await db.mailboxes.insert({ id: "mbx1", merchantId: "m1", provider: "smtp", email: "team@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "r" });
  await db.campaigns.insert({ id: "c1", merchantId: "m1", mailboxId: "mbx1", sendingDomainId: null, name: "c", sequence: [], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active" });
  await db.prospects.insert(prospect());
  // The original outreach (so we can resolve the mailbox + build a Re: subject).
  await db.outreachMessages.insert({ id: newId("om"), prospectId: "p1", campaignId: "c1", step: 1, variant: null, subject: "Partner with Lumen", body: "b", sentAt: NOW.toISOString(), status: "sent", providerMessageId: "<orig@lumen>" });
});

describe("sendReplyToProspect", () => {
  it("sends as the merchant, threaded onto the inbound message, and records the sent reply", async () => {
    const sender = new RecordingSender();
    const res = await sendReplyToProspect(makeDeps(sender), { prospectId: "p1", body: "Here's your link!", inReplyToMessageId: "<their-inbound@site>" });

    expect(res.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0]!;
    expect(email.fromEmail).toBe("team@lumen.com"); // as the merchant's mailbox
    expect(email.toEmail).toBe("creator@site.com");
    expect(email.subject).toBe("Re: Partner with Lumen"); // threaded subject
    expect(email.inReplyTo).toBe("<their-inbound@site>"); // in-conversation

    const replyMsg = await db.outreachMessages.findOne((m) => m.variant === "reply");
    expect(replyMsg?.status).toBe("sent");
    expect(replyMsg?.providerMessageId).toBe("<reply-1@lumen>");
  });

  it("reports a transport failure instead of pretending it sent", async () => {
    const failing: MailboxSender = { provider: "x", async send() { return { messageId: "", status: "failed", reason: "smtp down" }; } };
    const res = await sendReplyToProspect(makeDeps(failing), { prospectId: "p1", body: "hi" });
    expect(res.sent).toBe(false);
    expect(res.reason).toContain("smtp down");
    expect(await db.outreachMessages.count((m) => m.variant === "reply")).toBe(0);
  });
});
