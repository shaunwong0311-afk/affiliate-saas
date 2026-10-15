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
    // A bio page's identity includes its HOST: linktr.ee/x and beacons.ai/x are different people.
    expect(classifyAccountUrl("https://linktr.ee/trailrunner")).toMatchObject({ platform: "linktree", handle: "linktr.ee/trailrunner" });
    expect(classifyAccountUrl("https://beacons.ai/trailrunner")).toMatchObject({ platform: "linktree", handle: "beacons.ai/trailrunner" });
  });

  it("parses handles PLATFORM-AWARE: a feature path is not a creator (AUDIT-2026-10 D6)", () => {
    // Instagram: /p/<post>, /reel/<id>, /explore/… are posts and features — `@p` is nobody.
    expect(classifyAccountUrl("https://www.instagram.com/p/Cabc123/")).toBeNull();
    expect(classifyAccountUrl("https://instagram.com/reel/Cxyz/")).toBeNull();
    expect(classifyAccountUrl("https://instagram.com/explore/tags/skincare/")).toBeNull();
    expect(classifyAccountUrl("https://instagram.com/")).toBeNull();
    expect(classifyAccountUrl("https://instagram.com/jane.skin/")).toMatchObject({ platform: "instagram", handle: "@jane.skin", url: "https://instagram.com/jane.skin" });
    // TikTok: only an @handle is a creator; a video URL still names its owner.
    expect(classifyAccountUrl("https://www.tiktok.com/tag/skincare")).toBeNull();
    expect(classifyAccountUrl("https://www.tiktok.com/discover/serum")).toBeNull();
    expect(classifyAccountUrl("https://www.tiktok.com/@jane/video/123")).toMatchObject({ platform: "tiktok", handle: "@jane", url: "https://tiktok.com/@jane" });
    // Substack: the site's own pages are not a publication; a profile and a publication never share a key.
    expect(classifyAccountUrl("https://substack.com/home")).toBeNull();
    expect(classifyAccountUrl("https://substack.com/@jane")).toMatchObject({ platform: "substack", handle: "@jane" });
    expect(classifyAccountUrl("https://open.substack.com/pub/janeletter/p/a-post")).toMatchObject({ platform: "substack", handle: "janeletter" });
    expect(classifyAccountUrl("https://support.substack.com/hc")).toBeNull();
    // Bio hosts: the bare host and its utility pages are nobody's page.
    expect(classifyAccountUrl("https://linktr.ee/")).toBeNull();
    expect(classifyAccountUrl("https://linktr.ee/login")).toBeNull();
    expect(classifyAccountUrl("https://jane.carrd.co/")).toMatchObject({ platform: "linktree", handle: "jane.carrd.co" });
    // Podcasts key on the show id, not on however the URL happens to be written.
    expect(classifyAccountUrl("https://podcasts.apple.com/gb/podcast/another-slug/id123")).toMatchObject({ handle: "apple:id123" });
    expect(classifyAccountUrl("https://podcasts.apple.com/us/genre/podcasts-arts/id1301")).toBeNull(); // a genre page, not a show
    expect(classifyAccountUrl("https://anchor.fm/")).toBeNull();
  });

  it("canonicalizes the account URL to the profile root", () => {
    expect(classifyAccountUrl("https://www.youtube.com/@creator/about")?.url).toBe("https://youtube.com/@creator");
    expect(classifyAccountUrl("https://m.youtube.com/channel/UC123/videos")?.url).toBe("https://youtube.com/channel/UC123");
  });

  it("returns null for unknown hosts (never treats every link as 'their blog')", () => {
    expect(classifyAccountUrl("https://some-random-blog.com/post/123")).toBeNull();
    expect(classifyAccountUrl("mailto:x@y.com")).toBeNull();
    expect(classifyAccountUrl("not a url")).toBeNull();
  });

  it("returns null for YouTube video/utility URLs that carry no channel identity", () => {
    // These would otherwise collapse (query-stripped) into one shared handle-less merge key.
    expect(classifyAccountUrl("https://youtube.com/watch?v=abc123")).toBeNull();
    expect(classifyAccountUrl("https://www.youtube.com/watch?v=xyz")).toBeNull();
    expect(classifyAccountUrl("https://youtube.com/shorts/abc")).toBeNull();
    expect(classifyAccountUrl("https://youtube.com/playlist?list=PL1")).toBeNull();
    expect(classifyAccountUrl("https://youtube.com/results?search_query=trail")).toBeNull();
    expect(classifyAccountUrl("https://youtu.be/dQw4w9WgXcQ")).toBeNull(); // a video share, not a channel
    // A real channel handle/id still resolves.
    expect(classifyAccountUrl("https://youtube.com/@trailgeek")).toMatchObject({ platform: "youtube", handle: "@trailgeek" });
  });

  it("does not attribute a tweet or share widget as an owned Twitter account", () => {
    expect(classifyAccountUrl("https://x.com/someone/status/123456")).toBeNull(); // an embedded/quoted tweet
    expect(classifyAccountUrl("https://twitter.com/intent/tweet?text=hi")).toBeNull(); // share widget
    expect(classifyAccountUrl("https://x.com/share")).toBeNull();
    // A plain profile URL is still an account.
    expect(classifyAccountUrl("https://x.com/trailgeek")).toMatchObject({ platform: "twitter", handle: "@trailgeek" });
  });

  it("seedAccount falls back to a website account for a bare domain", () => {
    expect(seedAccount("https://trailrunner.com/about")).toMatchObject({ platform: "website", url: "https://trailrunner.com" });
    expect(seedAccount("https://youtube.com/@x")).toMatchObject({ platform: "youtube" });
  });

  it("seedAccount never turns a PLATFORM host into a 'website' (AUDIT-2026-10 D6)", () => {
    // A handle-less platform URL names no creator. Promoting the host to a website account
    // gave every such prospect the same identity ("youtube.com") and merged them all.
    expect(seedAccount("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(seedAccount("https://youtu.be/abc123")).toBeNull();
    expect(seedAccount("https://www.instagram.com/p/Cabc123/")).toBeNull();
    expect(seedAccount("https://medium.com/@alice/a-post")).toBeNull();
    expect(seedAccount("https://www.reddit.com/r/SkincareAddiction/comments/1/x")).toBeNull();
    expect(seedAccount("https://www.amazon.com/shop/creator")).toBeNull();
    // A hosted TENANT subdomain is one creator's own site and still is a website.
    expect(seedAccount("https://alice.wordpress.com/2024/post")).toMatchObject({ platform: "website", url: "https://alice.wordpress.com" });
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

  it("detects reciprocity: the seed links the account AND the account's own page links back", () => {
    const p = buildProfile("https://trailrunner.com", [
      { url: "https://trailrunner.com", links: ["https://youtube.com/@trailrunner"] }, // seed → account
      { url: "https://youtube.com/@trailrunner", links: ["https://trailrunner.com/about"] }, // account → seed
    ]);
    const yt = p.accounts.find((a) => a.platform === "youtube")!;
    expect(yt.provenance).toBe("reciprocal_link");
    expect(yt.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("a THIRD-PARTY page that mentions both the seed and an account proves nothing", () => {
    // A press article links the creator's site and somebody's YouTube channel. That used to
    // make the channel "reciprocal" (0.95, a hard merge key) — but the article is not the
    // creator's page and may be about two different people.
    const p = buildProfile("https://trailrunner.com", [
      { url: "https://press.example/feature", links: ["https://youtube.com/@someoneelse", "https://trailrunner.com/about"] },
    ]);
    const yt = p.accounts.find((a) => a.platform === "youtube")!;
    expect(yt.provenance).toBe("page_link");
    expect(p.accounts.some((a) => a.url.includes("press.example"))).toBe(false); // nor is the article theirs
  });

  it("for a PLATFORM seed, 'links back' means the same ACCOUNT — not just the same platform", () => {
    // Seed: one YouTube channel. A brand's site links its OWN YouTube channel and its
    // Instagram. Any link to youtube.com used to count as "back to the seed", making the
    // brand's Instagram a reciprocal (owned) account of the creator.
    const p = buildProfile("https://youtube.com/@creator", [
      { url: "https://youtube.com/@creator", links: ["https://brandsite.com"] },
      { url: "https://brandsite.com", links: ["https://youtube.com/@brandchannel", "https://instagram.com/brand"] },
    ]);
    expect(p.accounts.some((a) => a.platform === "website" && a.url.includes("brandsite.com"))).toBe(false);
    expect(p.accounts.find((a) => a.platform === "instagram")?.provenance).toBe("page_link");
    // …whereas a site that links back to THE seed channel is the creator's own site.
    const q = buildProfile("https://youtube.com/@creator", [
      { url: "https://youtube.com/@creator", links: ["https://creatorsite.com"] },
      { url: "https://creatorsite.com", links: ["https://www.youtube.com/@creator"] },
    ]);
    expect(q.accounts.find((a) => a.platform === "website")).toMatchObject({ url: "https://creatorsite.com", provenance: "reciprocal_link" });
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
