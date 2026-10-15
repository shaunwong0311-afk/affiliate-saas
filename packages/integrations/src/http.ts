import { guardedFetch, type GuardPolicy, type GuardedFetchOptions, type GuardedResponse, type GuardedTransport } from "./net-guard.js";

/**
 * HTTP fetch abstraction for scraping (Section 8.1 / Section 11 ops rule).
 *
 * Scraping MUST go through rotating/residential proxies, never the origin box IP —
 * datacenter IPs get blocked fast. That decision lives entirely behind this port:
 * pass a `ProxyHttpFetcher` configured with a proxy pool in production, or the
 * `DeterministicFetcher` (no network) in dev/test. The discovery sources don't know
 * or care which is wired.
 */
export interface FetchResult {
  status: number;
  /** The URL that was requested. */
  url: string;
  html: string;
  /** Where the request ended up after redirects, when the fetcher knows it. */
  finalUrl?: string;
  /** True when the body was cut at the fetcher's size cap. */
  truncated?: boolean;
}

export interface HttpFetcher {
  readonly kind: string;
  /** Fetch a page's HTML (following the configured proxy/UA rotation). */
  get(url: string): Promise<FetchResult>;
}

/** Picks the next proxy from a pool (round-robin); empty pool = direct (dev only). */
export interface ProxyPool {
  next(): string | null;
}

export function staticProxyPool(proxies: string[]): ProxyPool {
  let i = 0;
  return {
    next() {
      if (proxies.length === 0) return null;
      const p = proxies[i % proxies.length]!;
      i += 1;
      return p;
    },
  };
}

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];

/**
 * Thrown when a proxy is configured but a request cannot be sent THROUGH it (the proxy
 * client is not installed, the proxy URL is unusable, the pool is empty). The request is
 * not attempted any other way: scraping from the box's own IP is the failure this rule
 * exists to prevent, so "no proxy path" means "no fetch", never "go direct".
 */
export class ProxyUnavailableError extends Error {
  readonly code = "proxy_unavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyUnavailableError";
  }
}

/** The slice of the `undici` package the proxy path uses (its own fetch + its own ProxyAgent). */
export interface UndiciModule {
  fetch(url: string, init: Record<string, unknown>): Promise<{
    status: number;
    headers: { forEach(cb: (value: string, key: string) => void): void };
    body: ReadableStream<Uint8Array> | null;
  }>;
  ProxyAgent: new (uri: string) => unknown;
}

export interface ProxyHttpFetcherOptions extends GuardPolicy {
  /**
   * A proxy is REQUIRED: a request with no proxy to go through fails. Set whenever
   * PROXY_URL is configured, so an exhausted/misbehaving pool can never mean "direct".
   */
  requireProxy?: boolean;
  /** Deadline per fetch, redirects included. Default 15 s. */
  timeoutMs?: number;
  /** Bytes of page body kept. Default 2 MB. */
  maxBodyBytes?: number;
  maxRedirects?: number;
  /**
   * Loads the proxy-capable HTTP client. Default: a dynamic `import("undici")` (kept
   * dynamic so the package loads without it when no proxy is used). Injected in tests.
   */
  loadUndici?: () => Promise<UndiciModule>;
}

