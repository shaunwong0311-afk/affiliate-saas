import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SerpDiscoverySource } from "@affiliate/integrations";
import { createContext } from "../src/context.js";
import { loadConfig } from "../src/config.js";

// createContext reads discovery keys straight from process.env — isolate each test.
const ENV_KEYS = ["PROXY_URL", "SERPAPI_KEY", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "BROWSER_FETCH", "YOUTUBE_API_KEY", "SCRAPE_API_URL"];
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
});

const config = (allowSyntheticDiscovery: boolean) => ({ ...loadConfig({}), allowSyntheticDiscovery });

describe("createContext — SERP source gating (#24)", () => {
  it("omits the SERP source when the provider is deterministic and synthetic discovery is disallowed", () => {
    process.env.PROXY_URL = "http://proxy.example:8080"; // real fetcher, but NO SERP key
    const ctx = createContext({ config: config(false) });
    // Honest empty — the deterministic provider fabricates prospects, same rule as backlinks.
    expect(ctx.discoverySources.some((s) => s.sourceType === "serp_mining")).toBe(false);
  });

  it("never pairs the deterministic SERP provider with a real fetcher (no real HTTP to fabricated domains)", () => {
    process.env.PROXY_URL = "http://proxy.example:8080"; // PROXY_URL alone makes the SHARED fetcher real
    const ctx = createContext({ config: config(true) });
    const serp = ctx.discoverySources.find((s) => s.sourceType === "serp_mining");
    expect(serp).toBeInstanceOf(SerpDiscoverySource); // still allowed in dev/demo…
    expect((serp as SerpDiscoverySource).synthetic).toBe(true); // …labeled synthetic…
    // …and its page fetcher must be the no-network one, chosen by whether the SERP
    // PROVIDER is real — not by the aggregate realDiscovery flag.
    expect((serp as any).fetcher.kind).toBe("deterministic");
  });

  it("keeps the SERP source with the real shared fetcher when a real SERP key is set", () => {
    process.env.SERPAPI_KEY = "test-key";
    const ctx = createContext({ config: config(false) });
    const serp = ctx.discoverySources.find((s) => s.sourceType === "serp_mining");
    expect(serp).toBeInstanceOf(SerpDiscoverySource);
    expect((serp as SerpDiscoverySource).synthetic).toBe(false);
    expect((serp as any).fetcher.kind).not.toBe("deterministic");
  });
});
