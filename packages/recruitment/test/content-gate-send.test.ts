import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type OutreachMessage, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { send, type RecruitmentDeps } from "../src/index.js";

let db: Database;

function makeDeps(): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: systemClock };
}

async function seed(subject: string, body: string): Promise<string> {
  await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 St, City", createdAt: new Date().toISOString() });
  const p: Prospect = { id: "p1", merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: "https://tg.com", channelUrl: null, email: "hi@trailgeek.com", state: "queued", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Prospect;
  await db.prospects.insert(p);
  await db.campaigns.insert({ id: "c1", merchantId: "m1", mailboxId: null, sendingDomainId: null, name: "c", sequence: [], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active" });
  const msg: OutreachMessage = { id: newId("om"), prospectId: "p1", campaignId: "c1", step: 1, variant: null, subject, body, sentAt: null, status: "queued" };
  await db.outreachMessages.insert(msg);
  return msg.id;
}

beforeEach(() => {
  db = createMemoryDatabase();
});

describe("send() pre-send content gate", () => {
  it("blocks a spammy message before it leaves and records the reason", async () => {
    const id = await seed("FREE MONEY!!!", "Get free money now, $$$ guaranteed income — act now!!!");
    const out = await send(makeDeps(), id);
    expect(out.status).toBe("failed");
    expect(out.blockedReason).toMatch(/content gate/);
    expect(out.sentAt).toBeNull(); // never sent
  });

  it("sends a clean message normally", async () => {
    const id = await seed("Partnering with Lumen", "Hi Trail Geek — loved your skincare reviews. We pay 15% and think you'd be a great fit. Want details?");
    const out = await send(makeDeps(), id);
    expect(out.status).toBe("sent");
    expect(out.sentAt).toBeTruthy();
  });
});
