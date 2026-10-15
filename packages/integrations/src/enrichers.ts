import type { AccountEnricher, AccountMetrics } from "./ports.js";
import { assertProviderOk, type HttpFetcher } from "./http.js";
import { assertYouTubeOk } from "./discovery-real.js";

/**
 * Per-platform account enrichers (profile-graph Phase 2). Each fills reach +
 * engagement from the CHEAPEST source for its platform — a free API (YouTube), an
 * on-page fetch (Substack), or a scraping-API actor (Instagram/TikTok/X). Public
 * counts only; audience demographics are a later, paid add. Real adapters are
 * key-gated; with no key/HTTP they return null (unknown), never invented numbers.
 *
 * Two rules every adapter here follows:
 *  - a value the provider did not report stays `null`. It is never coerced to 0 — a
 *    missing follower count is "unknown", and 0 would score as "nobody follows them".
 *  - a provider that answers with an ERROR (bad key, quota, outage) makes the adapter
 *    THROW. Returning null there would be cached as "this account has no data" for a day.
 */

interface JsonHttp {
  get(url: string): Promise<{ status: number; json: any }>;
}

/**
 * A finite number from a provider field, else null. `Number(null)` and `Number("")` are
 * both 0, so absent/blank values are rejected explicitly rather than converted.
 */
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** A count: a non-negative number, else null. */
function countOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n != null && n >= 0 ? n : null;
}

// Scrape actors report geo/language inconsistently ("United States", "English", or an
// ISO code). audienceOverlapScore expects ISO 3166-1 alpha-2 / ISO 639-1, so an
// un-normalized name scores as a MISMATCH (a fake penalty) instead of honest "unknown".
// Normalize the frequent names; anything we can't confidently map stays null (never faked).
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US", america: "US",
  canada: "CA", "united kingdom": "GB", uk: "GB", "great britain": "GB", britain: "GB", england: "GB",
  australia: "AU", "new zealand": "NZ", germany: "DE", france: "FR", spain: "ES", italy: "IT",
  netherlands: "NL", ireland: "IE", belgium: "BE", austria: "AT", portugal: "PT", finland: "FI",
  greece: "GR", sweden: "SE", norway: "NO", denmark: "DK", switzerland: "CH", poland: "PL",
  japan: "JP", brazil: "BR", mexico: "MX", india: "IN", singapore: "SG", china: "CN",
  "south korea": "KR", korea: "KR", indonesia: "ID", philippines: "PH", "south africa": "ZA",
};
const LANG_NAME_TO_ISO: Record<string, string> = {
  english: "en", spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt",
  dutch: "nl", japanese: "ja", chinese: "zh", mandarin: "zh", korean: "ko", russian: "ru",
  arabic: "ar", hindi: "hi", turkish: "tr", polish: "pl", swedish: "sv", indonesian: "id",
};

/** Normalize a country value to ISO 3166-1 alpha-2, or null when it can't be mapped. */
function normalizeGeo(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase(); // already an alpha-2 code
  return COUNTRY_NAME_TO_ISO[s.toLowerCase()] ?? null; // unknown → null, not a fake mismatch
}

