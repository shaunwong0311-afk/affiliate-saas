import { describe, it, expect } from "vitest";
import {
  YouTubeEnricher,
  ScrapeMetricsEnricher,
  StubEmailFinder,
  NullEmailFinder,
  HunterFinder,
  PodcastDiscoverySource,
  CompetitorAffiliateSource,
  CreatorDiscoverySource,
  CustomerMiningSource,
} from "../src/index.js";
import type { DiscoveryQuery, HttpFetcher, FetchResult } from "../src/index.js";

/** AUDIT-2026-10 D8 (unknown stays null in the enrichers), D1 (finder flags), D2 (podcast owner), D17 (demo seed). */

describe("D8 — ScrapeMetricsEnricher never turns 'not reported' into 0", () => {
  const enrich = (data: unknown) =>
    new ScrapeMetricsEnricher({ endpoint: "https://actor", http: { async get() { return { status: 200, json: { data } }; } } }).enrich({ platform: "instagram", handle: "@c", url: "x" });

  it("keeps a null / blank / missing follower count as null", async () => {
    // Number(null) and Number("") are both 0 — that used to become "0 followers".
    expect((await enrich({ followers: null, engagementRate: 0.04 }))?.reach).toBeNull();
    expect((await enrich({ followers: "", engagementRate: 0.04 }))?.reach).toBeNull();
    expect((await enrich({ engagementRate: 0.04 }))?.reach).toBeNull();
    expect((await enrich({ followers: 12000, engagementRate: null }))?.engagementRate).toBeNull();
    expect((await enrich({ followers: 12000, engagementRate: "" }))?.engagementRate).toBeNull();
  });

  it("returns null (no data at all) rather than a zero-filled record", async () => {
    expect(await enrich({ followers: null, engagementRate: null })).toBeNull();
    expect(await enrich({})).toBeNull();
    expect(await enrich({ followers: false, engagementRate: [] })).toBeNull();
  });

  it("accepts real numbers and numeric strings, including a genuine zero", async () => {
    expect(await enrich({ followers: "48,200", engagementRate: "0.031" })).toMatchObject({ reach: 48200, engagementRate: 0.031 });
    expect((await enrich({ followers: 0, engagementRate: 0 }))).toMatchObject({ reach: 0, engagementRate: 0 });
  });

  it("treats an engagement rate outside 0..1 as unknown (probably a percentage — not guessed)", async () => {
    const m = await enrich({ followers: 50000, engagementRate: 3.2 });
    expect(m?.reach).toBe(50000);
    expect(m?.engagementRate).toBeNull();
    expect((await enrich({ followers: 50000, engagementRate: -0.1 }))?.engagementRate).toBeNull();
  });
});

