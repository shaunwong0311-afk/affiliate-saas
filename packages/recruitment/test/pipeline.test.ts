import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  MockMailboxSender,
  DEFAULT_DISCOVERY_SOURCES,
} from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { runSourcing, handleReply, isSuppressed, type RecruitmentDeps } from "../src/index.js";

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
    discoverySources: DEFAULT_DISCOVERY_SOURCES,
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
    physicalAddress: null,
    createdAt: new Date().toISOString(),
  });
});

describe("recruitment pipeline", () => {
  it("sources, enriches, and scores prospects into tiers", async () => {
    const summary = await runSourcing(deps, "m1", { limit: 12 });
    expect(summary.discovered).toBeGreaterThan(0);
    expect(summary.scored).toBeGreaterThan(0);

    const prospects = await db.prospects.find((p) => p.merchantId === "m1");
    expect(prospects.length).toBe(summary.discovered);
    // At least some prospects reach a scored state with a tier.
    expect(prospects.some((p) => p.tier != null && p.state === "scored")).toBe(true);

    // Competitor-affiliate mining should surface prospects flagged as promoting a
    // competitor (the strongest signal) — verify a signal was recorded.
    const signals = await db.prospectSignals.all();
    expect(signals.some((s) => s.promotesCompetitor)).toBe(true);
  });

  it("suppresses on unsubscribe and routes interested replies to HITL", async () => {
    const prospect = await db.prospects.insert({
      id: newId("prosp"),
      merchantId: "m1",
      source: "creator_discovery",
      identity: "Trail Tester",
      siteUrl: "https://trailtester.com",
      channelUrl: null,
      email: "hi@trailtester.com",
      state: "contacted",
      score: 60,
      tier: "B",
      country: null,
      language: null,
      suppressionStatus: "none",
      scoreBreakdown: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const unsub = await handleReply(deps, prospect.id, "Please unsubscribe me, not interested.");
    expect(unsub.action).toBe("suppress");
    expect(await isSuppressed(deps, "m1", "hi@trailtester.com")).toBe(true);

    // Two-track routing: a B-tier interested reply goes to the automated self-serve
    // track (signup link), not a human meeting.
    const bTier = await db.prospects.insert({ ...prospect, id: newId("prosp"), email: "yes@trailtester.com", tier: "B" });
    const selfServe = await handleReply(deps, bTier.id, "This sounds great, what's the commission rate?");
    expect(["self_serve", "ai_sdr"]).toContain(selfServe.action);
    expect(selfServe.signupUrl).toBeTruthy();

    // An A-tier interested reply books a meeting (the managed, human-closed track).
    const aTier = await db.prospects.insert({ ...prospect, id: newId("prosp"), email: "vip@trailtester.com", tier: "A" });
    const meeting = await handleReply(deps, aTier.id, "Very interested — let's talk.", { meetingTier: "A" });
    expect(meeting.action).toBe("meeting_booked");
    expect(meeting.meeting).toBeTruthy();
  });
});