/** Normalize a language value to ISO 639-1 (2-letter), or null when it can't be mapped. */
function normalizeLang(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^[a-zA-Z]{2}(-|$)/.test(s)) return s.slice(0, 2).toLowerCase(); // "en" / "en-US"
  return LANG_NAME_TO_ISO[s.toLowerCase()] ?? null;
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
    // A 403 quotaExceeded / invalid key has no `items` either — it must not be mistaken
    // for "no such channel" (which would then be cached for a day).
    assertYouTubeOk(ch);
    const item = ch.json?.items?.[0];
    if (!item) return null;
    // A channel can hide its subscriber count; the API then reports a meaningless figure.
    const reach = item.statistics?.hiddenSubscriberCount === true ? null : countOrNull(item.statistics?.subscriberCount);
    const primaryGeo = item.snippet?.country ?? null;
    const language = item.snippet?.defaultLanguage ?? null;
    // The same channel is addressable by id and by handle; report both so a back-link
    // written either way is recognized. (`customUrl` is the handle, e.g. "@creator".)
    const aliases: string[] = [];
    if (typeof item.id === "string" && item.id) aliases.push(`https://www.youtube.com/channel/${item.id}`);
    if (typeof item.snippet?.customUrl === "string" && item.snippet.customUrl.startsWith("@")) aliases.push(`https://www.youtube.com/${item.snippet.customUrl}`);
    // The channel DESCRIPTION is where creators put "Business: x@y.com" + their website.
    // YouTube's About-page email is captcha-gated, but the description comes free in this
    // same API call — the key to making website-less YouTube creators contactable.
    const description: string = item.snippet?.description ?? "";
    const emails = [...description.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0].toLowerCase());
    const links = [...description.matchAll(/https?:\/\/[^\s)>\]]+/gi)].map((m) => m[0]);

    let engagementRate: number | null = null;
    let lastContentAt: string | null = null;
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      const pl = await this.opts.http.get(`${base}/playlistItems?part=contentDetails&playlistId=${uploads}&maxResults=10&key=${this.opts.apiKey}`);
      assertYouTubeOk(pl);
      // contentDetails carries videoPublishedAt — the most recent upload = the channel's freshness.
      const dates: number[] = (pl.json?.items ?? []).map((i: any) => new Date(i.contentDetails?.videoPublishedAt ?? "").getTime()).filter((t: number) => !Number.isNaN(t));
      if (dates.length) lastContentAt = new Date(Math.max(...dates)).toISOString();
      const ids: string[] = (pl.json?.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
      if (ids.length) {
        const vs = await this.opts.http.get(`${base}/videos?part=statistics&id=${ids.join(",")}&key=${this.opts.apiKey}`);
        assertYouTubeOk(vs);
        const rates: number[] = (vs.json?.items ?? [])
          .map((v: any) => {
            // Views and likes must both be REPORTED. A creator can hide like counts (the
            // field is then absent); treating that as 0 likes would understate engagement,
            // so such a video is left out of the average instead. Comments switched off is
            // genuinely zero comments.
            const views = countOrNull(v.statistics?.viewCount);
            const likes = countOrNull(v.statistics?.likeCount);
            if (views == null || views === 0 || likes == null) return null;
            return (likes + (countOrNull(v.statistics?.commentCount) ?? 0)) / views;
          })
          .filter((x: number | null): x is number => x != null);
        if (rates.length) engagementRate = rates.reduce((a: number, b: number) => a + b, 0) / rates.length;
      }
    }
    return {
      reach,
      engagementRate,
      primaryGeo,
      language,
      source: "api",
      lastContentAt,
      emails: emails.length ? [...new Set(emails)] : undefined,
      links: links.length ? [...new Set(links)] : undefined,
      aliases: aliases.length ? aliases : undefined,
    };
  }
}

/**
 * Instagram / TikTok / X — public follower count + recent-post engagement via a
 * scraping-API actor (Apify/ScrapingBee-style). Real-shaped skeleton: it calls a
 * configurable actor endpoint and normalizes the result. No demographics. Without an
 * endpoint/key wired it returns null (honest) rather than inventing numbers.
 *
 * UNVALIDATED request contract (AUDIT-2026-10 D16). No vendor is pinned: the call —
 * `GET <endpoint>?platform=…&handle=…&url=…&token=…` answered with `{data: {followers,
 * engagementRate, country, language}}` — is this codebase's OWN convention. Every real
 * vendor differs in path, auth header and field names, so expect a thin adapter (or a
 * proxy endpoint that speaks this shape) before the first real run. What is handled
 * blind: a non-2xx answer throws; an absent field stays null; and an `engagementRate`
 * outside 0..1 is treated as UNKNOWN — it is probably a percentage (3.2 meaning 3.2%),
 * but dividing by 100 on a hunch would be inventing a number, so it is dropped until
 * the vendor's unit is known.
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
    assertProviderOk("scrape-api", res, (j) => j?.error?.message ?? j?.error ?? j?.message);
    const d = res.json?.data ?? res.json;
    if (!d || typeof d !== "object") return null;
    // Normalize common actor field names.
    const reach = countOrNull(d.followers ?? d.followerCount ?? d.subscribers);
    const rawRate = numOrNull(d.engagementRate ?? d.engagement_rate);
    const engagementRate = rawRate != null && rawRate >= 0 && rawRate <= 1 ? rawRate : null;
    if (reach == null && engagementRate == null) return null;
    // Normalize geo/language to ISO so audienceOverlapScore compares like-for-like — an
    // un-mappable value stays null (honest unknown) rather than scoring as a fake mismatch.
    return { reach, engagementRate, primaryGeo: normalizeGeo(d.country), language: normalizeLang(d.language), source: "scrape" };
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

/** True when a metrics result carries ANY real signal (audience OR a contact path). */
function metricsHaveData(m: AccountMetrics): boolean {
  return m.reach != null || m.engagementRate != null || (m.emails?.length ?? 0) > 0 || (m.links?.length ?? 0) > 0;
}

