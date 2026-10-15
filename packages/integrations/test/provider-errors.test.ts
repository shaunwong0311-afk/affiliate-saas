import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SerpApiProvider,
  DataForSEOSerpProvider,
  DataForSEOBacklinkProvider,
  SerpDiscoverySource,
  BacklinkDiscoverySource,
  YouTubeDiscoverySource,
  SocialCreatorDiscoverySource,
  PodcastDiscoverySource,
  YouTubeEnricher,
  ScrapeMetricsEnricher,
  EnricherRegistry,
  CachingEnricher,
  HunterFinder,
  ProviderError,
  ProxyUnavailableError,
} from "../src/index.js";
import type { DiscoveryIssue, DiscoveryQuery, HttpFetcher, FetchResult, SerpProvider, SerpHit, BacklinkProvider, BacklinkRow } from "../src/index.js";

/**
 * AUDIT-2026-10 D13 — an adapter must tell "the provider refused us" (bad key, spent
 * quota, missing subscription, outage) apart from "there is nothing to find". Every one
 * of these used to return an empty result for both.
 */

afterEach(() => vi.restoreAllMocks());

const query: DiscoveryQuery = { merchantId: "m1", niche: "skincare", competitors: ["rival.com"], keywords: [], channels: ["serp", "blog", "youtube"], limit: 10 };
const reply = (status: number, json: unknown) => ({ status, json });
const collect = () => {
  const issues: DiscoveryIssue[] = [];
  return { issues, hooks: { onError: (i: DiscoveryIssue) => void issues.push(i) } };
};

describe("SerpApiProvider", () => {
  const provider = (res: { status: number; json: unknown }) => new SerpApiProvider({ apiKey: "k", http: { async get() { return res; } } });

  it("throws on a rejected key instead of returning no results", async () => {
    const err = await provider(reply(401, { error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" })).search("q", 5).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: "serpapi", status: 401, kind: "auth" });
    expect(err.message).toContain("Invalid API key");
  });

  it("throws on an exhausted plan / rate limit", async () => {
    await expect(provider(reply(429, { error: "Your account has run out of searches." })).search("q", 5)).rejects.toMatchObject({ kind: "quota", status: 429 });
  });

  it("throws on an error body that arrives with HTTP 200", async () => {
    await expect(provider(reply(200, { error: "Missing query `q` parameter." })).search("q", 5)).rejects.toBeInstanceOf(ProviderError);
  });

  it("keeps a genuinely EMPTY search an empty list (it also carries an `error` string)", async () => {
    const empty = reply(200, { search_metadata: { status: "Success" }, search_information: { organic_results_state: "Fully empty" }, error: "Google hasn't returned any results for this query." });
    expect(await provider(empty).search("zzzz", 5)).toEqual([]);
    expect(await provider(reply(200, { organic_results: [{ title: "t", link: "https://a.com", snippet: "s" }] })).search("q", 5)).toEqual([{ title: "t", url: "https://a.com", snippet: "s" }]);
  });
});

describe("DataForSEO adapters", () => {
  const post = (res: { status: number; json: unknown }) => ({ async post() { return res; } });

  it("surface an unauthorized login (HTTP 401)", async () => {
    const res = reply(401, { status_code: 40100, status_message: "You are not authorized to access this resource." });
    await expect(new DataForSEOSerpProvider({ login: "l", password: "p", http: post(res) }).search("q", 5)).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(new DataForSEOBacklinkProvider({ login: "l", password: "p", http: post(res) }).referringLinks("rival.com", 10)).rejects.toMatchObject({ kind: "auth" });
  });

  it("surface a provider-level error reported INSIDE an HTTP 200 (missing subscription, no funds)", async () => {
    const noSub = reply(200, { status_code: 20000, tasks: [{ status_code: 40204, status_message: "Access denied. Visit Plans and Subscriptions to activate your subscription and get access to this API.", result: null }] });
    const err = await new DataForSEOBacklinkProvider({ login: "l", password: "p", http: post(noSub) }).referringLinks("rival.com", 10).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("activate your subscription");
    expect(err.kind).toBe("quota");

    const noFunds = reply(200, { status_code: 40210, status_message: "Insufficient Funds." });
    await expect(new DataForSEOSerpProvider({ login: "l", password: "p", http: post(noFunds) }).search("q", 5)).rejects.toThrow(/Insufficient Funds/);

    const badField = reply(200, { status_code: 20000, tasks: [{ status_code: 40501, status_message: "Invalid Field: 'filters'.", result: null }] });
    await expect(new DataForSEOBacklinkProvider({ login: "l", password: "p", http: post(badField) }).referringLinks("rival.com", 10, { urlToContainsAny: ["ref="] })).rejects.toMatchObject({ kind: "error" });
  });

  it("treat a successful task with no rows as empty", async () => {
    const ok = reply(200, { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: null }] }] });
    expect(await new DataForSEOBacklinkProvider({ login: "l", password: "p", http: post(ok) }).referringLinks("rival.com", 10)).toEqual([]);
    expect(await new DataForSEOSerpProvider({ login: "l", password: "p", http: post(ok) }).search("q", 5)).toEqual([]);
  });

  it("put a deadline on their own HTTP call when no client is injected", async () => {
    let seenSignal: unknown = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seenSignal = init.signal;
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] }), { status: 200 });
    });
    await new DataForSEOBacklinkProvider({ login: "l", password: "p" }).referringLinks("rival.com", 10);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });
});

