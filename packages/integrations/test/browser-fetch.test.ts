import { describe, it, expect } from "vitest";
import { PlaywrightFetcher, EscalatingFetcher, looksBlocked, UnsafeUrlError, ProxyUnavailableError } from "../src/index.js";
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

// DNS is injected throughout: the fetcher now resolves the target before launching anything
// (the outbound guard), and tests must not look names up on the real network.
const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("PlaywrightFetcher", () => {
  it("fails gracefully (status 0) when playwright isn't installed — no crash", async () => {
    const r = await new PlaywrightFetcher({ lookup: publicDns, loadPlaywright: async () => { throw new Error("Cannot find package 'playwright'"); } }).get("https://example.com");
    expect(r.status).toBe(0);
    expect(r.html).toBe("");
  });
});

/** A stand-in for the `playwright` package that records what the fetcher asks of it. */
function fakePlaywright(opts: { subrequests?: string[]; redirectedFrom?: string; finalUrl?: string } = {}) {
  const seen = { launched: 0, contextOptions: null as any, continued: [] as string[], aborted: [] as string[] };
  const pw = {
    chromium: {
      async launch() {
        seen.launched++;
        return {
          async newContext(contextOptions: any) {
            seen.contextOptions = contextOptions;
            let handler: ((route: any) => Promise<void>) | null = null;
            const request = async (target: string) => {
              await handler?.({
                request: () => ({ url: () => target }),
                continue: async () => void seen.continued.push(target),
                abort: async () => void seen.aborted.push(target),
              });
            };
            return {
              async route(_pattern: string, h: (route: any) => Promise<void>) {
                handler = h;
              },
              async newPage() {
                let current = "about:blank";
                return {
                  async goto(target: string) {
                    await request(target);
                    for (const sub of opts.subrequests ?? []) await request(sub);
                    current = opts.finalUrl ?? target;
                    const first = opts.redirectedFrom ? { url: () => opts.redirectedFrom!, redirectedFrom: () => null } : null;
                    return { status: () => 200, request: () => ({ url: () => current, redirectedFrom: () => first }) };
                  },
                  async waitForLoadState() {},
                  url: () => current,
                  async content() {
                    return html("rendered by the fake browser");
                  },
                };
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };
  return { pw, seen };
}

describe("PlaywrightFetcher — the outbound guard applies to the browser too (D9)", () => {
  it("refuses a private target before a browser is ever launched", async () => {
    const { pw, seen } = fakePlaywright();
    const f = new PlaywrightFetcher({ loadPlaywright: async () => pw });
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:5432/", "http://localhost/admin", "file:///etc/passwd"]) {
      expect(await f.get(url)).toMatchObject({ status: 0, html: "" });
    }
    expect(seen.launched).toBe(0);
  });

  it("aborts requests the PAGE makes to private addresses and lets public ones through", async () => {
    const { pw, seen } = fakePlaywright({ subrequests: ["https://cdn.example.net/app.js", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/internal", "data:text/plain,ok"] });
    const r = await new PlaywrightFetcher({ lookup: publicDns, loadPlaywright: async () => pw }).get("https://creator.example.com/");
    expect(r.status).toBe(200);
    expect(seen.aborted).toEqual(["http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/internal"]);
    expect(seen.continued).toEqual(["https://creator.example.com/", "https://cdn.example.net/app.js", "data:text/plain,ok"]);
    expect(seen.contextOptions.serviceWorkers).toBe("block");
  });

  it("discards the page when the main document was redirected through a private address", async () => {
    // Playwright does not call route handlers for redirect hops, so the chain is re-checked
    // afterwards and the result thrown away rather than returned.
    const { pw } = fakePlaywright({ redirectedFrom: "http://169.254.169.254/latest/meta-data/", finalUrl: "https://creator.example.com/landing" });
    const r = await new PlaywrightFetcher({ lookup: publicDns, loadPlaywright: async () => pw }).get("https://creator.example.com/");
    expect(r).toMatchObject({ status: 0, html: "" });
  });

  it("passes proxy credentials as separate fields (an embedded user:pass is not applied by the browser)", async () => {
    const { pw, seen } = fakePlaywright();
    await new PlaywrightFetcher({ lookup: publicDns, loadPlaywright: async () => pw, proxies: ["http://user%40corp:p%40ss@proxy.example.net:8000"] }).get("https://creator.example.com/");
    expect(seen.contextOptions.proxy).toEqual({ server: "http://proxy.example.net:8000", username: "user@corp", password: "p@ss" });
  });
});

describe("EscalatingFetcher — a refusal is not a blocked page", () => {
  it("does not hand a URL the guard refused, or a fetch whose proxy is unavailable, to the browser", async () => {
    for (const error of [new UnsafeUrlError("http://10.0.0.1/", "private network"), new ProxyUnavailableError("no proxy path")]) {
      let browserCalls = 0;
      const cheap: HttpFetcher = { kind: "cheap", async get() { throw error; } };
      const browser: HttpFetcher = { kind: "browser", async get(url) { browserCalls++; return { status: 200, url, html: html("x") }; } };
      await expect(new EscalatingFetcher(cheap, browser).get("http://10.0.0.1/")).rejects.toBe(error);
      expect(browserCalls).toBe(0);
    }
  });

  it("still escalates on an ordinary network failure", async () => {
    const cheap: HttpFetcher = { kind: "cheap", async get() { throw new Error("socket hang up"); } };
    const browser: HttpFetcher = { kind: "browser", async get(url) { return { status: 200, url, html: html("rendered by the real browser") }; } };
    expect((await new EscalatingFetcher(cheap, browser).get("https://site.com")).html).toContain("rendered by the real browser");
  });
});
