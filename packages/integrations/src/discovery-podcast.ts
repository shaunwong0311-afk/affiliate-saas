import type { DiscoveryHooks, DiscoveryQuery, DiscoverySource, RawCandidate } from "./ports.js";
import { assertProviderOk, ProviderError, type HttpFetcher } from "./http.js";

/**
 * Podcast discovery (Section 8.1) via the Apple iTunes Search API — FREE, no key. The
 * search returns shows matching the niche; the gold, though, is the RSS `feedUrl`: a
 * podcast feed almost always carries the owner's contact email (`<itunes:owner>`) and
 * the show's website. So unlike Apple's JS-rendered pages, fetching the feed turns a
 * podcast into a FIRST-CLASS, contactable prospect — real email + site, ready for the
 * pipeline. Reach (where exposed) and the rest come from enrichment. Real source; the
 * feed fetch is bounded so a run can't fan out unboundedly.
 */

interface SearchJsonHttp {
  get(url: string): Promise<{ status: number; json: any }>;
}

/** Pull the owner email + show website out of a podcast RSS feed (best-effort, regex). */
export function parsePodcastFeed(xml: string): { email: string | null; website: string | null } {
  const emailMatch =
    xml.match(/<itunes:email>\s*([^<\s]+@[^<\s]+)\s*<\/itunes:email>/i) ?? xml.match(/<email>\s*([^<\s]+@[^<\s]+)\s*<\/email>/i);
  // The channel website: the first plain <link>https://…</link> (RSS channel link),
  // ignoring atom self-links (which use <link href=… rel="self">).
  const linkMatch = xml.match(/<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/i);
  return { email: emailMatch?.[1]?.toLowerCase() ?? null, website: linkMatch?.[1] ?? null };
}

/**
 * The show's OWN part of a feed: everything before the first episode. The channel header
 * is the publisher talking about themselves (title, owner, description, links); each
 * `<item>` is an episode whose notes name guests and sponsors — other people's links and
 * addresses that must not be read as the show's.
 */
function channelHeader(xml: string): string {
  const firstItem = xml.search(/<item[\s>]/i);
  return firstItem > 0 ? xml.slice(0, firstItem) : xml;
}

export class PodcastDiscoverySource implements DiscoverySource {
  readonly sourceType = "podcast_discovery";
  constructor(private readonly opts: { http: SearchJsonHttp; fetcher?: HttpFetcher; maxQueries?: number; maxFeedFetches?: number }) {}

  async discover(query: DiscoveryQuery, hooks?: DiscoveryHooks): Promise<RawCandidate[]> {
    const niche = (query.niche || "products").trim();
    const queries = [niche, `${niche} review`].slice(0, this.opts.maxQueries ?? 2);
    const perQuery = Math.max(1, Math.ceil(query.limit / queries.length));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];
    let feedFetches = 0;
    const maxFeed = this.opts.maxFeedFetches ?? 10;
    let succeeded = 0;
    const failures: { message: string; error: unknown }[] = [];

    for (const q of queries) {
      if (out.length >= query.limit) break;
      let res: { status: number; json: any };
      try {
        res = await this.opts.http.get(`https://itunes.apple.com/search?media=podcast&limit=${perQuery}&term=${encodeURIComponent(q)}`);
        assertProviderOk("itunes", res, (j) => j?.errorMessage);
        succeeded++;
      } catch (err) {
        failures.push({ message: `search "${q}": ${err instanceof Error ? err.message : String(err)}`, error: err });
        if (err instanceof ProviderError && err.kind !== "error") break; // throttled: later queries fail too
        continue; // isolate source failures (Section 8.1)
      }
      const results = (res.json?.results ?? []) as Array<{
        collectionName?: string;
        trackName?: string;
        artistName?: string;
        feedUrl?: string;
        trackViewUrl?: string;
        collectionViewUrl?: string;
        primaryGenreName?: string;
      }>;
      for (const r of results) {
        if (out.length >= query.limit) break;
        const name = r.collectionName ?? r.trackName;
        const appleUrl = r.collectionViewUrl ?? r.trackViewUrl ?? null;
        const key = (r.feedUrl ?? appleUrl ?? name ?? "").toLowerCase();
        if (!name || !key || seen.has(key)) continue;
        seen.add(key);

        // Fetch the RSS feed (fetcher wired + within budget) → the show's website and the
        // owner's declared contact email, so the prospect is contactable.
        let website: string | null = null;
        let ownerEmail: string | null = null;
        let header: string | null = null;
        if (this.opts.fetcher && r.feedUrl && feedFetches < maxFeed) {
          feedFetches++;
          try {
            const fr = await this.opts.fetcher.get(r.feedUrl);
            if (fr.status >= 200 && fr.status < 300 && fr.html) {
              header = channelHeader(fr.html);
              const parsed = parsePodcastFeed(header);
              website = parsed.website;
              // `<itunes:owner>` is channel-level by definition, so if a feed happens to
              // write it AFTER its episodes it is still the owner's (the website is not
              // looked for down there — the first <link> past the header is an episode's).
              ownerEmail = parsed.email ?? fr.html.match(/<itunes:email>\s*([^<\s]+@[^<\s]+)\s*<\/itunes:email>/i)?.[1]?.toLowerCase() ?? null;
            }
          } catch {
            /* unreachable feed — fall back to the Apple URL */
          }
        }

        out.push({
          identity: name,
          siteUrl: website,
          channelUrl: website ? null : appleUrl,
          sourceType: this.sourceType,
          evidenceUrl: website ?? appleUrl ?? r.feedUrl ?? null,
          evidenceSummary: `Podcast "${name}"${r.artistName ? ` by ${r.artistName}` : ""}${r.primaryGenreName ? ` (${r.primaryGenreName})` : ""} — found via Apple Podcasts for "${q}".`,
          outboundLinks: [],
          // Only the channel header travels on as page content (for the identity graph and
          // any further show-level addresses) — never the episodes' guest/sponsor notes.
          pageHtml: header,
          // The feed's declared owner address is the publisher's own statement of how to
          // reach them: it is tried FIRST, ahead of anything else found in the feed.
          ...(ownerEmail ? { contactEmails: [{ email: ownerEmail, source: "feed_owner" }] } : {}),
          synthetic: false,
        });
      }
    }

    // Total failure throws (so it is not mistaken for "no podcasts"); partial failure is reported.
    if (failures.length && succeeded === 0) {
      const first = failures[0]!;
      if (first.error instanceof ProviderError) throw first.error;
      throw new Error(`${this.sourceType}: all ${failures.length} request(s) failed — ${first.message}`, { cause: first.error });
    }
    for (const f of failures) hooks?.onError?.({ sourceType: this.sourceType, message: f.message });
    return out;
  }
}
