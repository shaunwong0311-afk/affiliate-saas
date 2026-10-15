import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo as SocketAddress } from "node:net";
import {
  ProxyHttpFetcher,
  ProxyUnavailableError,
  FetchRedirectResolver,
  UnsafeUrlError,
  staticProxyPool,
  type AddressInfo,
  type UndiciModule,
} from "../src/index.js";

/**
 * AUDIT-2026-10 D3 — "never the box IP". With a proxy configured, a fetch goes through
 * the proxy or it FAILS; it never falls back to a direct connection. The proxy client
 * (`undici`) is injected: the tests must not depend on whether the package happens to be
 * resolvable on this machine — which is exactly the condition the old code silently
 * branched on.
 */

// The "website": a real local server. A hit on it means a DIRECT connection was made.
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});
async function website(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (handler) handler(req, res);
    else res.end("<html>direct</html>");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as SocketAddress).port, hits };
}

// DNS + policy for the tests: named hosts resolve to loopback and loopback is allowed, so
// that IF the fetcher went direct, the request would really arrive and be counted.
const lookup = async (): Promise<AddressInfo[]> => [{ address: "127.0.0.1", family: 4 }];
const allowLoopback = (address: string) => address === "127.0.0.1";
const PROXY = "http://user:pass@residential-proxy.test:8000";

/** A stand-in for the `undici` package: its own fetch + its own ProxyAgent. */
function fakeUndici(respond: (url: string, init: Record<string, any>) => { status: number; headers?: Record<string, string>; body?: string }) {
  const calls: { url: string; init: Record<string, any> }[] = [];
  const agents: string[] = [];
  class ProxyAgent {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
      agents.push(uri);
    }
  }
  const undici: UndiciModule = {
    ProxyAgent,
    async fetch(url, init) {
      calls.push({ url, init });
      const r = respond(url, init);
      const headers = new Headers(r.headers ?? {});
      return { status: r.status, headers, body: r.body == null ? null : new Response(r.body).body };
    },
  };
  return { undici, calls, agents, ProxyAgent };
}

describe("ProxyHttpFetcher — with a proxy configured", () => {
  it("sends the request through the proxy client's OWN fetch + ProxyAgent, never directly", async () => {
    const site = await website();
    const { undici, calls, agents, ProxyAgent } = fakeUndici(() => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>via proxy</html>" }));
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { requireProxy: true, loadUndici: async () => undici, lookup, isAllowedAddress: allowLoopback });

    const r = await fetcher.get(`http://site.test:${site.port}/page`);
    expect(r).toMatchObject({ status: 200, html: "<html>via proxy</html>", url: `http://site.test:${site.port}/page` });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.dispatcher).toBeInstanceOf(ProxyAgent); // undici's agent, handed to undici's fetch
    expect((calls[0]!.init.dispatcher as { uri: string }).uri).toBe(PROXY); // credentials travel in the proxy URL
    expect(calls[0]!.init.redirect).toBe("manual"); // the guard follows redirects, not the client
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal); // every fetch has a deadline
    expect(agents).toEqual([PROXY]);
    expect(site.hits).toEqual([]); // nothing arrived directly
  });

  it("FAILS — and makes no direct connection — when the proxy client cannot be loaded", async () => {
    const site = await website();
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), {
      requireProxy: true,
      loadUndici: async () => {
        throw Object.assign(new Error("Cannot find package 'undici'"), { code: "ERR_MODULE_NOT_FOUND" });
      },
      lookup,
      isAllowedAddress: allowLoopback,
    });
    const err = await fetcher.get(`http://site.test:${site.port}/page`).catch((e) => e);
    expect(err).toBeInstanceOf(ProxyUnavailableError);
    expect(String(err.message)).toMatch(/undici/);
    expect(String(err.message)).toMatch(/refusing/i);
    // The old code caught the import error and called fetch() with no dispatcher — a direct hit.
    expect(site.hits).toEqual([]);
    // Same for the redirect-following path.
    await expect(fetcher.follow(`http://site.test:${site.port}/go`)).rejects.toBeInstanceOf(ProxyUnavailableError);
    expect(site.hits).toEqual([]);
  });

  it("FAILS when the loaded module is not a usable proxy client", async () => {
    const site = await website();
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { loadUndici: async () => ({}) as unknown as UndiciModule, lookup, isAllowedAddress: allowLoopback });
    await expect(fetcher.get(`http://site.test:${site.port}/`)).rejects.toBeInstanceOf(ProxyUnavailableError);
    expect(site.hits).toEqual([]);
  });

  it("FAILS when the proxy itself is down — a dead proxy is not a reason to go direct", async () => {
    const site = await website();
    const { undici } = fakeUndici(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { requireProxy: true, loadUndici: async () => undici, lookup, isAllowedAddress: allowLoopback });
    await expect(fetcher.get(`http://site.test:${site.port}/page`)).rejects.toThrow(/fetch failed/);
    expect(site.hits).toEqual([]);
  });

  it("FAILS when a proxy is required but the pool hands back none", async () => {
    const site = await website();
    const { undici, calls } = fakeUndici(() => ({ status: 200, body: "x" }));
    const fetcher = new ProxyHttpFetcher({ next: () => null }, { requireProxy: true, loadUndici: async () => undici, lookup, isAllowedAddress: allowLoopback });
    await expect(fetcher.get(`http://site.test:${site.port}/page`)).rejects.toBeInstanceOf(ProxyUnavailableError);
    expect(calls).toEqual([]);
    expect(site.hits).toEqual([]);
  });

  it("rotates through the pool, reusing one agent per proxy", async () => {
    const { undici, calls, agents } = fakeUndici(() => ({ status: 200, body: "ok" }));
    const pool = ["http://p1.test:1", "http://p2.test:2"];
    const fetcher = new ProxyHttpFetcher(staticProxyPool(pool), { loadUndici: async () => undici, lookup, isAllowedAddress: allowLoopback });
    for (let i = 0; i < 4; i++) await fetcher.get("http://site.test/");
    expect(calls.map((c) => (c.init.dispatcher as { uri: string }).uri)).toEqual([pool[0], pool[1], pool[0], pool[1]]);
    expect(agents).toEqual(pool); // constructed once each
  });

  it("still applies the outbound guard: a private target is refused before the proxy is asked", async () => {
    const { undici, calls } = fakeUndici(() => ({ status: 200, body: "metadata" }));
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { loadUndici: async () => undici });
    await expect(fetcher.get("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(fetcher.get("http://localhost:8787/admin")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(calls).toEqual([]);
  });

  it("follows redirects hop by hop through the proxy and refuses a hop to a private address", async () => {
    const { undici, calls } = fakeUndici((url) => {
      if (url.endsWith("/a")) return { status: 302, headers: { location: "/b" } };
      if (url.endsWith("/b")) return { status: 302, headers: { location: "http://10.0.0.9/internal" } };
      return { status: 200, body: "internal page" };
    });
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { loadUndici: async () => undici, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    await expect(fetcher.get("https://public.example.com/a")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(calls.map((c) => c.url)).toEqual(["https://public.example.com/a", "https://public.example.com/b"]); // never 10.0.0.9
  });

  it("caps the page body and skips binary content", async () => {
    const { undici } = fakeUndici((url) =>
      url.endsWith(".png") ? { status: 200, headers: { "content-type": "image/png" }, body: "PNGDATA".repeat(100) } : { status: 200, headers: { "content-type": "text/html" }, body: "x".repeat(10_000) },
    );
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { loadUndici: async () => undici, lookup: async () => [{ address: "93.184.216.34", family: 4 }], maxBodyBytes: 500 });
    const page = await fetcher.get("https://public.example.com/page");
    expect(page.html).toHaveLength(500);
    expect(page.truncated).toBe(true);
    expect((await fetcher.get("https://public.example.com/logo.png")).html).toBe("");
  });
});