describe("D8 — YouTubeEnricher never counts a hidden figure as zero", () => {
  const channel = (statistics: object, videos: object[]) => ({
    async get(url: string) {
      if (url.includes("/channels")) return { status: 200, json: { items: [{ id: "UCabc", snippet: { customUrl: "@creator" }, statistics, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] } };
      if (url.includes("/playlistItems")) return { status: 200, json: { items: videos.map((_, i) => ({ contentDetails: { videoId: `v${i}`, videoPublishedAt: "2026-06-01T00:00:00Z" } })) } };
      return { status: 200, json: { items: videos.map((statistics) => ({ statistics })) } };
    },
  });
  const run = (statistics: object, videos: object[]) => new YouTubeEnricher({ apiKey: "k", http: channel(statistics, videos) }).enrich({ platform: "youtube", handle: "@creator", url: "x" });

  it("leaves reach unknown when the subscriber count is hidden", async () => {
    expect((await run({ hiddenSubscriberCount: true, subscriberCount: "0" }, []))?.reach).toBeNull();
    expect((await run({}, []))?.reach).toBeNull();
    expect((await run({ subscriberCount: "125000" }, []))?.reach).toBe(125000);
  });

  it("leaves a video out of the engagement average when its like count is hidden", async () => {
    // One video reports likes (10% engagement), one hides them. Counting the hidden one as
    // 0 likes would have halved the rate.
    const m = await run({ subscriberCount: "1000" }, [{ viewCount: "1000", likeCount: "90", commentCount: "10" }, { viewCount: "1000", commentCount: "5" }]);
    expect(m?.engagementRate).toBeCloseTo(0.1, 10);
  });

  it("leaves engagement unknown when NO video reports likes, and counts disabled comments as none", async () => {
    expect((await run({ subscriberCount: "1000" }, [{ viewCount: "1000" }, { viewCount: "500", commentCount: "3" }]))?.engagementRate).toBeNull();
    expect((await run({ subscriberCount: "1000" }, [{ viewCount: "1000", likeCount: "50" }]))?.engagementRate).toBeCloseTo(0.05, 10);
  });

  it("reports the channel's other spelling (id ↔ handle) so a back-link in either form is recognized", async () => {
    const m = await run({ subscriberCount: "1000" }, []);
    expect(m?.aliases).toEqual(["https://www.youtube.com/channel/UCabc", "https://www.youtube.com/@creator"]);
  });
});

describe("D1 — which finders invent addresses", () => {
  it("the stub declares that it guesses; real finders do not", () => {
    expect(new StubEmailFinder().guesses).toBe(true);
    expect((new HunterFinder({ apiKey: "k" }) as { guesses?: boolean }).guesses).toBeUndefined();
    expect((new NullEmailFinder() as { guesses?: boolean }).guesses).toBeUndefined();
  });

  it("the 'no finder configured' finder finds nothing and confirms nothing", async () => {
    const none = new NullEmailFinder();
    expect(await none.find()).toEqual([]);
    expect((await none.verify()).deliverable).toBe(false);
  });

  it("the stub falls back to a reserved domain when it is not given one", async () => {
    const guesses = await new StubEmailFinder().find({ fullName: "Skincare Channel" });
    expect(guesses.every((g) => g.email.endsWith("@example.com") && g.verified === false)).toBe(true);
  });
});

describe("D2 — the podcast feed's declared owner address is carried, and comes first", () => {
  const feed = (body: string) => `<?xml version="1.0"?><rss><channel><title>The Skin Hour</title><link>https://skinhour.fm</link>${body}</channel></rss>`;
  const query: DiscoveryQuery = { merchantId: "m1", niche: "skincare", competitors: [], keywords: [], channels: ["podcast"], limit: 5 };
  const discover = async (xml: string) => {
    const http = { async get() { return { status: 200, json: { results: [{ collectionName: "The Skin Hour", feedUrl: "https://feeds.test/skin.xml", collectionViewUrl: "https://podcasts.apple.com/us/podcast/x/id1" }] } }; } };
    const fetcher: HttpFetcher = { kind: "mock", async get(url: string): Promise<FetchResult> { return { status: 200, url, html: xml }; } };
    return (await new PodcastDiscoverySource({ http, fetcher, maxQueries: 1 }).discover(query))[0]!;
  };

  it("emits the owner email as a source-vouched contact (it used to be parsed and thrown away)", async () => {
    const cand = await discover(feed(`<itunes:owner><itunes:name>Jane</itunes:name><itunes:email>Jane@SkinHour.fm</itunes:email></itunes:owner>`));
    expect(cand.contactEmails).toEqual([{ email: "jane@skinhour.fm", source: "feed_owner" }]);
    expect(cand.siteUrl).toBe("https://skinhour.fm");
  });

  it("does not pass episode notes on as the show's own page (guests' and sponsors' links and addresses)", async () => {
    const xml = feed(
      `<itunes:owner><itunes:email>host@skinhour.fm</itunes:email></itunes:owner>` +
        `<item><title>Ep 1</title><description>Our guest: guest@otherbrand.com — find her at https://linktr.ee/theguest. Sponsor: support@glowrival.com</description></item>`,
    );
    const cand = await discover(xml);
    expect(cand.pageHtml).toContain("host@skinhour.fm");
    expect(cand.pageHtml).not.toContain("guest@otherbrand.com");
    expect(cand.pageHtml).not.toContain("linktr.ee/theguest");
    expect(cand.pageHtml).not.toContain("glowrival.com");
  });

  it("still finds the owner when the feed writes it after its episodes — but never takes an episode's link as the show's site", async () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Late Owner</title>` + `<item><title>Ep 1</title><link>https://sponsor-landing.com/ep1</link></item>` + `<itunes:owner><itunes:email>host@lateowner.fm</itunes:email></itunes:owner></channel></rss>`;
    const cand = await discover(xml);
    expect(cand.contactEmails).toEqual([{ email: "host@lateowner.fm", source: "feed_owner" }]);
    expect(cand.siteUrl).toBeNull(); // no channel-level <link> → fall back to the Apple page, not the episode's URL
    expect(cand.channelUrl).toBe("https://podcasts.apple.com/us/podcast/x/id1");
  });

  it("has no vouched contact when the feed declares no owner", async () => {
    const cand = await discover(feed(""));
    expect(cand.contactEmails).toBeUndefined();
  });
});

describe("D17 — the demo generators are seeded on what the merchant IS, not on its (random) id", () => {
  const q = (merchantId: string, over: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({
    merchantId,
    niche: "skincare",
    competitors: ["glowrival.com", "dewdrop.com"],
    keywords: [],
    channels: ["serp"],
    limit: 8,
    ...over,
  });

  it("two tenants with the same niche + competitors get identical demo candidates", async () => {
    for (const source of [new CompetitorAffiliateSource(), new CreatorDiscoverySource(), new CustomerMiningSource()]) {
      const a = await source.discover(q("mer_01HXAAAA"));
      const b = await source.discover(q("mer_01HXZZZZ"));
      expect(b).toEqual(a); // reachHint, affiliate flags, summaries — everything
      expect(a.every((c) => c.synthetic)).toBe(true);
    }
  });

  it("still varies with the merchant's actual ICP", async () => {
    const source = new CompetitorAffiliateSource();
    const reach = async (query: DiscoveryQuery) => (await source.discover(query)).map((c) => c.reachHint);
    expect(await reach(q("m", { niche: "trail running" }))).not.toEqual(await reach(q("m")));
    expect(await reach(q("m", { competitors: ["other.com"] }))).not.toEqual(await reach(q("m")));
    // …but not with the ORDER or casing the competitors were typed in.
    expect(await reach(q("m", { competitors: ["DewDrop.com", "glowrival.com"] }))).toEqual(await reach(q("m")));
  });
});
