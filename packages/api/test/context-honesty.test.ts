import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FetchRedirectResolver, HunterFinder, NullEmailFinder, ProxyHttpFetcher, StubEmailFinder, UnsafeUrlError } from "@affiliate/integrations";
import { runSourcing } from "@affiliate/recruitment";
import { createContext } from "../src/context.js";
import { loadConfig } from "../src/config.js";
import { seedDemo } from "../src/dev/seed.js";

/**
 * AUDIT-2026-10 — what `createContext` wires for discovery (D1, D3, D9) and whether the
 * "deterministic" demo really is (D17).
 */

// createContext reads discovery keys straight from process.env — isolate each test.
const ENV_KEYS = ["PROXY_URL", "SERPAPI_KEY", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "BROWSER_FETCH", "YOUTUBE_API_KEY", "SCRAPE_API_URL", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "RELEVANCE_LLM_API_KEY"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const config = (over: { allowSyntheticDiscovery: boolean; isProduction?: boolean }) => ({ ...loadConfig({}), ...over });

describe("D1 — which email finder is wired", () => {
  it("production without a Hunter key gets NO finder — not the pattern-guessing stub", () => {
    process.env.SERPAPI_KEY = "serp-key"; // real discovery is on…
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: false, isProduction: true }) });
    expect(ctx.emailFinder).toBeInstanceOf(NullEmailFinder); // …was StubEmailFinder
    expect((ctx.emailFinder as { guesses?: boolean }).guesses).toBeUndefined();
  });

  it("the guessing stub is wired only where synthetic (demo) discovery is allowed", () => {
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: true }) });
    expect(ctx.emailFinder).toBeInstanceOf(StubEmailFinder);
    expect(ctx.emailFinder.guesses).toBe(true);
  });

  it("a Hunter key wins in either mode", () => {
    process.env.HUNTER_API_KEY = "hunter-key";
    expect(createContext({ config: config({ allowSyntheticDiscovery: false }) }).emailFinder).toBeInstanceOf(HunterFinder);
    expect(createContext({ config: config({ allowSyntheticDiscovery: true }) }).emailFinder).toBeInstanceOf(HunterFinder);
  });

  it("end to end with production wiring and no Hunter key: a real prospect gets no email, and nothing is guessed", async () => {
    process.env.SERPAPI_KEY = "serp-key";
    const ctx = createContext({
      config: config({ allowSyntheticDiscovery: false, isProduction: true }),
      // Replace the network pieces only; the FINDER is the one createContext chose.
      discoverySources: [
        {
          sourceType: "backlink_mining",
          async discover() {
            return [{ identity: "skinblog.com", siteUrl: "https://skinblog.com", channelUrl: null, sourceType: "backlink_mining", evidenceUrl: null, evidenceSummary: "review", outboundLinks: [], pageHtml: null, synthetic: false }];
          },
        },
      ],
      fetcher: { kind: "mock", async get(url: string) { return { status: 200, url, html: `<html><body>${"nothing to see. ".repeat(30)}</body></html>` }; } },
      emailVerifier: { kind: "mx", async verify() { return { deliverable: true, reason: "mx record present" }; } },
      redirectResolver: { kind: "mock", async resolve() { return null; } },
    });
    await ctx.db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: ["glowrival.com"], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString() });
    await runSourcing(ctx, "m1", { limit: 5 });
    const [p] = await ctx.db.prospects.find((x) => x.merchantId === "m1");
    expect(p).toMatchObject({ synthetic: false, email: null });
    expect(p!.evidence?.contactSource).toBeNull();
    expect((await ctx.db.prospectSignals.findOne((s) => s.prospectId === p!.id))!.verifiedEmail).toBe(false);
  });
});

