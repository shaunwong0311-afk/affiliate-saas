import { describe, it, expect } from "vitest";
import { CachingFetcher, RateLimitedFetcher } from "../src/index.js";
import type { HttpFetcher, FetchResult } from "../src/index.js";

/** A recording fetcher: counts calls per url, tracks peak concurrency + call times. */
function recorder(opts: { latencyMs?: number; status?: number } = {}) {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const times: number[] = [];
  const fetcher: HttpFetcher & { calls: () => number; peak: () => number; times: () => number[] } = {
    kind: "recorder",
    calls: () => calls,
    peak: () => peak,
    times: () => times,
    async get(url: string): Promise<FetchResult> {
      calls++;
      active++;
      peak = Math.max(peak, active);
      times.push(Date.now());
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      active--;
      return { status: opts.status ?? 200, url, html: `<html><body>${url}</body></html>`.padEnd(300, " ") };
    },
  };
  return fetcher;
}

describe("CachingFetcher", () => {
  it("serves a repeated URL from cache (inner fetched once)", async () => {
    const inner = recorder();
    const f = new CachingFetcher(inner);
    await f.get("https://a.com");
    await f.get("https://a.com");
    await f.get("https://a.com");
    expect(inner.calls()).toBe(1);
  });

  it("coalesces concurrent identical fetches into ONE network request", async () => {
    const inner = recorder({ latencyMs: 20 });
    const f = new CachingFetcher(inner);
    await Promise.all([f.get("https://a.com"), f.get("https://a.com"), f.get("https://a.com")]);
    expect(inner.calls()).toBe(1); // all three shared the in-flight promise
  });

  it("still fetches distinct URLs independently", async () => {
    const inner = recorder();
    const f = new CachingFetcher(inner);
    await f.get("https://a.com");
    await f.get("https://b.com");
    expect(inner.calls()).toBe(2);
  });

  it("re-fetches a non-2xx result sooner (short error TTL)", async () => {
    const inner = recorder({ status: 503 });
    const f = new CachingFetcher(inner, { errorTtlMs: 0 });
    await f.get("https://down.com");
    await new Promise((r) => setTimeout(r, 1));
    await f.get("https://down.com");
    expect(inner.calls()).toBe(2); // error TTL expired → fetched again
  });
});

describe("RateLimitedFetcher", () => {
  it("never exceeds the global concurrency cap", async () => {
    const inner = recorder({ latencyMs: 15 });
    const f = new RateLimitedFetcher(inner, { maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => f.get(`https://h${i}.com`)));
    expect(inner.peak()).toBeLessThanOrEqual(2);
    expect(inner.calls()).toBe(6); // all still completed
  });

  it("spaces consecutive same-host requests by the per-host interval", async () => {
    const inner = recorder();
    const f = new RateLimitedFetcher(inner, { perHostIntervalMs: 40, maxConcurrent: 10 });
    await Promise.all([f.get("https://same.com/1"), f.get("https://same.com/2"), f.get("https://same.com/3")]);
    const t = inner.times();
    expect(t.length).toBe(3);
    // 2nd and 3rd were spaced out (allow scheduler slack).
    expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(30);
    expect(t[2]! - t[1]!).toBeGreaterThanOrEqual(30);
  });

  it("does NOT space requests to different hosts", async () => {
    const inner = recorder();
    const f = new RateLimitedFetcher(inner, { perHostIntervalMs: 40, maxConcurrent: 10 });
    const start = Date.now();
    await Promise.all([f.get("https://a.com"), f.get("https://b.com"), f.get("https://c.com")]);
    expect(Date.now() - start).toBeLessThan(40); // distinct hosts run without the gap
  });
});
