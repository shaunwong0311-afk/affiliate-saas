import { describe, it, expect } from "vitest";
import { buildDiscoveryQueries, SerpDiscoverySource, BacklinkDiscoverySource, CompetitorProgramResolver, DataForSEOBacklinkProvider, DataForSEOSerpProvider, YouTubeDiscoverySource } from "../src/index.js";
import type { DiscoveryQuery, SerpProvider, SerpHit, HttpFetcher, FetchResult, BacklinkProvider, BacklinkRow } from "../src/index.js";

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

// Returns one DISTINCT hit per query (host derived from the query text), so we can
// see which queries actually ran by inspecting the resulting candidates.
class PerQuerySerp implements SerpProvider {
  readonly kind = "per-query";
  async search(query: string): Promise<SerpHit[]> {
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return [{ title: query, url: `https://${slug || "x"}.example/p`, snippet: query }];
  }
}

describe("SerpDiscoverySource — platform-query budget (#10)", () => {
  it("reserves budget so platform-targeted creator queries aren't starved by primary queries", async () => {
    // Small limit + many competitors → primary (competitor/buyer-intent) queries would
    // otherwise eat the whole budget before the youtube/newsletter/podcast queries run.
    const q: DiscoveryQuery = { ...baseQuery, competitors: ["a.com", "b.com", "c.com"], limit: 6 };
    const cands = await new SerpDiscoverySource(new PerQuerySerp(), shortFetcher, { maxQueries: 14 }).discover(q);
    const platform = cands.filter((c) => /\[(youtube|newsletter|podcast|community|social)\]/.test(c.evidenceSummary ?? ""));
    expect(platform.length).toBeGreaterThan(0); // platform channels got reserved room
    expect(cands.length).toBeLessThanOrEqual(6); // still respects the cap
  });
});

class FakeBacklinks implements BacklinkProvider {
  readonly kind = "fake-backlink";
  constructor(private readonly rows: BacklinkRow[]) {}
  async referringLinks(): Promise<BacklinkRow[]> {
    return this.rows;
  }
}

describe("BacklinkDiscoverySource — competitor-affiliate mining", () => {
  const q: DiscoveryQuery = { ...baseQuery, competitors: ["rival.com"], limit: 10 };

  it("keeps only referring pages whose link to the competitor is an AFFILIATE link", async () => {
    const rows: BacklinkRow[] = [
      { urlFrom: "https://affiliateblog.com/review", urlTo: "https://rival.com/product?ref=joe", anchor: "buy rival" }, // affiliate → keep
      { urlFrom: "https://newssite.com/article", urlTo: "https://rival.com/about", anchor: "rival" }, // plain mention → drop
      { urlFrom: "https://affiliateblog.com/other", urlTo: "https://rival.com/x?ref=joe", anchor: "" }, // same referring domain → dedup
    ];
    const cands = await new BacklinkDiscoverySource(new FakeBacklinks(rows)).discover(q);
    expect(cands.length).toBe(1);
    expect(cands[0]!.identity).toBe("affiliateblog.com");
    expect(cands[0]!.outboundLinks[0]).toContain("ref=joe");
    expect(cands[0]!.evidenceSummary).toMatch(/proven affiliate/);
  });

  it("returns nothing when no provider is wired (honest empty, never fabricated)", async () => {
    expect(await new BacklinkDiscoverySource().discover(q)).toEqual([]);
  });
});

