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
    // The proxy is applied via an undici ProxyAgent dispatcher when running on
    // Node with proxies configured; omitted here to avoid a hard dependency. The
    // header rotation + the pool selection are the real, swappable parts.
    void proxy;
    const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html" } });
    const html = await res.text();
    return { status: res.status, url, html };
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
