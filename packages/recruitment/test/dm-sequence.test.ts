import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type OutreachCampaign, type Prospect, type SequenceStep } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { advanceSequences, type RecruitmentDeps } from "../src/index.js";

let db: Database;
// A Thursday, 09:00 for a US recipient. (Was a Sunday 12:00 UTC: since AUDIT-2026-10 O12 the
// autonomous path applies the recipient-local send-time gate too, and a US prospect is not
// emailed at 06:00 on a Sunday. The assertions are unchanged.)
const NOW = new Date("2026-07-02T15:00:00.000Z");
const clock = { now: () => NOW };

function makeDeps(): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock };
}

const sequence: SequenceStep[] = [
  { step: 1, subject: "Hi {{name}}", body: "Intro", delayDays: 0, channel: "email" } as SequenceStep,
  { step: 2, subject: "", body: "", delayDays: 0, channel: "dm" } as SequenceStep,
  { step: 3, subject: "Following up {{name}}", body: "Circling back", delayDays: 0, channel: "email" } as SequenceStep,
];

const campaign: OutreachCampaign = {
  id: "c1", merchantId: "m1", mailboxId: "mbx1", sendingDomainId: null, name: "seq",
  sequence, sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active",
};

function prospect(over: Partial<Prospect> = {}): Prospect {
  return {
    id: "p1", merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: "https://tg.com", channelUrl: null,
    email: "hi@trailgeek.com", state: "contacted", score: 70, tier: "B", country: "US", language: "en",
    suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6,
    evidence: { profile: { accounts: [{ platform: "instagram", handle: "trailgeek", url: "https://instagram.com/trailgeek", confidence: 0.9 }] } },
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  } as Prospect;
}

beforeEach(async () => {
  db = createMemoryDatabase();
  // Fixture updated for AUDIT-2026-10 (the assertions are unchanged): an email follow-up now
  // needs what a compliant, connected setup has — the merchant's postal address (O13) and a
  // mailbox whose replies are being read (`inboundStatus: "ok"`, O5).
  await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Market St, San Francisco, CA", createdAt: NOW.toISOString() });
  await db.mailboxes.insert({ id: "mbx1", merchantId: "m1", provider: "smtp", email: "team@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "r", inboundStatus: "ok" });
  await db.campaigns.insert(campaign);
  await db.prospects.insert(prospect());
  // First touch already sent at step 1 (a day ago) → the DM step (2) is now due.
  await db.outreachMessages.insert({ id: newId("om"), prospectId: "p1", campaignId: "c1", step: 1, variant: null, subject: "Hi", body: "Intro", sentAt: new Date(NOW.getTime() - 86_400_000).toISOString(), status: "sent" });
});

describe("advanceSequences with a channel:dm step", () => {
  it("auto-creates a fully-prepared DM task instead of sending an email (never auto-DM)", async () => {
    const res = await advanceSequences(makeDeps(), "m1", campaign, NOW);
    expect(res.dmTasksCreated).toBe(1);
    expect(res.emailsSent).toBe(0);

    const tasks = await db.dmTasks.find(() => true);
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.step).toBe(2);
    expect(t.status).toBe("pending");
    expect(t.platform).toBe("instagram");
    expect(t.deepLink).toContain("ig.me"); // native composer deep link
    expect(t.message.length).toBeGreaterThan(10); // a real drafted message
    // No email was queued/sent for the DM step.
    expect(await db.outreachMessages.count((m) => m.step === 2)).toBe(0);
  });

  it("is idempotent — a second pass does not duplicate the DM task", async () => {
    await advanceSequences(makeDeps(), "m1", campaign, NOW);
    await advanceSequences(makeDeps(), "m1", campaign, NOW);
    expect(await db.dmTasks.count(() => true)).toBe(1);
  });

  it("advances past the DM step to the next email step once the DM task exists", async () => {
    await advanceSequences(makeDeps(), "m1", campaign, NOW); // creates DM task at step 2
    const res = await advanceSequences(makeDeps(), "m1", campaign, NOW); // step 3 (email) now due
    expect(res.emailsSent).toBe(1);
    expect(await db.outreachMessages.count((m) => m.step === 3 && m.status === "sent")).toBe(1);
  });

  it("records a skipped task (advancing the cadence) when there's no DM-able handle", async () => {
    await db.prospects.update("p1", { evidence: {} }); // no profile → no handle
    const res = await advanceSequences(makeDeps(), "m1", campaign, NOW);
    expect(res.dmTasksCreated).toBe(0);
    const tasks = await db.dmTasks.find(() => true);
    expect(tasks[0]?.status).toBe("skipped");
  });
});
