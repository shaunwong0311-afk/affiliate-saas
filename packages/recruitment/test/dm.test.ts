import { describe, it, expect } from "vitest";
import { buildProfile } from "@affiliate/core";
import { createMemoryDatabase } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock } from "@affiliate/core";
import { dmDeepLink, bestDmTarget, draftDm, dmFollowupTargets, type RecruitmentDeps } from "../src/index.js";
import type { Merchant, Prospect, ProspectState, Tier } from "@affiliate/db";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const igProfile = () => buildProfile("https://x.com", [{ url: "https://x.com", links: ["https://instagram.com/handle"] }]);

describe("dmDeepLink", () => {
  it("opens the composer for Instagram and Telegram", () => {
    expect(dmDeepLink("instagram", "@trailgeek")).toEqual({ url: "https://ig.me/m/trailgeek", opensComposer: true });
    expect(dmDeepLink("telegram", "trailgeek")).toEqual({ url: "https://t.me/trailgeek", opensComposer: true });
  });
  it("opens the profile (manual Message) for X and TikTok, nothing for YouTube", () => {
    expect(dmDeepLink("twitter", "@tg")).toMatchObject({ url: "https://x.com/tg", opensComposer: false });
    expect(dmDeepLink("youtube", "x")).toEqual({ url: null, opensComposer: false });
  });
});

describe("bestDmTarget", () => {
  it("picks the highest-priority handle from the identity graph", () => {
    const profile = buildProfile("https://creator.com", [
      { url: "https://creator.com", links: ["https://instagram.com/trailgeek", "https://twitter.com/trailgeek"] },
    ]);
    const t = bestDmTarget(profile);
    expect(t!.platform).toBe("instagram"); // IG ranks above twitter
    expect(t!.deepLink).toBe("https://ig.me/m/trailgeek");
  });
  it("returns null when there's no DM-able handle", () => {
    expect(bestDmTarget(buildProfile("https://creator.com", []))).toBeNull();
  });
});

describe("draftDm", () => {
  it("drafts a DM (template fallback) for a prospect with a social handle", async () => {
    const db = createMemoryDatabase();
    const deps: RecruitmentDeps = { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: systemClock };
    const merchant = { id: "m1", name: "Lumen", niche: "skincare" } as Merchant;
    const prospect = { id: "p1", identity: "Trail Geek", evidence: { profile: buildProfile("https://tg.com", [{ url: "https://tg.com", links: ["https://instagram.com/tg"] }]) } } as unknown as Prospect;
    const draft = await draftDm(deps, merchant, prospect);
    expect(draft!.target.platform).toBe("instagram");
    expect(draft!.message).toContain("Lumen");
    expect(draft!.mode).toBe("template");
  });
});

describe("dmFollowupTargets", () => {
  it("returns high-quality, emailed, no-reply prospects with a DM handle — excluding the rest", async () => {
    const db = createMemoryDatabase();
    const deps: RecruitmentDeps = { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: systemClock };
    const base = { merchantId: "m1", source: "x", identity: "C", siteUrl: null, channelUrl: null, email: "c@x.com", score: 70, country: null, language: null, suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: null, createdAt: daysAgo(10), updatedAt: daysAgo(5) } as const;
    const mk = async (id: string, tier: Tier, state: ProspectState, o: { handle?: boolean; emailedDaysAgo?: number; replied?: boolean } = {}) => {
      await db.prospects.insert({ ...base, id, tier, state, evidence: o.handle === false ? {} : { profile: igProfile() } } as unknown as Prospect);
      if (o.emailedDaysAgo != null) await db.outreachMessages.insert({ id: `om_${id}`, prospectId: id, campaignId: "c", step: 1, variant: null, subject: "s", body: "b", sentAt: daysAgo(o.emailedDaysAgo), status: "sent" });
      if (o.replied) await db.replies.insert({ id: `rep_${id}`, prospectId: id, raw: "yes", classification: "interested", handledBy: null, ts: daysAgo(1) });
    };
    await mk("p1", "A", "contacted", { emailedDaysAgo: 5 }); // qualifies
    await mk("p2", "A", "contacted", { emailedDaysAgo: 5, replied: true }); // replied → out
    await mk("p3", "A", "contacted", { emailedDaysAgo: 5, handle: false }); // no DM handle → out
    await mk("p4", "A", "contacted", { emailedDaysAgo: 1 }); // emailed too recently → out
    await mk("p5", "C", "contacted", { emailedDaysAgo: 5 }); // below min tier → out

    const t = await dmFollowupTargets(deps, "m1");
    expect(t.map((x) => x.prospectId)).toEqual(["p1"]);
    expect(t[0]!.target.platform).toBe("instagram");
    expect(t[0]!.daysSinceEmail).toBeGreaterThanOrEqual(3);
  });
});
