import { describe, it, expect } from "vitest";
import { PodcastDiscoverySource, parsePodcastFeed } from "../src/index.js";
import type { DiscoveryQuery, HttpFetcher, FetchResult } from "../src/index.js";

const baseQuery: DiscoveryQuery = {
  merchantId: "m1",
  niche: "home espresso",
  competitors: [],
  keywords: [],
  channels: ["podcast"],
  limit: 10,
};

const RSS = `<?xml version="1.0"?><rss><channel>
  <title>The Espresso Hour</title>
  <link>https://espressohour.com</link>
  <itunes:owner><itunes:email>host@espressohour.com</itunes:email></itunes:owner>
</channel></rss>`;

describe("parsePodcastFeed", () => {
  it("extracts the owner email and show website from an RSS feed", () => {
    expect(parsePodcastFeed(RSS)).toEqual({ email: "host@espressohour.com", website: "https://espressohour.com" });
  });
  it("returns nulls when the feed has neither", () => {
    expect(parsePodcastFeed("<rss><channel><title>x</title></channel></rss>")).toEqual({ email: null, website: null });
  });
});

describe("PodcastDiscoverySource", () => {
  const itunes = (results: any[]) => ({
    async get(_url: string) {
      return { status: 200, json: { results } };
    },
  });

  it("emits niche podcasts and, via the RSS feed, makes them contactable (site + email)", async () => {
    const http = itunes([
      { collectionName: "The Espresso Hour", artistName: "Jane", feedUrl: "https://feeds.test/espresso.xml", collectionViewUrl: "https://podcasts.apple.com/x", primaryGenreName: "Food" },
    ]);
    const feedFetcher: HttpFetcher = {
      kind: "mock",
      async get(url: string): Promise<FetchResult> {
        return { status: 200, url, html: RSS };
      },
    };
    const cands = await new PodcastDiscoverySource({ http, fetcher: feedFetcher, maxQueries: 1 }).discover(baseQuery);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.siteUrl).toBe("https://espressohour.com"); // website pulled from the feed
    expect(cands[0]!.pageHtml).toContain("host@espressohour.com"); // owner email extracts downstream
    expect(cands[0]!.synthetic).toBe(false);
  });

  it("falls back to the Apple URL when no fetcher is wired (still a candidate)", async () => {
    const http = itunes([{ collectionName: "Brew Talk", feedUrl: "https://feeds.test/brew.xml", collectionViewUrl: "https://podcasts.apple.com/y" }]);
    const cands = await new PodcastDiscoverySource({ http, maxQueries: 1 }).discover(baseQuery);
    expect(cands[0]!.channelUrl).toBe("https://podcasts.apple.com/y");
    expect(cands[0]!.siteUrl).toBeNull();
  });

  it("dedupes the same show across queries", async () => {
    const http = itunes([{ collectionName: "Brew Talk", feedUrl: "https://feeds.test/brew.xml" }]);
    const cands = await new PodcastDiscoverySource({ http, maxQueries: 2 }).discover(baseQuery);
    expect(cands).toHaveLength(1); // same feedUrl seen twice → one candidate
  });
});