// Types we never want to pull down as "a page": media, fonts, archives, documents.
const BINARY_CONTENT = /^\s*((image|video|audio|font)\/|application\/(pdf|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|octet-stream|msword|wasm|vnd\.))/i;
function isReadableContent(contentType: string | null): boolean {
  return contentType == null || !BINARY_CONTENT.test(contentType);
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - size;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * The real page fetcher. Every request is a {@link guardedFetch} — public destinations
 * only, redirects re-checked hop by hop, one deadline, a body cap — sent with a rotating
 * UA and:
 *
 *  - THROUGH a rotating proxy when the pool has one, using the `undici` package's own
 *    `fetch` together with its own `ProxyAgent` (never an npm-undici dispatcher handed to
 *    Node's built-in fetch — the two are different undici copies and need not agree);
 *  - or directly from this machine when NO proxy is configured (dev, or a deployment
 *    that has deliberately not set PROXY_URL).
 *
 * It FAILS CLOSED: with a proxy configured, a request that cannot go through it throws
 * {@link ProxyUnavailableError}. There is no fallback to a direct connection.
 */
export class ProxyHttpFetcher implements HttpFetcher {
  readonly kind = "proxy";
  private uaIndex = 0;
  private readonly agents = new Map<string, unknown>();
  private undici: Promise<UndiciModule> | null = null;
  constructor(
    private readonly pool: ProxyPool,
    private readonly opts: ProxyHttpFetcherOptions = {},
  ) {}

  async get(url: string): Promise<FetchResult> {
    const r = await this.request(url, { acceptContentType: isReadableContent });
    return { status: r.status, url, html: r.body, finalUrl: r.url, truncated: r.truncated };
  }

  /**
   * Follow a URL's redirects — same guard, same proxy rule — WITHOUT downloading the
   * page it lands on. This is what "where does this link point?" needs.
   */
  async follow(url: string): Promise<{ status: number; finalUrl: string }> {
    const r = await this.request(url, { discardBody: true });
    return { status: r.status, finalUrl: r.url };
  }

  private async request(url: string, extra: Pick<GuardedFetchOptions, "acceptContentType" | "discardBody">): Promise<GuardedResponse> {
    const ua = UAS[this.uaIndex++ % UAS.length]!;
    const proxy = this.pool.next();
    if (!proxy && this.opts.requireProxy) {
      throw new ProxyUnavailableError("a proxy is required for this fetch but the proxy pool returned none — refusing to connect directly");
    }
    // With a proxy, EVERY hop goes through it (or this throws). Without one, the guard's
    // default transport connects directly, pinned to the address it vetted.
    const transport = proxy ? await this.proxyTransport(proxy) : undefined;
    return guardedFetch(url, {
      lookup: this.opts.lookup,
      isAllowedAddress: this.opts.isAllowedAddress,
      timeoutMs: this.opts.timeoutMs,
      maxBodyBytes: this.opts.maxBodyBytes,
      maxRedirects: this.opts.maxRedirects,
      headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      transport,
      ...extra,
    });
  }

  private loadUndici(): Promise<UndiciModule> {
    if (!this.undici) {
      const load = this.opts.loadUndici ?? (() => import("undici" as string) as Promise<UndiciModule>);
      this.undici = Promise.resolve()
        .then(load)
        .then((m) => {
          if (typeof m?.fetch !== "function" || typeof m?.ProxyAgent !== "function") {
            throw new Error("the loaded module has no fetch/ProxyAgent");
          }
          return m;
        })
        .catch((err) => {
          this.undici = null; // not cached: a later install can succeed
          throw new ProxyUnavailableError(
            "PROXY_URL is set but the proxy client (the `undici` package) could not be loaded — refusing to fetch without the proxy. Install it: npm install undici",
            { cause: err },
          );
        });
    }
    return this.undici;
  }

  private async proxyTransport(proxyUrl: string): Promise<GuardedTransport> {
    const undici = await this.loadUndici();
    let agent = this.agents.get(proxyUrl);
    if (!agent) {
      try {
        // undici reads `user:pass@` from the proxy URL and sends Proxy-Authorization itself.
        agent = new undici.ProxyAgent(proxyUrl);
      } catch (err) {
        throw new ProxyUnavailableError("the configured proxy URL could not be used — refusing to fetch without the proxy", { cause: err });
      }
      this.agents.set(proxyUrl, agent);
    }
    // The proxy resolves the target's DNS, so the vetted addresses cannot be pinned here;
    // the guard has still screened the URL and checked what the name resolves to from
    // this machine, and it re-checks every redirect because we never let undici follow one.
    return async (hop) => {
      const res = await undici.fetch(hop.url.toString(), {
        method: hop.method,
        headers: hop.headers,
        body: hop.body,
        redirect: "manual",
        signal: hop.signal,
        dispatcher: agent,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      if (!hop.wantBody(res.status, headers)) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, headers, body: "", truncated: false };
      }
      const { text, truncated } = await readCapped(res.body, hop.maxBodyBytes);
      return { status: res.status, headers, body: text, truncated };
    };
  }
}

/**
 * A provider API answered "no" — a rejected key, an exhausted quota, a missing
 * subscription, a malformed request — as opposed to answering with zero results. Every
 * adapter throws this instead of returning an empty list, because the two look identical
 * downstream and only one of them means "there is nothing to find".
 */
export class ProviderError extends Error {
  /** `auth` = the credentials/subscription are the problem; `quota` = retry later; `error` = anything else. */
  readonly kind: "auth" | "quota" | "error";
  constructor(
    readonly provider: string,
    /** HTTP status of the response (0 when the failure was provider-level inside a 200). */
    readonly status: number,
    readonly detail: string,
    kind?: "auth" | "quota" | "error",
  ) {
    super(`${provider}: ${detail}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ProviderError";
    this.kind = kind ?? (status === 401 || status === 403 ? "auth" : status === 402 || status === 429 ? "quota" : "error");
  }
}

/**
 * Throw a {@link ProviderError} unless the response is HTTP 2xx. `detail` pulls the
 * provider's own message out of the body when it has one.
 */
export function assertProviderOk(provider: string, res: { status: number; json: any }, detail?: (json: any) => unknown): void {
  if (res.status >= 200 && res.status < 300) return;
  let message: unknown;
  try {
    message = detail?.(res.json);
  } catch {
    message = undefined;
  }
  throw new ProviderError(provider, res.status, typeof message === "string" && message ? message.slice(0, 300) : "request rejected");
}

/**
 * Real JSON HTTP client for API adapters (SerpApi, Hunter, backlink providers).
 * Satisfies both the `{ get(url) }` and `{ get(url, headers?) }` shapes those
 * adapters expect. Returns parsed JSON (or null on a non-JSON/empty body). It talks to
 * FIXED provider endpoints chosen by the operator's configuration, so it is not routed
 * through the outbound guard — never hand it a URL that came from a page or a tenant.
 */
export class FetchJsonClient {
  readonly kind = "fetch-json";
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}
  async get(url: string, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  async post(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        // A string body is sent as-is (raw MIME / form payloads); objects are JSON-encoded.
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal: controller.signal,
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }
}

/** Dev/test fetcher: returns a deterministic page so discovery runs with no network. */
export class DeterministicFetcher implements HttpFetcher {
  readonly kind = "deterministic";
  constructor(private readonly pages: Map<string, string> = new Map()) {}
  async get(url: string): Promise<FetchResult> {
    const html = this.pages.get(url) ?? `<html><body><a href="${url}">self</a></body></html>`;
    return { status: 200, url, html };
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Caches fetch results — and the in-flight promise, so concurrent callers for the
 * same URL share ONE network request — for a TTL. This is the single biggest
 * waste-cut in discovery: the competitor-program resolver, the recursive frontier,
 * and the enrich step all fetch the same homepages, so without this each page is
 * pulled two or three times per cycle. Mirrors {@link CachingEnricher}. Non-2xx
 * results get a SHORTER ttl so a transiently-down host is retried sooner than a good
 * page is needlessly re-fetched. Put this OUTERMOST (above rate-limiting) so a cache
 * hit skips the throttle entirely.
 *
 * BOUNDED: expired entries are swept, and the cache holds at most `maxEntries` pages
 * and `maxBytes` of body text — the least-recently-used go first. (It runs for the life
 * of the worker; an unbounded map of whole pages is a slow leak.)
 */
export class CachingFetcher implements HttpFetcher {
  readonly kind: string;
  private readonly cache = new Map<string, { result: FetchResult; expiresAt: number; size: number }>();
  private readonly inflight = new Map<string, Promise<FetchResult>>();
  private bytes = 0;
  private lastSweep = 0;
  constructor(
    private readonly inner: HttpFetcher,
    private readonly opts: { ttlMs?: number; errorTtlMs?: number; maxEntries?: number; maxBytes?: number } = {},
  ) {
    this.kind = `cached:${inner.kind}`;
  }

  /** Entries currently held (for monitoring/tests). */
  get size(): number {
    return this.cache.size;
  }

  async get(url: string): Promise<FetchResult> {
    const now = Date.now();
    const hit = this.cache.get(url);
    if (hit) {
      if (hit.expiresAt > now) {
        // Refresh recency: Map iteration order is insertion order, so re-inserting makes
        // this the newest entry and eviction takes the least-recently-used first.
        this.cache.delete(url);
        this.cache.set(url, hit);
        return hit.result;
      }
      this.remove(url);
    }
    const pending = this.inflight.get(url);
    if (pending) return pending; // coalesce concurrent identical fetches into one
    const p = (async () => {
      try {
        const result = await this.inner.get(url);
        const ok = result.status >= 200 && result.status < 300;
        const ttl = ok ? (this.opts.ttlMs ?? 10 * 60 * 1000) : (this.opts.errorTtlMs ?? 60 * 1000);
        this.store(url, result, ttl);
        return result;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, p);
    return p;
  }

  private remove(url: string): void {
    const entry = this.cache.get(url);
    if (!entry) return;
    this.bytes -= entry.size;
    this.cache.delete(url);
  }

  private store(url: string, result: FetchResult, ttl: number): void {
    const now = Date.now();
    const maxEntries = this.opts.maxEntries ?? 500;
    const maxBytes = this.opts.maxBytes ?? 64 * 1024 * 1024;
    const size = result.html.length + url.length;
    this.remove(url);
    // Sweep everything that has expired — at most once per TTL, so a busy cache does not
    // rescan itself on every write.
    const sweepEvery = Math.min(this.opts.ttlMs ?? 10 * 60 * 1000, 60 * 1000);
    if (now - this.lastSweep >= sweepEvery) {
      this.lastSweep = now;
      for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.remove(key);
    }
    if (size > maxBytes) return; // a single page larger than the whole budget is not cached
    this.cache.set(url, { result, expiresAt: now + ttl, size });
    this.bytes += size;
    for (const key of this.cache.keys()) {
      if (this.cache.size <= maxEntries && this.bytes <= maxBytes) break;
      this.remove(key); // oldest (least recently used) first
    }
  }
}

/**
 * Politeness layer: enforces a per-host minimum interval between requests AND a
 * global concurrency cap, so discovery doesn't hammer a single site (ban risk +
 * Section 11 etiquette) or open hundreds of sockets at once. The per-host gap is
 * RESERVED before awaiting, so several concurrent requests to one host queue up and
 * space out instead of all reading the same "last hit" time. Wrap this around the
 * real network fetcher; keep the cache ABOVE it so cache hits aren't throttled.
 */
export class RateLimitedFetcher implements HttpFetcher {
  readonly kind: string;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly nextAllowedByHost = new Map<string, number>();
  constructor(
    private readonly inner: HttpFetcher,
    private readonly opts: { maxConcurrent?: number; perHostIntervalMs?: number } = {},
  ) {
    this.kind = `ratelimited:${inner.kind}`;
  }

  private acquire(): Promise<void> {
    const max = this.opts.maxConcurrent ?? 6;
    if (this.active < max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  async get(url: string): Promise<FetchResult> {
    // 1) Per-host spacing — reserve our slot up front so concurrent same-host calls
    //    stack rather than collide, WITHOUT holding a concurrency slot while we wait.
    const interval = this.opts.perHostIntervalMs ?? 0;
    const host = hostOf(url);
    if (host && interval > 0) {
      const now = Date.now();
      const scheduled = Math.max(now, this.nextAllowedByHost.get(host) ?? 0);
      this.nextAllowedByHost.set(host, scheduled + interval);
      // A host whose slot is already in the past needs no bookkeeping — forget it, so the
      // map tracks only hosts being actively throttled rather than every host ever seen.
      if (this.nextAllowedByHost.size > 2000) {
        for (const [h, t] of this.nextAllowedByHost) if (t <= now) this.nextAllowedByHost.delete(h);
      }
      const wait = scheduled - now;
      if (wait > 0) await delay(wait);
    }
    // 2) Global concurrency gate.
    await this.acquire();
    try {
      return await this.inner.get(url);
    } finally {
      this.release();
    }
  }
}
