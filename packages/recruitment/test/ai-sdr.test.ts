import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Merchant, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, StubNotifier, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { handleReply, type RecruitmentDeps } from "../src/index.js";

let db: Database;
let notifier: StubNotifier;

const merchant: Merchant = { id: "m1", name: "Lumen Skincare", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString() };

function makeDeps(): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, notifier, clock: systemClock };
}

function prospect(over: Partial<Prospect> = {}): Prospect {
  return { id: newId("prosp"), merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: "https://trailgeek.com", channelUrl: null, email: "hi@trailgeek.com", state: "contacted", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over } as Prospect;
}

beforeEach(async () => {
  db = createMemoryDatabase();
  notifier = new StubNotifier();
  await db.merchants.insert(merchant);
  await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: "https://lumen/terms", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
  await db.offers.insert({ id: "off1", merchantId: "m1", programId: "prog1", engine: "affiliate", name: "Default", payoutType: "percentage", payoutValue: 0.15, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
});

describe("AI-SDR reply routing", () => {
  it("hard-gates a rate-negotiation reply to a human handoff + notifies", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "Love it — but can we negotiate a higher commission rate?");
    expect(out.action).toBe("handoff");
    expect(out.needsHuman).toBe(true);
    expect(out.handoff?.reason).toBe("gated_topic");
    expect(out.handoff?.topic).toBe("rate_negotiation");
    expect(out.answer).toBeUndefined(); // never auto-answered
    expect(await db.handoffs.count(() => true)).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("answers a commission question from the KB but queues it for approval in HITL mode", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "Quick q — what's your commission rate?", { aiSdrMode: "hitl" });
    expect(out.action).toBe("ai_sdr");
    expect(out.answer).toContain("15%");
    expect(out.autoSend).toBe(false);
    expect(out.handoff?.reason).toBe("approval");
    expect(out.handoff?.suggestedReply).toContain("15%");
  });

  it("auto-sends a deterministic allow-listed answer in autopilot mode (no handoff)", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "How long is the cookie window?", { aiSdrMode: "autopilot" });
    expect(out.action).toBe("ai_sdr");
    expect(out.autoSend).toBe(true);
    expect(out.answer).toContain("30 days");
    expect(out.handoff).toBeUndefined();
    expect(await db.handoffs.count(() => true)).toBe(0);
  });

  it("routes an ungrounded open question to a human (no LLM wired → won't guess)", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "Do you have a wondering question about your loyalty tiers?", { aiSdrMode: "autopilot" });
    expect(out.action).toBe("handoff");
    expect(out.handoff?.reason).toBe("ungrounded");
  });

  it("A-tier warm reply books a meeting AND opens a high-urgency handoff", async () => {
    const p = await db.prospects.insert(prospect({ tier: "A" }));
    const out = await handleReply(makeDeps(), p.id, "This sounds great, let's talk!", { meetingTier: "A" });
    expect(out.action).toBe("meeting_booked");
    expect(out.handoff?.reason).toBe("high_value");
    expect(notifier.sent[0].urgency).toBe("high");
  });

  it("a pure interested reply with nothing to answer goes straight to self-serve", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "Sounds good, sign me up!");
    expect(out.action).toBe("self_serve");
    expect(await db.handoffs.count(() => true)).toBe(0);
  });
});