describe("DataForSEOBacklinkProvider — cost-efficient request shape", () => {
  it("requests one_per_domain (not as_is), caps to 1000 rows, and passes the merchant filter", async () => {
    let sentBody: any = null;
    const http = {
      async post(_url: string, body: unknown) {
        sentBody = body;
        return { status: 200, json: { tasks: [{ result: [{ items: [{ url_from: "https://aff.com", url_to: "https://shareasale.com/r.cfm?m=222" }] }] }] } };
      },
    };
    const provider = new DataForSEOBacklinkProvider({ login: "x", password: "y", http });
    const rows = await provider.referringLinks("shareasale.com", 5000, { urlToContains: "m=222" });
    expect(sentBody[0].mode).toBe("one_per_domain"); // one row per referring domain = one affiliate
    expect(sentBody[0].limit).toBe(1000); // capped at the endpoint max
    expect(sentBody[0].filters).toEqual([["url_to", "like", "%m=222%"]]);
    expect(rows[0]!.urlFrom).toBe("https://aff.com");
  });

  it("apex query filters to affiliate-marker links (OR), so one_per_domain picks an affiliate link", async () => {
    let sentBody: any = null;
    const http = {
      async post(_url: string, body: unknown) {
        sentBody = body;
        return { status: 200, json: { tasks: [{ result: [{ items: [] }] }] } };
      },
    };
    await new DataForSEOBacklinkProvider({ login: "x", password: "y", http }).referringLinks("competitor.com", 100, { urlToContainsAny: ["ref=", "/go/"] });
    expect(sentBody[0].filters).toEqual([["url_to", "like", "%ref=%"], "or", ["url_to", "like", "%/go/%"]]);
  });

  it("requests ranks on a 0..100 scale and reads domain_from_rank as the domain authority", async () => {
    let sentBody: any = null;
    const http = {
      async post(_url: string, body: unknown) {
        sentBody = body;
        return { status: 200, json: { tasks: [{ result: [{ items: [{ url_from: "https://aff.com", url_to: "https://acme.com?ref=x", domain_from_rank: 72 }] }] }] } };
      },
    };
    const rows = await new DataForSEOBacklinkProvider({ login: "x", password: "y", http }).referringLinks("acme.com", 100);
    expect(sentBody[0].rank_scale).toBe("one_hundred"); // pre-normalized DA, no second call
    expect(rows[0]!.domainFromRank).toBe(72);
  });
});

class RecordingBacklinks implements BacklinkProvider {
  readonly kind = "recording";
  targets: string[] = [];
  lastOpts: { urlToContains?: string; urlToContainsAny?: string[] } | undefined;
  constructor(private readonly rows: BacklinkRow[]) {}
  async referringLinks(target: string, _limit: number, opts?: { urlToContains?: string; urlToContainsAny?: string[] }): Promise<BacklinkRow[]> {
    this.targets.push(opts?.urlToContains ? `${target}?${opts.urlToContains}` : target);
    this.lastOpts = opts;
    return this.rows;
  }
}

describe("CompetitorProgramResolver", () => {
  it("reads the competitor's site to find their affiliate program + merchant id", async () => {
    const siteFetcher: HttpFetcher = {
      kind: "mock",
      async get(url: string): Promise<FetchResult> {
        if (url === "https://acme.com") return { status: 200, url, html: `<a href="/affiliates">Become an affiliate</a>` };
        if (url.endsWith("/affiliates")) return { status: 200, url, html: `<a href="https://shareasale.com/shareasale.cfm?merchantID=56789">Join on ShareASale</a>` };
        return { status: 404, url, html: "" };
      },
    };
    const programs = await new CompetitorProgramResolver({ fetcher: siteFetcher }).resolve("acme.com");
    expect(programs).toContainEqual(expect.objectContaining({ network: "ShareASale", merchantId: "56789" }));
  });

  it("honors a manual override (and skips the crawl)", async () => {
    const r = new CompetitorProgramResolver({ overrides: { "acme.com": [{ network: "Impact", kind: "vanity", merchantId: null, vanityHost: "acme.pxf.io" }] } });
    expect(await r.resolve("acme.com")).toContainEqual(expect.objectContaining({ vanityHost: "acme.pxf.io" }));
  });
});

