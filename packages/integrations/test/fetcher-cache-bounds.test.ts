import { describe, it, expect } from "vitest";
import { CachingFetcher, RateLimitedFetcher, CachingEnricher } from "../src/index.js";
import type { HttpFetcher, FetchResult, AccountEnricher } from "../src/index.js";

/**
 * AUDIT-2026-10 D14 — the page cache lives as long as the worker. It used to keep every
 * entry for ever (expired or not) and whole pages of any size.
 */

function pages(size = 1000) {
  let calls = 0;
  const fetcher: HttpFetcher & { calls: () => number } = {
    kind: "pages",
    calls: () => calls,
    async get(url: string): Promise<FetchResult> {
      calls++;
      return { status: 200, url, html: "x".repeat(size) };
    },
  };
  return fetcher;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CachingFetcher — bounded", () => {
  it("drops expired entries instead of keeping them for ever", async () => {
    const cache = new CachingFetcher(pages(), { ttlMs: 5 });
    for (let i = 0; i < 300; i++) await cache.get(`https://site${i}.com`);
    await sleep(20);
    await cache.get("https://one-more.com"); // the next write sweeps what has expired
    expect(cache.size).toBe(1); // was 301
  });

  it("holds at most maxEntries pages, evicting the least recently used", async () => {
    const inner = pages();
    const cache = new CachingFetcher(inner, { maxEntries: 3 });
    await cache.get("https://a.com");
    await cache.get("https://b.com");
    await cache.get("https://c.com");
    await cache.get("https://a.com"); // touch a → b is now the oldest
    await cache.get("https://d.com"); // evicts b
    expect(cache.size).toBe(3);
    const before = inner.calls();
    await cache.get("https://a.com");
    await cache.get("https://c.com");
    await cache.get("https://d.com");
    expect(inner.calls()).toBe(before); // all three still cached
    await cache.get("https://b.com");
    expect(inner.calls()).toBe(before + 1); // b was the one evicted
  });

  it("holds at most maxBytes of page text", async () => {
    const cache = new CachingFetcher(pages(10_000), { maxBytes: 35_000 });
    for (let i = 0; i < 20; i++) await cache.get(`https://s${i}.com`);
    expect(cache.size).toBe(3); // 3 × ~10 KB fit in 35 KB
  });

  it("does not cache a single page larger than the whole budget (but still returns it)", async () => {
    const inner = pages(50_000);
    const cache = new CachingFetcher(inner, { maxBytes: 10_000 });
    expect((await cache.get("https://huge.com")).html).toHaveLength(50_000);
    await cache.get("https://huge.com");
    expect(cache.size).toBe(0);
    expect(inner.calls()).toBe(2);
  });

  it("still serves hits and coalesces concurrent fetches (unchanged behaviour)", async () => {
    const inner = pages();
    const cache = new CachingFetcher(inner);
    await Promise.all([cache.get("https://a.com"), cache.get("https://a.com")]);
    await cache.get("https://a.com");
    expect(inner.calls()).toBe(1);
  });
});

describe("other long-lived maps are bounded too", () => {
  it("RateLimitedFetcher forgets hosts whose slot has passed", async () => {
    const limited = new RateLimitedFetcher(pages(), { perHostIntervalMs: 1, maxConcurrent: 50 });
    for (let i = 0; i < 2100; i++) await limited.get(`https://h${i}.com/`);
    await sleep(5);
    await limited.get("https://last.com/");
    const tracked = (limited as unknown as { nextAllowedByHost: Map<string, number> }).nextAllowedByHost.size;
    expect(tracked).toBeLessThan(2000);
  });

  it("CachingEnricher does not grow without limit", async () => {
    const inner: AccountEnricher = { kind: "n", supports: () => true, async enrich() { return null; } };
    const cached = new CachingEnricher(inner, 1); // 1 ms TTL: everything is expired by the time the cap is reached
    const max = (CachingEnricher as unknown as { MAX_ENTRIES: number }).MAX_ENTRIES;
    for (let i = 0; i < max + 50; i++) await cached.enrich({ platform: "youtube", handle: `@c${i}`, url: "x" });
    const size = (cached as unknown as { cache: Map<string, unknown> }).cache.size;
    expect(size).toBeLessThanOrEqual(max);
  });
});