/**
 * Caches enricher results (including genuine misses) by platform+handle for a TTL, so
 * the same creator — seen across merchants or re-runs — is only paid for once per
 * window. The single biggest credit saver once merchant niches overlap.
 *
 * A genuine null ("this account exposes no data") caches normally. A TRANSPORT ERROR
 * (the inner enricher THREW — API down, rate-limited, network blip) is NOT cached, so a
 * transient outage never becomes a 24h dead miss that silently drops a contactable creator.
 */
export class CachingEnricher implements AccountEnricher {
  readonly kind: string;
  private readonly cache = new Map<string, { metrics: AccountMetrics | null; expiresAt: number }>();
  constructor(
    private readonly inner: AccountEnricher,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
  ) {
    this.kind = `cached:${inner.kind}`;
  }
  supports(platform: string): boolean {
    return this.inner.supports(platform);
  }
  async enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null> {
    const key = `${account.platform}:${(account.handle ?? account.url).toLowerCase()}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.metrics;
    let metrics: AccountMetrics | null;
    try {
      metrics = await this.inner.enrich(account);
    } catch (err) {
      // Transport OR provider error (bad key, quota, outage) → don't poison the cache; the
      // next call retries. The reason is logged (rate-limited) because the caller only
      // sees "unknown": a dead API key would otherwise be invisible.
      this.warn(err);
      return null;
    }
    // Bounded: drop what has expired, then the oldest, before the map can grow for ever.
    if (this.cache.size >= CachingEnricher.MAX_ENTRIES) {
      for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
      for (const k of this.cache.keys()) {
        if (this.cache.size < CachingEnricher.MAX_ENTRIES) break;
        this.cache.delete(k);
      }
    }
    this.cache.set(key, { metrics, expiresAt: now + this.ttlMs });
    return metrics;
  }

  private static readonly MAX_ENTRIES = 20_000;
  private lastWarnAt = 0;
  private warn(err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    // eslint-disable-next-line no-console
    console.warn(`[enrichment] audience lookup failed — the signal stays unknown: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Routes an account to the first enricher that supports its platform and returns real
 * data. A metrics result is kept when it carries ANY real signal — including a contact
 * path (emails/links from a YouTube channel description) even with null reach/engagement,
 * the key path for website-less creators. Distinguishes a genuine no-data result (returns
 * null, cacheable) from a transport error (RE-THROWS, so CachingEnricher won't cache it).
 */
export class EnricherRegistry implements AccountEnricher {
  readonly kind = "registry";
  constructor(private readonly enrichers: AccountEnricher[]) {}
  supports(platform: string): boolean {
    return this.enrichers.some((e) => e.supports(platform));
  }
  async enrich(account: { platform: string; handle: string | null; url: string }): Promise<AccountMetrics | null> {
    let transportError: unknown = null;
    for (const e of this.enrichers) {
      if (!e.supports(account.platform)) continue;
      try {
        const m = await e.enrich(account);
        if (m && metricsHaveData(m)) return m;
      } catch (err) {
        transportError = err; // remember; try the next supporting enricher
      }
    }
    if (transportError) throw transportError; // no data AND something errored → not a cacheable miss
    return null; // every supporting enricher answered "no data"
  }
}