describe("ProxyHttpFetcher — no proxy configured", () => {
  it("connects directly (guarded), and reports where redirects ended", async () => {
    const site = await website((req, res) => {
      if (req.url === "/old") return void res.writeHead(301, { location: "/new" }).end();
      res.writeHead(200, { "content-type": "text/html" }).end("<html>direct</html>");
    });
    let loads = 0;
    const fetcher = new ProxyHttpFetcher(staticProxyPool([]), { lookup, isAllowedAddress: allowLoopback, loadUndici: async () => (loads++, {} as UndiciModule) });
    const r = await fetcher.get(`http://site.test:${site.port}/old`);
    expect(r).toMatchObject({ status: 200, html: "<html>direct</html>", url: `http://site.test:${site.port}/old`, finalUrl: `http://site.test:${site.port}/new` });
    expect(site.hits).toEqual(["/old", "/new"]);
    expect(loads).toBe(0); // the proxy client is not even loaded
  });

  it("is still guarded: private targets are refused with no proxy too", async () => {
    const site = await website();
    const fetcher = new ProxyHttpFetcher(staticProxyPool([]));
    await expect(fetcher.get(`http://127.0.0.1:${site.port}/`)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(site.hits).toEqual([]);
  });
});

describe("FetchRedirectResolver — resolves THROUGH the page fetcher", () => {
  it("uses the proxy path (no direct request) and reports the final host", async () => {
    const site = await website();
    const { undici, calls } = fakeUndici((url) => (url.includes("/go") ? { status: 302, headers: { location: "https://www.competitor.com/product/1" } } : { status: 200, body: "<html>landing page that must not be downloaded</html>" }));
    const fetcher = new ProxyHttpFetcher(staticProxyPool([PROXY]), { requireProxy: true, loadUndici: async () => undici, lookup, isAllowedAddress: allowLoopback });
    const resolved = await new FetchRedirectResolver({ via: fetcher }).resolve(`http://site.test:${site.port}/go?ref=abc`);
    expect(resolved).toEqual({ finalUrl: "https://www.competitor.com/product/1", finalHost: "competitor.com" });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.init.dispatcher != null)).toBe(true);
    expect(site.hits).toEqual([]); // the old resolver always connected directly
  });

  it("returns null (never a guess) when the proxy path is unavailable or a hop is unsafe", async () => {
    const site = await website();
    const down = new ProxyHttpFetcher(staticProxyPool([PROXY]), { requireProxy: true, loadUndici: async () => { throw new Error("no undici"); }, lookup, isAllowedAddress: allowLoopback });
    expect(await new FetchRedirectResolver({ via: down }).resolve(`http://site.test:${site.port}/go`)).toBeNull();

    const { undici } = fakeUndici(() => ({ status: 302, headers: { location: "http://169.254.169.254/latest/" } }));
    const bouncing = new ProxyHttpFetcher(staticProxyPool([PROXY]), { loadUndici: async () => undici, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    expect(await new FetchRedirectResolver({ via: bouncing }).resolve("https://public.example.com/go")).toBeNull();
    expect(site.hits).toEqual([]);
  });
});
