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
import { runSourcing, handleReply, isSuppressed, ingestCandidate, enrich, type RecruitmentDeps } from "../src/index.js";
import type { RawCandidate, EmailFinder, EmailVerifier } from "@affiliate/integrations";

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

  it("triages: pre-scores into bands and defers the cold tail under an enrichment budget", async () => {
    const summary = await runSourcing(deps, "m1", { limit: 12, maxEnrich: 3 });
    expect(summary.discovered).toBeGreaterThan(3);
    // Every discovered prospect lands in exactly one triage band.
    const banded = summary.byBand.hot + summary.byBand.warm + summary.byBand.cold;
    expect(banded).toBe(summary.discovered);
    // Budget respected: only the top `maxEnrich` get enriched, the rest are deferred.
    expect(summary.enriched).toBeLessThanOrEqual(3);
    expect(summary.deferred).toBe(summary.discovered - summary.enriched);
    expect(summary.deferred).toBeGreaterThan(0);
  });

  it("merges two surfaces of the same creator into ONE prospect (cross-platform identity)", async () => {
    const merchant = await db.merchants.require("m1");

    // 1) The creator's YouTube channel, discovered on its own.
    const ytCand: RawCandidate = {
      identity: "Trail Geek",
      siteUrl: null,
      channelUrl: "https://youtube.com/@trailgeek",
      sourceType: "youtube_discovery",
      evidenceUrl: "https://youtube.com/watch?v=abc",
      evidenceSummary: "YouTube creator reviewing trail running shoes.",
      outboundLinks: [],
      synthetic: false,
    };
    const a = await ingestCandidate(deps, merchant, ytCand);
    expect(a).not.toBeNull();

    // 2) Later, the creator's WEBSITE surfaces via backlink mining — its page links the
    //    same YouTube handle, so it's the same person on a different surface.
    const siteCand: RawCandidate = {
      identity: "trailgeek.com",
      siteUrl: "https://trailgeek.com",
      channelUrl: null,
      sourceType: "backlink_mining",
      evidenceUrl: "https://trailgeek.com",
      evidenceSummary: "Promotes competitor.com with an affiliate link — a proven affiliate.",
      outboundLinks: [],
      pageHtml: `<html><body><a href="https://youtube.com/@trailgeek">My YouTube</a></body></html>`,
      confirmedCompetitor: "competitor.com",
      synthetic: false,
    };
    const b = await ingestCandidate(deps, merchant, siteCand);
    expect(b).toBeNull(); // merged into the existing prospect, not a net-new one

    // One unified prospect, carrying BOTH surfaces + a merged identity graph.
    const prospects = await db.prospects.find((p) => p.merchantId === "m1");
    expect(prospects.length).toBe(1);
    const merged = prospects[0]!;
    expect(merged.channelUrl).toBe("https://youtube.com/@trailgeek");
    expect(merged.siteUrl).toBe("https://trailgeek.com"); // filled from the second surface
    const platforms = (merged.evidence?.profile?.accounts ?? []).map((x: { platform: string }) => x.platform);
    expect(platforms).toContain("youtube");
    expect(platforms).toContain("website");
  });

  it("enrich: verification precedence prefers Hunter's mailbox verify over a domain-only MX pass", async () => {
    const discovered = {
      merchantId: "m1", source: "backlink_mining", channelUrl: null, email: null,
      state: "discovered" as const, score: null, tier: null, country: null, language: null,
      suppressionStatus: "none" as const, scoreBreakdown: null, synthetic: false, confidence: null,
      evidence: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    // (a) A Hunter find-candidate already stamped verified:true is trusted — no domain re-verify.
    const mxCalls: string[] = [];
    const trustingFinder: EmailFinder = {
      name: "hunter",
      async find() { return [{ email: "real@brand.com", confidence: 0.9, verified: true, source: "hunter" }]; },
      async verify() { return { deliverable: true, reason: "valid" }; },
    };
    const mxAlwaysGood: EmailVerifier = { kind: "mx", async verify(e: string) { mxCalls.push(e); return { deliverable: true, reason: "mx present" }; } };
    const p1 = await db.prospects.insert({ ...discovered, id: newId("prosp"), identity: "Brand Blog", siteUrl: "https://brand.com" });
    const out1 = await enrich({ ...deps, emailFinder: trustingFinder, emailVerifier: mxAlwaysGood }, p1.id);
    expect(out1.email).toBe("real@brand.com"); // trusted the finder's verified flag
    expect(mxCalls).not.toContain("real@brand.com"); // never re-verified at the domain level

    // (b) An unverified GUESS that MX passes (any gmail.com) must defer to the finder's
    //     mailbox verify — which rejects it — instead of being accepted on the MX pass alone.
    const hunterVerifyCalls: string[] = [];
    const guessingFinder: EmailFinder = {
      name: "hunter",
      async find() { return [{ email: "guess@gmail.com", confidence: 0.8, verified: false, source: "hunter" }]; },
      async verify(e: string) { hunterVerifyCalls.push(e); return { deliverable: false, reason: "mailbox not found" }; },
    };
    const p2 = await db.prospects.insert({ ...discovered, id: newId("prosp"), identity: "Guess Blog", siteUrl: "https://guess-brand.com" });
    const out2 = await enrich({ ...deps, emailFinder: guessingFinder, emailVerifier: mxAlwaysGood }, p2.id);
    expect(hunterVerifyCalls).toContain("guess@gmail.com"); // MX pass deferred to the finder's mailbox verify
    expect(out2.email).toBeNull(); // finder rejected the guess → not accepted on MX alone
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
      synthetic: false,
      confidence: null,
      evidence: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const unsub = await handleReply(deps, prospect.id, "Please unsubscribe me, not interested.");
    expect(unsub.action).toBe("suppress");
    expect(await isSuppressed(deps, "m1", "hi@trailtester.com")).toBe(true);

    // Two-track routing: a B-tier interested reply goes to the automated self-serve
    // track (signup link), not a human meeting.
    const bTier = await db.prospects.insert({ ...prospect, id: newId("prosp"), email: "yes@trailtester.com", tier: "B" });
    const selfServe = await handleReply(deps, bTier.id, "This sounds great, sign me up!");
    expect(selfServe.action).toBe("self_serve");
    expect(selfServe.signupUrl).toBeTruthy();

    // An A-tier interested reply books a meeting (the managed, human-closed track).
    const aTier = await db.prospects.insert({ ...prospect, id: newId("prosp"), email: "vip@trailtester.com", tier: "A" });
    const meeting = await handleReply(deps, aTier.id, "Very interested — let's talk.", { meetingTier: "A" });
    expect(meeting.action).toBe("meeting_booked");
    expect(meeting.meeting).toBeTruthy();
  });
});
