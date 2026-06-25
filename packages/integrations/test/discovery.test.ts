import { describe, it, expect } from "vitest";
import { buildDiscoveryQueries, SerpDiscoverySource, BacklinkDiscoverySource, CompetitorProgramResolver, DataForSEOBacklinkProvider } from "../src/index.js";
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
});

class RecordingBacklinks implements BacklinkProvider {
  readonly kind = "recording";
  targets: string[] = [];
  constructor(private readonly rows: BacklinkRow[]) {}
  async referringLinks(target: string, _limit: number, opts?: { urlToContains?: string }): Promise<BacklinkRow[]> {
    this.targets.push(opts?.urlToContains ? `${target}?${opts.urlToContains}` : target);
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
});
