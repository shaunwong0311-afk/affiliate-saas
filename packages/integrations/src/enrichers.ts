import type { AccountEnricher, AccountMetrics } from "./ports.js";
import type { HttpFetcher } from "./http.js";

/**
 * Per-platform account enrichers (profile-graph Phase 2). Each fills reach +
 * engagement from the CHEAPEST source for its platform — a free API (YouTube), an
 * on-page fetch (Substack), or a scraping-API actor (Instagram/TikTok/X). Public
 * counts only; audience demographics are a later, paid add. Real adapters are
 * key-gated; with no key/HTTP they return null (unknown), never invented numbers.
 */

interface JsonHttp {
  get(url: string): Promise<{ status: number; json: any }>;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * YouTube — FREE via the Data API. channels.list gives subscriberCount + country;
 * recent uploads' videos.list gives likes/comments/views → a real engagement rate.
 * ~3 quota units per creator. Resolves by @handle (forHandle) or UC… id.
 */
export class YouTubeEnricher implements AccountEnricher {
  readonly kind = "youtube-api";
  constructor(private readonly opts: { apiKey: string; http: JsonHttp }) {}
  supports(platform: string): boolean {
    return platform === "youtube";
  }
  async enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null> {
    const sel = account.handle?.startsWith("@")
      ? `forHandle=${encodeURIComponent(account.handle)}`
      : account.handle?.startsWith("UC")
        ? `id=${encodeURIComponent(account.handle)}`
        : null;
    if (!sel) return null;
    const base = "https://www.googleapis.com/youtube/v3";
    const ch = await this.opts.http.get(`${base}/channels?part=snippet,statistics,contentDetails&${sel}&key=${this.opts.apiKey}`);
    const item = ch.json?.items?.[0];
    if (!item) return null;
    const reach = numOrNull(item.statistics?.subscriberCount);
    const primaryGeo = item.snippet?.country ?? null;
    const language = item.snippet?.defaultLanguage ?? null;

    let engagementRate: number | null = null;
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      const pl = await this.opts.http.get(`${base}/playlistItems?part=contentDetails&playlistId=${uploads}&maxResults=10&key=${this.opts.apiKey}`);
      const ids: string[] = (pl.json?.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
      if (ids.length) {
        const vs = await this.opts.http.get(`${base}/videos?part=statistics&id=${ids.join(",")}&key=${this.opts.apiKey}`);
        const rates: number[] = (vs.json?.items ?? [])
          .map((v: any) => {
            const views = Number(v.statistics?.viewCount ?? 0);
            const eng = Number(v.statistics?.likeCount ?? 0) + Number(v.statistics?.commentCount ?? 0);
            return views > 0 ? eng / views : null;
          })
          .filter((x: number | null): x is number => x != null);
        if (rates.length) engagementRate = rates.reduce((a: number, b: number) => a + b, 0) / rates.length;
      }
    }
    return { reach, engagementRate, primaryGeo, language, source: "api" };
  }
}

/**
 * Instagram / TikTok / X — public follower count + recent-post engagement via a
 * scraping-API actor (Apify/ScrapingBee-style). Real-shaped skeleton: it calls a
 * configurable actor endpoint and normalizes the result. No demographics. Without an
 * endpoint/key wired it returns null (honest) rather than inventing numbers.
 */
export class ScrapeMetricsEnricher implements AccountEnricher {
  readonly kind = "scrape-api";
  constructor(private readonly opts: { endpoint?: string; apiKey?: string; http?: JsonHttp } = {}) {}
  supports(platform: string): boolean {
    return platform === "instagram" || platform === "tiktok" || platform === "twitter";
  }
  async enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null> {
    if (!this.opts.endpoint || !this.opts.http) return null; // not wired → unknown, not invented
    const res = await this.opts.http.get(
      `${this.opts.endpoint}?platform=${account.platform}&handle=${encodeURIComponent(account.handle ?? "")}&url=${encodeURIComponent(account.url)}${this.opts.apiKey ? `&token=${this.opts.apiKey}` : ""}`,
    );
    const d = res.json?.data ?? res.json;
    if (!d) return null;
    // Normalize common actor field names.
    const reach = numOrNull(d.followers ?? d.followerCount ?? d.subscribers);
    const engagementRate = numOrNull(d.engagementRate ?? d.engagement_rate);
    if (reach == null && engagementRate == null) return null;
    return { reach, engagementRate, primaryGeo: d.country ?? null, language: d.language ?? null, source: "scrape" };
  }
}

/** Substack / newsletters — many pages print "N subscribers"; read it for free. */
export class OnPageSubscriberEnricher implements AccountEnricher {
  readonly kind = "on-page";
  constructor(private readonly fetcher: HttpFetcher) {}
  supports(platform: string): boolean {
    return platform === "substack" || platform === "beehiiv";
  }
  async enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null> {
    let html: string;
    try {
      const r = await this.fetcher.get(account.url);
      if (r.status < 200 || r.status >= 300 || !r.html) return null;
      html = r.html;
    } catch {
      return null;
    }
    const m = html.match(/([\d][\d,. ]*)\s*(?:subscribers|readers|members)/i);
    if (!m) return null;
    const reach = numOrNull(m[1]!.replace(/[,\s]/g, "").replace(/\.$/, ""));
    if (reach == null) return null;
    return { reach, engagementRate: null, primaryGeo: null, language: null, source: "page" };
  }
}

/** Routes an account to the first enricher that supports its platform. */
export class EnricherRegistry implements AccountEnricher {
  readonly kind = "registry";
  constructor(private readonly enrichers: AccountEnricher[]) {}
  supports(platform: string): boolean {
    return this.enrichers.some((e) => e.supports(platform));
  }
  async enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null> {
    for (const e of this.enrichers) {
      if (!e.supports(account.platform)) continue;
      const m = await e.enrich(account).catch(() => null);
      if (m && (m.reach != null || m.engagementRate != null)) return m;
    }
    return null;
  }
}
