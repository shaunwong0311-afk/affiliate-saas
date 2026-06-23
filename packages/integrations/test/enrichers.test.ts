import { describe, it, expect } from "vitest";
import { YouTubeEnricher, ScrapeMetricsEnricher, OnPageSubscriberEnricher, EnricherRegistry, CachingEnricher } from "../src/index.js";
import type { FetchResult, HttpFetcher, AccountEnricher } from "../src/index.js";

/** Mock YouTube Data API: channels → uploads playlist → video stats. */
const ytHttp = {
  async get(url: string) {
    if (url.includes("/channels")) {
      return {
        status: 200,
        json: { items: [{ snippet: { country: "US", defaultLanguage: "en" }, statistics: { subscriberCount: "125000" }, contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] },
      };
    }
    if (url.includes("/playlistItems")) {
      return { status: 200, json: { items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }] } };
    }
    if (url.includes("/videos")) {
      return {
        status: 200,
        json: { items: [{ statistics: { viewCount: "1000", likeCount: "80", commentCount: "20" } }, { statistics: { viewCount: "2000", likeCount: "100", commentCount: "100" } }] },
      };
    }
    return { status: 404, json: {} };
  },
};

describe("YouTubeEnricher", () => {
  it("returns real reach + engagement from public stats", async () => {
    const m = await new YouTubeEnricher({ apiKey: "k", http: ytHttp }).enrich({ platform: "youtube", handle: "@creator", url: "https://youtube.com/@creator" });
    // (80+20)/1000 = 0.1 ; (100+100)/2000 = 0.1 ; mean 0.1
    expect(m).toMatchObject({ reach: 125000, engagementRate: 0.1, primaryGeo: "US", language: "en", source: "api" });
  });

  it("resolves by channel id and ignores non-handles", async () => {
    expect(await new YouTubeEnricher({ apiKey: "k", http: ytHttp }).enrich({ platform: "youtube", handle: "UC123", url: "x" })).toMatchObject({ reach: 125000 });
    expect(await new YouTubeEnricher({ apiKey: "k", http: ytHttp }).enrich({ platform: "youtube", handle: null, url: "x" })).toBeNull();
  });
});

describe("ScrapeMetricsEnricher", () => {
  it("returns null when not wired (never invents)", async () => {
    expect(await new ScrapeMetricsEnricher().enrich({ platform: "instagram", handle: "@c", url: "https://instagram.com/c" })).toBeNull();
  });

  it("normalizes a wired actor response", async () => {
    const http = { async get() { return { status: 200, json: { data: { followers: 50000, engagementRate: 0.03, country: "GB" } } }; } };
    const m = await new ScrapeMetricsEnricher({ endpoint: "https://actor", apiKey: "k", http }).enrich({ platform: "tiktok", handle: "@c", url: "https://tiktok.com/@c" });
    expect(m).toMatchObject({ reach: 50000, engagementRate: 0.03, primaryGeo: "GB", source: "scrape" });
  });
});

describe("OnPageSubscriberEnricher", () => {
  it("reads an on-page subscriber count", async () => {
    const fetcher: HttpFetcher = { kind: "mock", async get(url: string): Promise<FetchResult> { return { status: 200, url, html: `<p>12,345 subscribers</p>` }; } };
    const m = await new OnPageSubscriberEnricher(fetcher).enrich({ platform: "substack", handle: "x", url: "https://x.substack.com" });
    expect(m).toMatchObject({ reach: 12345, source: "page" });
  });
});

describe("EnricherRegistry", () => {
  it("routes to the enricher that supports the platform, else null", async () => {
    const reg = new EnricherRegistry([new YouTubeEnricher({ apiKey: "k", http: ytHttp })]);
    expect(reg.supports("youtube")).toBe(true);
    expect(reg.supports("tiktok")).toBe(false);
    expect((await reg.enrich({ platform: "youtube", handle: "@c", url: "x" }))?.reach).toBe(125000);
    expect(await reg.enrich({ platform: "tiktok", handle: "@c", url: "x" })).toBeNull();
  });
});

describe("CachingEnricher", () => {
  it("calls the inner enricher once per account, then serves from cache (saves credits)", async () => {
    let calls = 0;
    const inner: AccountEnricher = {
      kind: "counting",
      supports: () => true,
      async enrich() {
        calls++;
        return { reach: 1000, engagementRate: 0.05, primaryGeo: null, language: null, source: "api" };
      },
    };
    const c = new CachingEnricher(inner);
    await c.enrich({ platform: "youtube", handle: "@a", url: "x" });
    await c.enrich({ platform: "youtube", handle: "@a", url: "x" });
    expect(calls).toBe(1); // second call served from cache
    await c.enrich({ platform: "youtube", handle: "@b", url: "y" });
    expect(calls).toBe(2); // different creator → one more call
  });

  it("caches misses too — a known-null isn't re-fetched", async () => {
    let calls = 0;
    const inner: AccountEnricher = { kind: "null", supports: () => true, async enrich() { calls++; return null; } };
    const c = new CachingEnricher(inner);
    await c.enrich({ platform: "tiktok", handle: "@a", url: "x" });
    await c.enrich({ platform: "tiktok", handle: "@a", url: "x" });
    expect(calls).toBe(1);
  });
});
