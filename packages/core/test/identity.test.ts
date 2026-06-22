import { describe, it, expect } from "vitest";
import { classifyAccountUrl, seedAccount, buildProfile, addPageToProfile } from "../src/index.js";

describe("classifyAccountUrl", () => {
  it("recognizes known creator platforms with handles", () => {
    expect(classifyAccountUrl("https://youtube.com/@trailrunner")).toMatchObject({ platform: "youtube", handle: "@trailrunner" });
    expect(classifyAccountUrl("https://www.youtube.com/channel/UC123")).toMatchObject({ platform: "youtube", handle: "UC123" });
    expect(classifyAccountUrl("https://x.com/trailrunner")).toMatchObject({ platform: "twitter", handle: "@trailrunner" });
    expect(classifyAccountUrl("https://twitter.com/trailrunner")).toMatchObject({ platform: "twitter", handle: "@trailrunner" });
    expect(classifyAccountUrl("https://trailrunner.substack.com")).toMatchObject({ platform: "substack", handle: "trailrunner" });
    expect(classifyAccountUrl("https://podcasts.apple.com/us/podcast/x/id123")).toMatchObject({ platform: "podcast" });
    expect(classifyAccountUrl("https://open.spotify.com/show/abc")).toMatchObject({ platform: "podcast" });
    expect(classifyAccountUrl("https://linktr.ee/trailrunner")).toMatchObject({ platform: "linktree", handle: "trailrunner" });
  });

  it("returns null for unknown hosts (never treats every link as 'their blog')", () => {
    expect(classifyAccountUrl("https://some-random-blog.com/post/123")).toBeNull();
    expect(classifyAccountUrl("mailto:x@y.com")).toBeNull();
    expect(classifyAccountUrl("not a url")).toBeNull();
  });

  it("seedAccount falls back to a website account for a bare domain", () => {
    expect(seedAccount("https://trailrunner.com/about")).toMatchObject({ platform: "website", url: "https://trailrunner.com" });
    expect(seedAccount("https://youtube.com/@x")).toMatchObject({ platform: "youtube" });
  });
});

describe("buildProfile", () => {
  it("makes the seed the primary account with full confidence", () => {
    const p = buildProfile("https://trailrunner.com", []);
    expect(p.primary?.platform).toBe("website");
    expect(p.primary?.provenance).toBe("seed");
    expect(p.primary?.confidence).toBe(1);
  });

  it("treats one-directional links on the page as LOW confidence", () => {
    const p = buildProfile("https://trailrunner.com", [
      { url: "https://trailrunner.com", links: ["https://youtube.com/@someone", "https://x.com/someone"] },
    ]);
    const yt = p.accounts.find((a) => a.platform === "youtube")!;
    expect(yt.provenance).toBe("page_link");
    expect(yt.confidence).toBeLessThan(0.6);
    expect(p.identityConfidence).toBeLessThan(0.6);
  });

  it("treats bio-aggregator listings as HIGH confidence", () => {
    const p = buildProfile("https://trailrunner.com", [
      { url: "https://linktr.ee/trailrunner", links: ["https://youtube.com/@trailrunner", "https://x.com/trailrunner"], bioAggregator: true },
    ]);
    const yt = p.accounts.find((a) => a.platform === "youtube")!;
    expect(yt.provenance).toBe("bio_aggregator");
    expect(yt.confidence).toBeGreaterThanOrEqual(0.9);
    expect(p.identityConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects reciprocity: a page that links the account AND back to the seed", () => {
    const p = buildProfile("https://trailrunner.com", [
      // a separate page (not the seed, not a bio aggregator) that links both the
      // account and back to the seed → reciprocal, high confidence.
      { url: "https://press.example/feature", links: ["https://youtube.com/@trailrunner", "https://trailrunner.com/about"] },
    ]);
    const yt = p.accounts.find((a) => a.platform === "youtube")!;
    expect(yt.provenance).toBe("reciprocal_link");
    expect(yt.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("ignores share-widget / platform hosts and never invents audience data", () => {
    const p = buildProfile("https://trailrunner.com", [
      { url: "https://trailrunner.com", links: ["https://facebook.com/sharer", "https://amazon.com/dp/x", "https://youtube.com/@trailrunner"] },
    ]);
    expect(p.accounts.some((a) => a.url.includes("facebook"))).toBe(false);
    expect(p.accounts.some((a) => a.url.includes("amazon"))).toBe(false);
    expect(p.audience).toEqual({ reach: null, primaryGeo: null, language: null, engagementRate: null, source: null });
  });
});

describe("addPageToProfile", () => {
  it("upgrades a page_link account to bio_aggregator when later found on a Linktree", () => {
    const base = buildProfile("https://trailrunner.com", [
      { url: "https://trailrunner.com", links: ["https://youtube.com/@trailrunner"] },
    ]);
    expect(base.accounts.find((a) => a.platform === "youtube")!.provenance).toBe("page_link");

    const grown = addPageToProfile(
      base,
      { url: "https://linktr.ee/trailrunner", links: ["https://youtube.com/@trailrunner", "https://trailrunner.substack.com"], bioAggregator: true },
      "https://trailrunner.com",
    );
    expect(grown.accounts.find((a) => a.platform === "youtube")!.provenance).toBe("bio_aggregator");
    expect(grown.accounts.some((a) => a.platform === "substack")).toBe(true);
    expect(grown.identityConfidence).toBeGreaterThanOrEqual(0.9);
  });
});