// A SERP provider whose every search fails / some fail.
function serp(behave: (q: string, call: number) => SerpHit[]): SerpProvider & { calls: string[] } {
  const calls: string[] = [];
  return { kind: "fake-serp", calls, async search(q: string) { calls.push(q); return behave(q, calls.length); } };
}
const blankPage: HttpFetcher = { kind: "mock", async get(url: string): Promise<FetchResult> { return { status: 200, url, html: "<html></html>" }; } };

describe("SerpDiscoverySource", () => {
  it("THROWS when every query failed — and stops after a rejected key instead of paying for 13 more", async () => {
    const provider = serp(() => {
      throw new ProviderError("serpapi", 401, "Invalid API key");
    });
    const err = await new SerpDiscoverySource(provider, blankPage).discover(query).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("Invalid API key");
    expect(provider.calls).toHaveLength(1);
  });

  it("returns what it found and REPORTS a partial failure", async () => {
    const provider = serp((q, call) => {
      if (call === 2) throw new Error("socket hang up");
      return [{ title: q, url: `https://site-${call}.com/p`, snippet: "" }];
    });
    const { issues, hooks } = collect();
    const out = await new SerpDiscoverySource(provider, blankPage, { maxQueries: 4 }).discover(query, hooks);
    expect(out.length).toBeGreaterThan(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sourceType: "serp_mining" });
    expect(issues[0]!.message).toContain("socket hang up");
    expect(provider.calls.length).toBe(4); // an ordinary failure does not stop the run
  });

  it("reports ONCE when page fetches cannot go through the required proxy, and keeps the SERP hits", async () => {
    const provider = serp((q, call) => [{ title: q, url: `https://site-${call}.com/p`, snippet: "" }]);
    let fetches = 0;
    const noProxy: HttpFetcher = { kind: "proxy", async get() { fetches++; throw new ProxyUnavailableError("PROXY_URL is set but the proxy client could not be loaded"); } };
    const { issues, hooks } = collect();
    const out = await new SerpDiscoverySource(provider, noProxy, { maxQueries: 3 }).discover(query, hooks);
    expect(out.length).toBe(3);
    expect(out.every((c) => /page not fetched/.test(c.evidenceSummary ?? ""))).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/proxy/i);
    expect(fetches).toBe(1); // stopped trying after the first refusal
  });
});

describe("BacklinkDiscoverySource", () => {
  const failing = (error: Error): BacklinkProvider & { calls: number } => {
    const p = { kind: "fake", calls: 0, async referringLinks(): Promise<BacklinkRow[]> { p.calls++; throw error; } };
    return p;
  };

  it("throws the provider's reason when mining failed outright", async () => {
    const provider = failing(new ProviderError("dataforseo-backlinks", 0, "Access denied. Visit Plans and Subscriptions…", "quota"));
    await expect(new BacklinkDiscoverySource(provider).discover({ ...query, competitors: ["a.com", "b.com", "c.com"] })).rejects.toThrow(/Access denied/);
    expect(provider.calls).toBe(1); // not retried per competitor
  });

  it("with no provider wired it is an honest empty, not an error", async () => {
    expect(await new BacklinkDiscoverySource().discover(query)).toEqual([]);
  });
});

