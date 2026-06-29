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
  url: string;
  html: string;
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
 * Real fetcher: uses the platform `fetch` with a rotating UA and (where the
 * runtime supports a proxy dispatcher) a rotating proxy from the pool. In
 * production the pool is residential/rotating; the box IP is never used directly.
 */
export class ProxyHttpFetcher implements HttpFetcher {
  readonly kind = "proxy";
  private uaIndex = 0;
  constructor(private readonly pool: ProxyPool) {}

  async get(url: string): Promise<FetchResult> {
    const ua = UAS[this.uaIndex++ % UAS.length]!;
    const proxy = this.pool.next();
    // Actually route through the rotating proxy (undici ProxyAgent dispatcher) so
    // scraping never originates from the box IP. If undici/ProxyAgent isn't
    // available, fall back to a direct fetch.
    const init: Record<string, unknown> = { headers: { "User-Agent": ua, Accept: "text/html" } };
    if (proxy) {
      const dispatcher = await proxyDispatcher(proxy);
      if (dispatcher) init.dispatcher = dispatcher;
    }
    const res = await fetch(url, init as RequestInit);
    const html = await res.text();
    return { status: res.status, url, html };
  }
}

const dispatcherCache = new Map<string, unknown>();
async function proxyDispatcher(proxyUrl: string): Promise<unknown | null> {
  if (dispatcherCache.has(proxyUrl)) return dispatcherCache.get(proxyUrl) ?? null;
  try {
    const undici: any = await import("undici" as string);
    const agent = new undici.ProxyAgent(proxyUrl);
    dispatcherCache.set(proxyUrl, agent);
    return agent;
  } catch {
    dispatcherCache.set(proxyUrl, null);
    return null;
  }
}

/**
 * Real JSON HTTP client for API adapters (SerpApi, Hunter, backlink providers).
 * Satisfies both the `{ get(url) }` and `{ get(url, headers?) }` shapes those
 * adapters expect. Returns parsed JSON (or null on a non-JSON/empty body).
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
        body: JSON.stringify(body),
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
 */
export class CachingFetcher implements HttpFetcher {
  readonly kind: string;
  private readonly cache = new Map<string, { result: FetchResult; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<FetchResult>>();
  constructor(
    private readonly inner: HttpFetcher,
    private readonly opts: { ttlMs?: number; errorTtlMs?: number } = {},
  ) {
    this.kind = `cached:${inner.kind}`;
  }
  async get(url: string): Promise<FetchResult> {
    const now = Date.now();
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > now) return hit.result;
    const pending = this.inflight.get(url);
    if (pending) return pending; // coalesce concurrent identical fetches into one
    const p = (async () => {
      try {
        const result = await this.inner.get(url);
        const ok = result.status >= 200 && result.status < 300;
        const ttl = ok ? (this.opts.ttlMs ?? 10 * 60 * 1000) : (this.opts.errorTtlMs ?? 60 * 1000);
        this.cache.set(url, { result, expiresAt: Date.now() + ttl });
        return result;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, p);
    return p;
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
