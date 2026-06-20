import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  MockMailboxSender,
  StubCalendarBooking,
  SerpDiscoverySource,
  CompetitorAffiliateSource,
  DbCustomerMiningSource,
} from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { autonomousCycle, setAutomationState, sourceYield, type RecruitmentDeps } from "../src/index.js";

let db: Database;
let deps: RecruitmentDeps;

beforeEach(async () => {
  db = createMemoryDatabase();
  deps = {
    db,
    embedder: new HashingEmbedder(),
    llm: new DeterministicLlm(),
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: [new SerpDiscoverySource(), new CompetitorAffiliateSource(), new DbCustomerMiningSource(db)],
    calendar: new StubCalendarBooking(),
    clock: systemClock,
  };
  await db.merchants.insert({
    id: "m1",
    name: "PeakGear",
    status: "active",
    niche: "trail running",
    competitors: ["competitor.com"],
    billingStatus: "active",
    defaultCurrency: "USD",
    postbackSecret: "s",
    physicalAddress: "1 Trailhead Rd",
    createdAt: new Date().toISOString(),
  });
  await db.mailboxes.insert({
    id: "mbx1",
    merchantId: "m1",
    provider: "gmail",
    email: "owner@peakgear.test",
    status: "connected",
    dailyCap: 100,
    warmupStatus: "ready",
    credentialsRef: "",
  });
  await db.campaigns.insert({
    id: "camp1",
    merchantId: "m1",
    mailboxId: "mbx1",
    sendingDomainId: null,
    name: "Q3",
    sequence: [
      { step: 1, delayDays: 0, subject: "Partner with {{merchant}}?", body: "Hi {{name}}, {{angle}}", kind: "initial" },
      { step: 2, delayDays: 3, subject: "Following up", body: "Circling back, {{name}}.", kind: "follow_up" },
    ],
    sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" },
    dailyCap: 100,
    status: "active",
  });
});

describe("autonomous cycle", () => {
  it("is a no-op when automation is off", async () => {
    const result = await autonomousCycle(deps, "m1");
    expect(result.status).toBe("off");
    expect(result.sourced).toBe(0);
  });

  it("sources, scores, and auto-sends within the HITL gate when running", async () => {
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, hitlTier: "A", sourcingLimitPerCycle: 12 });
    const result = await autonomousCycle(deps, "m1");

    expect(result.status).toBe("running");
    expect(result.sourced).toBeGreaterThan(0);
    expect(result.circuitOpen).toBe(false);
    // With autoSendMinScore 0 and HITL only on A-tier, non-A prospects with a
    // verified email auto-send; A-tier are held for the human gate.
    expect(result.autoSent + result.heldForReview).toBeGreaterThan(0);

    // Anything actually sent shows up as a sent outreach message.
    if (result.autoSent > 0) {
      const sent = await db.outreachMessages.count((m) => m.status === "sent");
      expect(sent).toBeGreaterThanOrEqual(result.autoSent);
    }
  });

  it("holds prospects for review when the HITL tier is set to C (everything gated)", async () => {
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, hitlTier: "C", sourcingLimitPerCycle: 10 });
    const result = await autonomousCycle(deps, "m1");
    expect(result.autoSent).toBe(0); // every tier requires a human
    expect(result.heldForReview).toBeGreaterThan(0);
  });

  it("computes per-source yield", async () => {
    await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, sourcingLimitPerCycle: 10 });
    await autonomousCycle(deps, "m1");
    // Mark one prospect as a producer to exercise the yield math.
    const prospect = (await db.prospects.find((p) => p.merchantId === "m1"))[0]!;
    await db.prospectOutcomes.insert({
      id: newId("pout"),
      merchantId: "m1",
      prospectId: prospect.id,
      relationshipId: null,
      sourceType: prospect.source,
      label: "produced_sales",
      producedRevenueCents: 25_000,
      ts: new Date().toISOString(),
    });
    const yields = await sourceYield(deps, "m1");
    expect(yields.length).toBeGreaterThan(0);
    expect(yields.some((y) => y.producing >= 1)).toBe(true);
  });
});