describe("YouTube / social / podcast sources", () => {
  it("YouTube: a spent quota (403 quotaExceeded) is an error, not 'no creators'", async () => {
    let calls = 0;
    const http = { async get() { calls++; return reply(403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.", errors: [{ reason: "quotaExceeded" }] } }); } };
    const err = await new YouTubeDiscoverySource({ apiKey: "k", http }).discover(query).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: "youtube", status: 403, kind: "quota" });
    expect(err.message).toContain("quotaExceeded");
    expect(err.message).not.toContain("<a"); // the API's HTML is stripped
    expect(calls).toBe(1);
  });

  it("YouTube: an invalid key is an auth error", async () => {
    const http = { async get() { return reply(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", errors: [{ reason: "badRequest" }] } }); } };
    await expect(new YouTubeDiscoverySource({ apiKey: "bad", http }).discover(query)).rejects.toMatchObject({ kind: "auth" });
  });

  it("social: a non-2xx answer from the scraping API is an error", async () => {
    const http = { async get() { return reply(402, { error: "Out of credits" }); } };
    await expect(new SocialCreatorDiscoverySource({ endpoint: "https://scrape.test/s", http }).discover(query)).rejects.toThrow(/Out of credits/);
  });

  it("podcast: a throttled iTunes search is an error; a partial failure is reported", async () => {
    await expect(new PodcastDiscoverySource({ http: { async get() { return reply(403, {}); } } }).discover(query)).rejects.toBeInstanceOf(ProviderError);

    let n = 0;
    const flaky = { async get() { return ++n === 1 ? reply(200, { results: [{ collectionName: "Skin Deep", collectionViewUrl: "https://podcasts.apple.com/us/podcast/skin-deep/id1" }] }) : reply(503, {}); } };
    const { issues, hooks } = collect();
    const out = await new PodcastDiscoverySource({ http: flaky }).discover(query, hooks);
    expect(out).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sourceType: "podcast_discovery" });
  });
});

describe("enrichers", () => {
  const account = { platform: "youtube", handle: "@creator", url: "https://youtube.com/@creator" };

  it("YouTubeEnricher throws on a 403 — and the cache does NOT remember it as 'no data' for 24 h", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let quotaLeft = false;
    let calls = 0;
    const http = {
      async get(url: string) {
        calls++;
        if (!quotaLeft) return reply(403, { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } });
        if (url.includes("/channels")) return reply(200, { items: [{ id: "UC1", snippet: {}, statistics: { subscriberCount: "5000" }, contentDetails: {} }] });
        return reply(200, { items: [] });
      },
    };
    const enricher = new YouTubeEnricher({ apiKey: "k", http });
    await expect(enricher.enrich(account)).rejects.toMatchObject({ kind: "quota" });

    const cached = new CachingEnricher(new EnricherRegistry([enricher]));
    expect(await cached.enrich(account)).toBeNull(); // unknown for now…
    quotaLeft = true;
    expect((await cached.enrich(account))?.reach).toBe(5000); // …and retried, not served a cached miss
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("YouTubeEnricher still treats a real 'no such channel' as a cacheable miss", async () => {
    let calls = 0;
    const http = { async get() { calls++; return reply(200, { items: [] }); } };
    const cached = new CachingEnricher(new EnricherRegistry([new YouTubeEnricher({ apiKey: "k", http })]));
    expect(await cached.enrich(account)).toBeNull();
    expect(await cached.enrich(account)).toBeNull();
    expect(calls).toBe(1);
  });

  it("ScrapeMetricsEnricher throws on a non-2xx answer", async () => {
    const http = { async get() { return reply(401, { message: "invalid token" }); } };
    await expect(new ScrapeMetricsEnricher({ endpoint: "https://actor", http }).enrich({ platform: "instagram", handle: "@c", url: "x" })).rejects.toThrow(/invalid token/);
  });
});

describe("HunterFinder", () => {
  it("throws on a bad key / plan limit instead of reading as 'no email' / 'not deliverable'", async () => {
    const unauthorized = { async get() { return reply(401, { errors: [{ id: "authentication_failed", details: "No user found for the API key supplied" }] }); } };
    await expect(new HunterFinder({ apiKey: "bad", http: unauthorized }).find({ fullName: "Jane Doe", domain: "site.com" })).rejects.toMatchObject({ kind: "auth" });
    const limited = { async get() { return reply(429, { errors: [{ id: "too_many_requests", details: "You've reached your monthly quota" }] }); } };
    await expect(new HunterFinder({ apiKey: "k", http: limited }).verify("a@site.com")).rejects.toThrow(/monthly quota/);
  });

  it("does not call the API without a domain to ask about", async () => {
    let calls = 0;
    const http = { async get() { calls++; return reply(200, { data: { email: "x@y.com" } }); } };
    expect(await new HunterFinder({ apiKey: "k", http }).find({ fullName: "Hyram Skincare" })).toEqual([]);
    expect(calls).toBe(0);
  });
});
