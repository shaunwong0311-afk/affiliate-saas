import { describe, it, expect } from "vitest";
import { buildDiscoveryQueries, SerpDiscoverySource, BacklinkDiscoverySource } from "../src/index.js";
import type { DiscoveryQuery, HttpFetcher, FetchResult, SerpProvider, SerpHit, BacklinkProvider, BacklinkRow } from "../src/index.js";

/**
 * AUDIT-2026-10 D12 — the query plan is longer than the per-run cap, and the same head
 * of it used to run every time: the reserved platform slots all went to YouTube and
 * newsletters (podcast, Reddit, Instagram and TikTok queries NEVER ran), and with three
 * competitors a single buyer-intent query survived.
 * Also D5 at the source: a competitor's own site / a retailer is not a SERP prospect.
 */

// Exactly what pipeline.discover() builds.
const icp = (competitors: string[], over: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({
  merchantId: "m1",
  niche: "skincare",
  competitors,
  keywords: ["best skincare", "skincare review"],
  channels: ["serp", "youtube", "blog", "newsletter", "podcast", "community", "social"],
  limit: 20,
  ...over,
});
const PLATFORM = new Set(["youtube", "newsletter", "podcast", "community", "social"]);
const isCompetitorQuery = (q: string, competitors: string[]) => competitors.some((c) => q.startsWith(`${c} `));

describe("buildDiscoveryQueries — every planned query gets its turn", () => {
  const competitors = ["a.com", "b.com", "c.com"];

  it("the first window already spans channels: podcast and Reddit run, not just YouTube + newsletters", () => {
    const platform = buildDiscoveryQueries(icp(competitors)).filter((p) => PLATFORM.has(p.channel));
    expect(platform.map((p) => p.channel)).toEqual(["youtube", "newsletter", "podcast", "community"]);
  });

  it("over successive runs EVERY platform query runs — Instagram and TikTok included", () => {
    const ran = new Set<string>();
    for (let run = 0; run < 3; run++) {
      for (const p of buildDiscoveryQueries(icp(competitors), { rotation: run })) if (PLATFORM.has(p.channel)) ran.add(p.q);
    }
    expect([...ran].sort()).toEqual(
      [
        "site:youtube.com skincare review",
        "skincare review youtube",
        "site:substack.com skincare",
        "best skincare newsletter",
        "skincare podcast",
        "site:reddit.com skincare recommendations",
        "site:instagram.com skincare",
        "site:tiktok.com skincare review",
      ].sort(),
    );
  });

  it("every platform query is FIRST in its window on some run (so a small result budget still reaches it)", () => {
    const firsts = new Set<string>();
    for (let run = 0; run < 8; run++) firsts.add(buildDiscoveryQueries(icp(competitors), { rotation: run }).find((p) => PLATFORM.has(p.channel))!.q);
    expect(firsts.size).toBe(8);
  });

  it("a long competitor list no longer squeezes buyer-intent down to one query", () => {
    for (const comps of [competitors, ["a.com", "b.com", "c.com", "d.com", "e.com"]]) {
      const plan = buildDiscoveryQueries(icp(comps));
      const primary = plan.filter((p) => !PLATFORM.has(p.channel));
      const intent = primary.filter((p) => !isCompetitorQuery(p.q, comps));
      expect(plan).toHaveLength(14);
      expect(intent.length).toBeGreaterThanOrEqual(4);
      expect(primary.length - intent.length).toBeGreaterThanOrEqual(5); // competitor mining still gets the larger share
    }
  });

  it("every competitor gets a query before any competitor gets a second", () => {
    const comps = ["a.com", "b.com", "c.com", "d.com", "e.com"];
    const first = buildDiscoveryQueries(icp(comps)).filter((p) => isCompetitorQuery(p.q, comps)).slice(0, 5).map((p) => p.q);
    expect(first).toEqual(comps.map((c) => `${c} review`));
  });

  it("competitor and buyer-intent queries are interleaved, competitors leading", () => {
    const plan = buildDiscoveryQueries(icp(competitors));
    expect(isCompetitorQuery(plan[0]!.q, competitors)).toBe(true);
    // Any prefix of the primary list long enough to matter contains both kinds.
    const head = plan.slice(0, 4);
    expect(head.some((p) => isCompetitorQuery(p.q, competitors))).toBe(true);
    expect(head.some((p) => !isCompetitorQuery(p.q, competitors))).toBe(true);
  });

  it("over successive runs every competitor and buyer-intent query runs too", () => {
    const all = new Set(buildDiscoveryQueries(icp(competitors), { max: 1000 }).map((p) => p.q));
    const ran = new Set<string>();
    for (let run = 0; run < 12; run++) for (const p of buildDiscoveryQueries(icp(competitors), { rotation: run })) ran.add(p.q);
    expect([...all].filter((q) => !ran.has(q))).toEqual([]);
  });

  it("does not turn a keyword that already says 'review' into 'review review'", () => {
    const qs = buildDiscoveryQueries(icp([], { keywords: ["skincare review", "retinol reviews", "vitamin c serum"] }), { max: 1000 }).map((p) => p.q);
    expect(qs.some((q) => /review\s+reviews?$|reviews\s+review$/.test(q))).toBe(false);
    expect(qs).toContain("retinol reviews");
    expect(qs).toContain("vitamin c serum review");
  });

  it("is deterministic for a given rotation and never exceeds the cap or repeats a query", () => {
    for (let run = 0; run < 10; run++) {
      const a = buildDiscoveryQueries(icp(competitors), { rotation: run });
      expect(buildDiscoveryQueries(icp(competitors), { rotation: run })).toEqual(a);
      expect(a.length).toBeLessThanOrEqual(14);
      expect(new Set(a.map((p) => p.q)).size).toBe(a.length);
    }
  });
});

/** Records which queries were actually sent, and answers each with one distinct site. */
class RecordingSerp implements SerpProvider {
  readonly kind = "recording";
  readonly queries: string[] = [];
  async search(query: string): Promise<SerpHit[]> {
    this.queries.push(query);
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return [{ title: query, url: `https://${slug}.example/p`, snippet: query }];
  }
}
const blank: HttpFetcher = { kind: "mock", async get(url: string): Promise<FetchResult> { return { status: 200, url, html: "<html></html>" }; } };

describe("SerpDiscoverySource — the window slides from run to run", () => {
  it("podcast, Reddit, Instagram and TikTok queries are actually SENT within a few runs", async () => {
    const serp = new RecordingSerp();
    const source = new SerpDiscoverySource(serp, blank);
    for (let run = 0; run < 3; run++) await source.discover(icp(["glowrival.com", "dewdrop.com"]));
    for (const q of ["skincare podcast", "site:reddit.com skincare recommendations", "site:instagram.com skincare", "site:tiktok.com skincare review"]) {
      expect(serp.queries, q).toContain(q);
    }
  });

  it("keeps a separate position per merchant, and honours an explicit rotation", async () => {
    const serp = new RecordingSerp();
    const source = new SerpDiscoverySource(serp, blank);
    await source.discover(icp(["a.com"], { merchantId: "m1" }));
    const afterFirst = serp.queries.length;
    await source.discover(icp(["a.com"], { merchantId: "m2" })); // m2's FIRST run → the same window as m1's first
    expect(serp.queries.slice(afterFirst)).toEqual(serp.queries.slice(0, afterFirst));

    const pinnedA = new RecordingSerp();
    const pinnedB = new RecordingSerp();
    await new SerpDiscoverySource(pinnedA, blank).discover(icp(["a.com"], { rotation: 5 }));
    const again = new SerpDiscoverySource(pinnedB, blank);
    await again.discover(icp(["a.com"], { rotation: 5 }));
    await again.discover(icp(["a.com"], { rotation: 5 }));
    expect(pinnedB.queries).toEqual([...pinnedA.queries, ...pinnedA.queries]);
  });
});

describe("D5 at the source — not prospects, so not fetched and not returned", () => {
  class FixedSerp implements SerpProvider {
    readonly kind = "fixed";
    constructor(private readonly hits: SerpHit[]) {}
    async search(): Promise<SerpHit[]> {
      return this.hits;
    }
  }

  it("SERP: drops the competitor's own site, its subdomains, retailers, search engines and shorteners", async () => {
    const fetched: string[] = [];
    const fetcher: HttpFetcher = { kind: "mock", async get(url: string): Promise<FetchResult> { fetched.push(url); return { status: 200, url, html: "<html></html>" }; } };
    const hits: SerpHit[] = [
      { title: "GlowRival — official site", url: "https://www.glowrival.com/", snippet: "" }, // ranks #1 for "glowrival.com review"
      { title: "GlowRival blog", url: "https://blog.glowrival.com/our-story", snippet: "" },
      { title: "GlowRival on Amazon", url: "https://www.amazon.co.uk/dp/B0ABC", snippet: "" },
      { title: "glowrival - Google Search", url: "https://www.google.com/search?q=glowrival", snippet: "" },
      { title: "short", url: "https://bit.ly/3abc", snippet: "" },
      { title: "An honest GlowRival review", url: "https://skinblog.com/glowrival-review", snippet: "" },
    ];
    const out = await new SerpDiscoverySource(new FixedSerp(hits), fetcher, { maxQueries: 1 }).discover(icp(["glowrival.com"]));
    expect(out.map((c) => c.siteUrl)).toEqual(["https://skinblog.com"]);
    expect(fetched).toEqual(["https://skinblog.com/glowrival-review"]);
  });

  it("backlinks: a referring page on the competitor's own domain or a retailer is not an affiliate", async () => {
    const rows: BacklinkRow[] = [
      { urlFrom: "https://blog.glowrival.com/partners", urlTo: "https://glowrival.com/?ref=blog", anchor: null },
      { urlFrom: "https://www.amazon.com/shop/x", urlTo: "https://glowrival.com/?ref=amz", anchor: null },
      { urlFrom: "https://skinblog.com/best", urlTo: "https://glowrival.com/?ref=skinblog", anchor: null },
    ];
    const provider: BacklinkProvider = { kind: "fake", async referringLinks() { return rows; } };
    const out = await new BacklinkDiscoverySource(provider).discover(icp(["glowrival.com"]));
    expect(out.map((c) => c.identity)).toEqual(["skinblog.com"]);
  });

  it("backlinks: a referring page on a social platform is ONE creator's page, not the platform", async () => {
    const rows: BacklinkRow[] = [
      { urlFrom: "https://www.youtube.com/watch?v=aaa111", urlTo: "https://glowrival.com/?ref=yt1", anchor: null },
      { urlFrom: "https://www.youtube.com/watch?v=bbb222", urlTo: "https://glowrival.com/?ref=yt2", anchor: null },
      { urlFrom: "https://www.instagram.com/janeskin/", urlTo: "https://glowrival.com/?ref=ig", anchor: null },
    ];
    const provider: BacklinkProvider = { kind: "fake", async referringLinks() { return rows; } };
    const out = await new BacklinkDiscoverySource(provider).discover(icp(["glowrival.com"]));
    // Previously all three collapsed to "youtube.com" / "instagram.com" with siteUrl https://youtube.com.
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.siteUrl === null)).toBe(true);
    expect(out.map((c) => c.channelUrl)).toEqual(["https://www.youtube.com/watch?v=aaa111", "https://www.youtube.com/watch?v=bbb222", "https://www.instagram.com/janeskin"]);
  });
});