describe("D3 / D9 — the page fetcher and the redirect resolver", () => {
  const innermost = (fetcher: unknown): ProxyHttpFetcher => {
    let f = fetcher as { inner?: unknown; cheap?: unknown };
    while (f && !(f instanceof ProxyHttpFetcher)) f = (f.inner ?? f.cheap) as typeof f;
    return f as unknown as ProxyHttpFetcher;
  };

  it("with PROXY_URL set the fetcher REQUIRES a proxy", () => {
    process.env.PROXY_URL = "http://user:pass@proxy.example:8000, http://proxy2.example:8000";
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: false }) });
    const net = innermost(ctx.fetcher);
    expect(net).toBeInstanceOf(ProxyHttpFetcher);
    expect((net as unknown as { opts: { requireProxy?: boolean } }).opts.requireProxy).toBe(true);
  });

  it("without PROXY_URL it does not (direct, still guarded) — and production says so at boot", () => {
    process.env.SERPAPI_KEY = "serp-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dev = createContext({ config: config({ allowSyntheticDiscovery: false }) });
    expect((innermost(dev.fetcher) as unknown as { opts: { requireProxy?: boolean } }).opts.requireProxy).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/PROXY_URL/);
    createContext({ config: config({ allowSyntheticDiscovery: false, isProduction: true }) });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/without PROXY_URL/);
  });

  it("the redirect resolver follows links THROUGH that fetcher — it has no connection of its own", () => {
    process.env.PROXY_URL = "http://proxy.example:8000";
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: false }) });
    expect(ctx.redirectResolver).toBeInstanceOf(FetchRedirectResolver);
    const via = (ctx.redirectResolver as unknown as { opts: { via?: unknown } }).opts.via;
    expect(via).toBe(innermost(ctx.fetcher)); // the very same guarded, proxy-requiring fetcher
  });

  it("the wired fetcher refuses a private address (whatever asked for it: an import, a scraped link, a feed)", async () => {
    process.env.SERPAPI_KEY = "serp-key";
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: false }) });
    await expect(ctx.fetcher!.get("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(ctx.fetcher!.get("http://localhost:5432/")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(await ctx.redirectResolver!.resolve("http://10.0.0.5/go?ref=x")).toBeNull();
  });

  it("no keys at all: nothing touches the network (no fetcher, no resolver, no verifier)", () => {
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: true }) });
    expect(ctx.fetcher).toBeUndefined();
    expect(ctx.redirectResolver).toBeUndefined();
    expect(ctx.emailVerifier).toBeUndefined();
  });
});

describe("D17 — the demo is deterministic", () => {
  async function seedOnce() {
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: true }) });
    const { merchantId } = await seedDemo(ctx);
    const prospects = await ctx.db.prospects.find((p) => p.merchantId === merchantId);
    const tiers: Record<string, number> = {};
    const rows: Record<string, unknown> = {};
    for (const p of prospects) {
      tiers[p.tier ?? "none"] = (tiers[p.tier ?? "none"] ?? 0) + 1;
      const sig = await ctx.db.prospectSignals.findOne((s) => s.prospectId === p.id);
      rows[`${p.source}|${p.identity}|${p.siteUrl ?? p.channelUrl}`] = { score: p.score, tier: p.tier, state: p.state, email: p.email, reach: sig?.reach, da: sig?.da, relevance: sig?.relevance };
    }
    return { tiers, rows, merchantId, count: prospects.length };
  }

  it("two seeds of a fresh instance produce the same prospects, scores, tiers and states", async () => {
    const a = await seedOnce();
    const b = await seedOnce();
    expect(a.merchantId).not.toBe(b.merchantId); // ids ARE random — the data must not depend on them
    expect(b.count).toBe(a.count);
    expect(b.tiers).toEqual(a.tiers); // used to differ run to run (B 43/44, C 19/18)
    expect(b.rows).toEqual(a.rows);
  });

  it("every demo prospect is labelled synthetic and none carries a 'verified' contact", async () => {
    const ctx = createContext({ config: config({ allowSyntheticDiscovery: true }) });
    const { merchantId } = await seedDemo(ctx);
    const prospects = await ctx.db.prospects.find((p) => p.merchantId === merchantId);
    expect(prospects.length).toBeGreaterThan(20);
    for (const p of prospects) {
      expect(p.synthetic).toBe(true);
      const sig = await ctx.db.prospectSignals.findOne((s) => s.prospectId === p.id);
      expect(sig?.verifiedEmail).toBe(false);
      if (p.email) expect(p.evidence?.contactSource).toBe("pattern-guess");
    }
  });
});