describe("BacklinkDiscoverySource — resolved network targeting", () => {
  it("queries the resolved vanity host and confirms the competitor", async () => {
    const resolver = new CompetitorProgramResolver({ overrides: { "acme.com": [{ network: "Impact", kind: "vanity", merchantId: null, vanityHost: "acme.pxf.io" }] } });
    const provider = new RecordingBacklinks([{ urlFrom: "https://affblog.com/review", urlTo: "https://acme.pxf.io/c/1/2", anchor: "x" }]);
    const cands = await new BacklinkDiscoverySource(provider, resolver).discover({ ...baseQuery, competitors: ["acme.com"], limit: 5 });
    expect(provider.targets.some((t) => t.startsWith("acme.pxf.io"))).toBe(true); // queried the vanity host, not the apex
    expect(cands[0]!.confirmedCompetitor).toBe("acme.com");
    expect(cands[0]!.identity).toBe("affblog.com");
  });

  it("filters the shared network by merchant id", async () => {
    const resolver = new CompetitorProgramResolver({ overrides: { "acme.com": [{ network: "ShareASale", kind: "shared", merchantId: "56789", vanityHost: null }] } });
    const provider = new RecordingBacklinks([{ urlFrom: "https://aff.com/x", urlTo: "https://shareasale.com/r.cfm?m=56789", anchor: "" }]);
    await new BacklinkDiscoverySource(provider, resolver).discover({ ...baseQuery, competitors: ["acme.com"], limit: 5 });
    expect(provider.targets).toContain("shareasale.com?m=56789"); // queried the network, filtered by id
  });

  it("apex fallback (no resolved program) filters by affiliate markers", async () => {
    const provider = new RecordingBacklinks([{ urlFrom: "https://aff.com/x", urlTo: "https://acme.com/p?ref=joe", anchor: "" }]);
    await new BacklinkDiscoverySource(provider).discover({ ...baseQuery, competitors: ["acme.com"], limit: 5 });
    expect(provider.lastOpts?.urlToContainsAny).toBeTruthy(); // affiliate-marker OR filter on the apex query
  });

  it("carries the referring-domain authority onto the candidate (free DA from backlinks)", async () => {
    const provider = new RecordingBacklinks([{ urlFrom: "https://aff.com/x", urlTo: "https://acme.com/p?ref=joe", anchor: "", domainFromRank: 64 }]);
    const cands = await new BacklinkDiscoverySource(provider).discover({ ...baseQuery, competitors: ["acme.com"], limit: 5 });
    expect(cands[0]!.domainAuthority).toBe(64);
  });
});

describe("DataForSEOSerpProvider", () => {
  it("posts a Google-organic-live task and maps organic items to SERP hits", async () => {
    let sentBody: any = null;
    const http = {
      async post(url: string, body: unknown) {
        sentBody = { url, body };
        return {
          status: 200,
          json: {
            tasks: [{ result: [{ items: [
              { type: "organic", title: "Best trail shoes", url: "https://blog.com/best", description: "a review" },
              { type: "people_also_ask", title: "ignored", url: "https://x.com" }, // non-organic → dropped
            ] }] }],
          },
        };
      },
    };
    const hits = await new DataForSEOSerpProvider({ login: "l", password: "p", http }).search("best trail shoes", 10);
    expect(sentBody.url).toContain("/serp/google/organic/live/advanced");
    expect(sentBody.body[0].keyword).toBe("best trail shoes");
    expect(hits).toEqual([{ title: "Best trail shoes", url: "https://blog.com/best", snippet: "a review" }]);
  });
});

describe("YouTubeDiscoverySource", () => {
  it("collapses niche-review videos to distinct channels with a youtube channelUrl", async () => {
    let lastUrl = "";
    const http = {
      async get(url: string) {
        lastUrl = url;
        return {
          status: 200,
          json: {
            items: [
              { id: { videoId: "v1" }, snippet: { channelId: "UC_aaa", channelTitle: "Trail Geek", title: "Best trail shoes 2026" } },
              { id: { videoId: "v2" }, snippet: { channelId: "UC_aaa", channelTitle: "Trail Geek", title: "Another review" } }, // same channel → deduped
              { id: { videoId: "v3" }, snippet: { channelId: "UC_bbb", channelTitle: "RunnerPro", title: "Shoe shootout" } },
            ],
          },
        };
      },
    };
    const src = new YouTubeDiscoverySource({ apiKey: "k", http, maxQueries: 1 });
    const cands = await src.discover({ ...baseQuery, limit: 10 });
    expect(lastUrl).toContain("type=video"); // search.list video query
    expect(cands.map((c) => c.channelUrl)).toEqual([
      "https://www.youtube.com/channel/UC_aaa",
      "https://www.youtube.com/channel/UC_bbb",
    ]);
    expect(cands[0]!.identity).toBe("Trail Geek");
    expect(cands[0]!.synthetic).toBe(false);
    expect(cands[0]!.siteUrl).toBeNull(); // no website — exactly the gap this fills
  });
});
