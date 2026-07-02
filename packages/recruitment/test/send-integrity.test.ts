import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Mailbox, type OutreachCampaign, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES, type MailboxSender, type SendResult } from "@affiliate/integrations";
import { newId } from "@affiliate/core";
import { send, launchCampaign, capacityAvailable, pickSendableMailbox, type RecruitmentDeps } from "../src/index.js";

let db: Database;
const NOW = new Date("2026-07-02T12:00:00.000Z"); // a Thursday, 12:00 UTC (inside any 0-24 window)
const clock = { now: () => NOW };

/** A sender whose result is scripted per-call. */
class ScriptedSender implements MailboxSender {
  readonly provider = "scripted";
  calls = 0;
  constructor(private readonly result: SendResult) {}
  async send(): Promise<SendResult> {
    this.calls++;
    return this.result;
  }
}

function makeDeps(over: Partial<RecruitmentDeps> = {}): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock, ...over };
}

function campaign(over: Partial<OutreachCampaign> = {}): OutreachCampaign {
  return { id: "c1", merchantId: "m1", mailboxId: "mbx1", sendingDomainId: null, name: "c", sequence: [{ step: 1, subject: "Hi {{name}}", body: "Intro from {{merchant}} — a real message with enough words to pass the gate.", delayDays: 0 }], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active", ...over } as OutreachCampaign;
}

function mailbox(over: Partial<Mailbox> = {}): Mailbox {
  return { id: "mbx1", merchantId: "m1", provider: "smtp", email: "team@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "ref", ...over };
}

function prospect(over: Partial<Prospect> = {}): Prospect {
  return { id: "p1", merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: "https://tg.com", channelUrl: null, email: "hi@trailgeek.com", state: "queued", score: 80, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over } as Prospect;
}

async function seedMessage(subject = "Partnering with Lumen", body = "Hi Trail Geek — loved your skincare reviews and think you would be a great fit for our program. Interested?") {
  const msg = { id: newId("om"), prospectId: "p1", campaignId: "c1", step: 1, variant: null, subject, body, sentAt: null, status: "queued" as const };
  await db.outreachMessages.insert(msg);
  return msg.id;
}

beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 St", createdAt: NOW.toISOString() });
  await db.mailboxes.insert(mailbox());
  await db.campaigns.insert(campaign());
});

describe("send() result integrity", () => {
  it("a transport 'failed' is NOT a send: message failed with reason, prospect back to scored, nothing billed", async () => {
    await db.prospects.insert(prospect({ state: "queued" }));
    const id = await seedMessage();
    const out = await send(makeDeps({ mailer: new ScriptedSender({ messageId: "", status: "failed", reason: "ECONNREFUSED" }) }), id);

    expect(out.status).toBe("failed");
    expect(out.blockedReason).toContain("send failed");
    expect(out.sentAt).toBeNull();
    expect((await db.prospects.require("p1")).state).toBe("scored"); // retryable, not stranded
    expect(await db.usageEvents.count((u) => u.kind === "send")).toBe(0); // never billed
  });

  it("a successful send stores the provider message id (threading + reply correlation)", async () => {
    await db.prospects.insert(prospect());
    const id = await seedMessage();
    const out = await send(makeDeps({ mailer: new ScriptedSender({ messageId: "<msg-1@lumen>", status: "sent" }) }), id);
    expect(out.status).toBe("sent");
    expect(out.providerMessageId).toBe("<msg-1@lumen>");
  });

  it("refuses to send through an auto-paused mailbox", async () => {
    await db.mailboxes.update("mbx1", { status: "error", autoPausedReason: "bounce breach" });
    await db.prospects.insert(prospect());
    const id = await seedMessage();
    const scripted = new ScriptedSender({ messageId: "x", status: "sent" });
    const out = await send(makeDeps({ mailer: scripted }), id);
    expect(out.status).toBe("failed");
    expect(out.blockedReason).toContain("auto-paused");
    expect(scripted.calls).toBe(0); // nothing transmitted
  });

  it("geo-gates EU/Canada prospects out of the funnel with a recorded reason", async () => {
    await db.prospects.insert(prospect({ country: "DE" }));
    const id = await seedMessage();
    const out = await send(makeDeps(), id);
    expect(out.status).toBe("failed");
    expect(out.blockedReason).toContain("geo-gated");
    expect((await db.prospects.require("p1")).state).toBe("dead");
  });
});

describe("capacity is enforced on the campaign's own mailbox", () => {
  it("a sibling mailbox's headroom cannot keep the gate open for a capped campaign mailbox", async () => {
    // Campaign mailbox is at its cap; a sibling has plenty of headroom.
    await db.mailboxes.update("mbx1", { dailyCap: 1 });
    await db.mailboxes.insert(mailbox({ id: "mbx2", email: "b@lumen.com", dailyCap: 100 }));
    await db.outreachMessages.insert({ id: newId("om"), prospectId: "px", campaignId: "c1", step: 1, variant: null, subject: "s", body: "b", sentAt: NOW.toISOString(), status: "sent" });

    const camp = await db.campaigns.require("c1");
    expect(await capacityAvailable(makeDeps(), "m1", camp, NOW)).toBe(false);
  });

  it("a day-0 warming mailbox exposes the ramp cap (5), not the full cap", async () => {
    await db.mailboxes.update("mbx1", { warmupStatus: "warming", warmupStartedAt: NOW.toISOString(), dailyCap: 50 });
    // 5 sends today = ramp exhausted.
    for (let i = 0; i < 5; i++) {
      await db.outreachMessages.insert({ id: newId("om"), prospectId: `p${i}`, campaignId: "c1", step: 1, variant: null, subject: "s", body: "b", sentAt: NOW.toISOString(), status: "sent" });
    }
    expect(await pickSendableMailbox(makeDeps(), "m1", NOW)).toBeNull();
    expect(await capacityAvailable(makeDeps(), "m1", await db.campaigns.require("c1"), NOW)).toBe(false);
  });
});

describe("launchCampaign guards", () => {
  it("refuses to launch outside the campaign send window", async () => {
    await db.campaigns.update("c1", { sendWindow: { startHour: 20, endHour: 22, timezone: "UTC" } }); // NOW is 12:00 UTC
    await db.prospects.insert(prospect({ state: "scored" }));
    const r = await launchCampaign(makeDeps(), "c1");
    expect(r.sent).toBe(0);
    expect(r.blockedReason).toContain("send window");
  });

  it("stops at the campaign mailbox's remaining cap even when asked for more", async () => {
    await db.mailboxes.update("mbx1", { dailyCap: 1 });
    await db.prospects.insert(prospect({ id: "p1", email: "a@x.com", state: "scored" }));
    await db.prospects.insert(prospect({ id: "p2", email: "b@x.com", state: "scored" }));
    const r = await launchCampaign(makeDeps(), "c1", { max: 10 });
    expect(r.sent).toBe(1); // cap 1 → one send, the rest deferred
    expect(r.deferred).toBeGreaterThanOrEqual(1);
  });
});
