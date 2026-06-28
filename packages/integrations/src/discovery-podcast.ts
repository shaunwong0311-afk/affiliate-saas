import type { DiscoveryQuery, DiscoverySource, RawCandidate } from "./ports.js";
import type { HttpFetcher } from "./http.js";

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

export class PodcastDiscoverySource implements DiscoverySource {
  readonly sourceType = "podcast_discovery";
  constructor(private readonly opts: { http: SearchJsonHttp; fetcher?: HttpFetcher; maxQueries?: number; maxFeedFetches?: number }) {}

  async discover(query: DiscoveryQuery): Promise<RawCandidate[]> {
    const niche = (query.niche || "products").trim();
    const queries = [niche, `${niche} review`].slice(0, this.opts.maxQueries ?? 2);
    const perQuery = Math.max(1, Math.ceil(query.limit / queries.length));
    const seen = new Set<string>();
    const out: RawCandidate[] = [];
    let feedFetches = 0;
    const maxFeed = this.opts.maxFeedFetches ?? 10;

    for (const q of queries) {
      if (out.length >= query.limit) break;
      let res: { status: number; json: any };
      try {
        res = await this.opts.http.get(`https://itunes.apple.com/search?media=podcast&limit=${perQuery}&term=${encodeURIComponent(q)}`);
      } catch {
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

        // Fetch the RSS feed (fetcher wired + within budget) → owner email + website,
        // so the prospect is contactable. The feed XML is carried as pageHtml so the
        // shared extractors (email, identity graph) light up in ingestCandidate.
        let website: string | null = null;
        let feedXml: string | null = null;
        if (this.opts.fetcher && r.feedUrl && feedFetches < maxFeed) {
          feedFetches++;
          try {
            const fr = await this.opts.fetcher.get(r.feedUrl);
            if (fr.status >= 200 && fr.status < 300 && fr.html) {
              feedXml = fr.html;
              website = parsePodcastFeed(fr.html).website;
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
          pageHtml: feedXml,
          synthetic: false,
        });
      }
    }
    return out;
  }
}
