import { describe, it, expect } from "vitest";
import { buildProfile } from "@affiliate/core";
import { createMemoryDatabase } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock } from "@affiliate/core";
import { dmDeepLink, bestDmTarget, draftDm, type RecruitmentDeps } from "../src/index.js";
import type { Merchant, Prospect } from "@affiliate/db";

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
