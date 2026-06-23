import { describe, it, expect } from "vitest";
import { buildDiscoveryQueries, SerpDiscoverySource } from "../src/index.js";
import type { DiscoveryQuery, SerpProvider, SerpHit, HttpFetcher, FetchResult } from "../src/index.js";

const baseQuery: DiscoveryQuery = {
  merchantId: "m1",
  niche: "trail running shoes",
  competitors: ["rival.com"],
  keywords: ["gore-tex boots"],
  channels: ["serp", "blog", "youtube", "newsletter", "podcast", "community"],
  limit: 20,
};

describe("buildDiscoveryQueries", () => {
  it("prioritizes competitor-affiliate mining first, then buyer-intent", () => {
    const plans = buildDiscoveryQueries(baseQuery);
    expect(plans[0]!.q).toContain("rival.com");
    const qs = plans.map((p) => p.q);
    expect(qs).toContain("rival.com review");
    expect(qs).toContain("best trail running shoes");
  });

  it("emits platform-targeted queries for the requested channels", () => {
    const qs = buildDiscoveryQueries(baseQuery).map((p) => p.q);
    expect(qs.some((s) => s.startsWith("site:youtube.com"))).toBe(true);
    expect(qs.some((s) => s.includes("substack.com"))).toBe(true);
  });

  it("gates platform queries by channel and dedupes + caps", () => {
    const blogOnly = buildDiscoveryQueries({ ...baseQuery, channels: ["blog"] });
    expect(blogOnly.some((p) => p.channel === "youtube")).toBe(false);

    const plans = buildDiscoveryQueries(baseQuery, { max: 8 });
    expect(plans.length).toBeLessThanOrEqual(8);
    const qs = plans.map((p) => p.q);
    expect(new Set(qs).size).toBe(qs.length); // no duplicate queries
  });
});

class FakeSerp implements SerpProvider {
  readonly kind = "fake-serp";
  constructor(private readonly hits: SerpHit[]) {}
  async search(): Promise<SerpHit[]> {
    return this.hits;
  }
}
const shortFetcher: HttpFetcher = { kind: "mock", async get(url: string): Promise<FetchResult> { return { status: 200, url, html: "<html></html>" }; } };

describe("SerpDiscoverySource — platform-aware dedup", () => {
  const hits: SerpHit[] = [
    { title: "Creator A", url: "https://youtube.com/@creatorA", snippet: "" },
    { title: "Creator B", url: "https://youtube.com/@creatorB", snippet: "" },
    { title: "Blog X", url: "https://blogx.com/best-shoes", snippet: "" },
  ];

  it("keeps distinct creators on the same platform host (no host collapse)", async () => {
    const src = new SerpDiscoverySource(new FakeSerp(hits), shortFetcher, { maxQueries: 4 });
    const cands = await src.discover(baseQuery);
    const yt = cands.filter((c) => c.channelUrl?.includes("youtube.com"));
    expect(yt.length).toBe(2); // @creatorA and @creatorB both survive
    expect(yt.every((c) => c.siteUrl === null)).toBe(true); // social hits → channelUrl
  });

  it("treats ordinary sites as site URLs and dedupes by host", async () => {
    const src = new SerpDiscoverySource(new FakeSerp(hits), shortFetcher, { maxQueries: 4 });
    const cands = await src.discover(baseQuery);
    const blog = cands.find((c) => c.siteUrl?.includes("blogx.com"));
    expect(blog).toBeTruthy();
    expect(blog!.channelUrl).toBeNull();
    expect(cands.filter((c) => c.siteUrl?.includes("blogx.com")).length).toBe(1); // one per host
  });
});
