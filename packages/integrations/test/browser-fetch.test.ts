import { describe, it, expect } from "vitest";
import { PlaywrightFetcher, EscalatingFetcher, looksBlocked } from "../src/index.js";
import type { HttpFetcher, FetchResult } from "../src/index.js";

const html = (s: string) => `<html><body>${s.padEnd(300, " ")}</body></html>`;

describe("looksBlocked", () => {
  it("flags challenge/block responses", () => {
    expect(looksBlocked({ status: 403, html: html("x") })).toBe(true);
    expect(looksBlocked({ status: 503, html: html("x") })).toBe(true);
    expect(looksBlocked({ status: 200, html: "Just a moment..." })).toBe(true); // Cloudflare interstitial
    expect(looksBlocked({ status: 200, html: html("Please enable JavaScript and hcaptcha") })).toBe(true);
    expect(looksBlocked({ status: 200, html: "" })).toBe(true); // empty → JS-gated
  });
  it("passes real content", () => {
    expect(looksBlocked({ status: 200, html: html("Welcome to my creator blog, contact hi@me.com") })).toBe(false);
  });
});

describe("EscalatingFetcher", () => {
  const browserMaker = () => {
    let calls = 0;
    const f: HttpFetcher & { calls: () => number } = {
      kind: "browser",
      calls: () => calls,
      async get(url: string): Promise<FetchResult> {
        calls++;
        return { status: 200, url, html: html("rendered by the real browser") };
      },
    };
    return f;
  };

  it("uses the cheap fetcher and does NOT launch the browser when the page is fine", async () => {
    const cheap: HttpFetcher = { kind: "cheap", async get(url) { return { status: 200, url, html: html("real content here") }; } };
    const browser = browserMaker();
    const r = await new EscalatingFetcher(cheap, browser).get("https://site.com");
    expect(r.html).toContain("real content here");
    expect(browser.calls()).toBe(0); // never paid the browser cost
  });

  it("escalates to the browser when the cheap fetch is blocked/challenged", async () => {
    const cheap: HttpFetcher = { kind: "cheap", async get(url) { return { status: 503, url, html: "Just a moment..." }; } };
    const browser = browserMaker();
    const r = await new EscalatingFetcher(cheap, browser).get("https://cf-protected.com");
    expect(r.html).toContain("rendered by the real browser");
    expect(browser.calls()).toBe(1);
  });
});

describe("PlaywrightFetcher", () => {
  it("fails gracefully (status 0) when playwright isn't installed — no crash", async () => {
    const r = await new PlaywrightFetcher().get("https://example.com");
    expect(r.status).toBe(0);
    expect(r.html).toBe("");
  });
});
