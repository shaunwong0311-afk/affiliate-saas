import { buildProfile, addPageToProfile, classifyAccountUrl, type Profile, type Account } from "@affiliate/core";
import {
  extractEmailsFromHtml,
  extractHrefs,
  discoverContactUrls,
  detectsContactForm,
  type HttpFetcher,
  type AccountEnricher,
} from "@affiliate/integrations";

/**
 * Best-effort contact resolution as a TRAVERSAL of the identity graph (Section 8.2).
 *
 * Email lives in different places depending on the creator: a blog puts it on /contact,
 * a YouTuber puts it in the channel description, a TikToker only links a Linktree which
 * links a website which has the email. So rather than a fixed waterfall tied to where we
 * ENTERED, this walks every linked property — and EXPANDS as it goes: fetching a social
 * bio reveals the website; fetching the website reveals /contact; a bio aggregator
 * reveals everything. It stops at the first DELIVERABLE address (verified) or when the
 * bounded fetch budget is spent. Starting point is irrelevant — it converges from any
 * node in the graph.
 */

export interface ContactResolution {
  email: string | null;
  /** Where it was found, e.g. "youtube_api:description", "bio_aggregator:mailto", "website:page". */
  source: string | null;
  /** The identity graph, grown by everything the traversal fetched. */
  profile: Profile | null;
  contactForm: boolean;
  contactFormUrl: string | null;
}

type Verify = (email: string) => Promise<{ deliverable: boolean }>;

export interface ResolveDeps {
  fetcher?: HttpFetcher;
  /** Used for platform-API contact extraction (YouTube channel description). */
  enricher?: AccountEnricher;
  verify: Verify;
}

export interface ResolveInput {
  profile: Profile | null;
  seedUrl: string | null;
  /** False for synthetic/dev prospects → no network traversal. */
  canFetch: boolean;
  /** Emails already extracted from the seed page (tried first, no fetch). */
  knownEmails: { email: string; source: string }[];
  /** Contact URLs already discovered (Linktree, /contact, YouTube About). */
  knownContactUrls: { url: string; kind: string }[];
  contactForm?: boolean;
  contactFormUrl?: string | null;
  /** Max page fetches for the whole traversal (API calls are free, not counted). */
  maxFetches?: number;
}

interface Candidate {
  url: string;
  kind: string;
  priority: number; // lower = tried first
  platform?: string;
  handle?: string | null;
  viaApi?: boolean;
}

// Hosts that are a platform/social surface (handled as graph accounts, never as a
// "personal website") or are never a creator's own site.
const NON_WEBSITE_HOSTS = new Set([
  "facebook.com", "fb.com", "amazon.com", "google.com", "apple.com", "play.google.com",
  "paypal.com", "gofundme.com", "patreon.com", "discord.gg", "discord.com", "t.me", "wa.me",
  "pinterest.com", "reddit.com", "gravatar.com", "wp.com", "shopify.com", "gumroad.com", "cdn.com",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
function norm(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}
function contactPriority(kind: string): number {
  switch (kind) {
    case "bio_aggregator": return 1;
    case "contact_page": return 2;
    case "website": return 2;
    case "youtube_about": return 3;
    default: return 4; // social
  }
}

/** Map a graph account to a fetch/API candidate. */
function candidateForAccount(a: Account): Candidate {
  if (a.platform === "linktree") return { url: a.url, kind: "bio_aggregator", priority: 1 };
  if (a.platform === "website") return { url: a.url, kind: "website", priority: 2 };
  if (a.platform === "youtube") return { url: a.url, kind: "youtube", priority: 2, platform: "youtube", handle: a.handle, viaApi: true };
  return { url: a.url, kind: "social", priority: 4, platform: a.platform, handle: a.handle };
}

/** A link that is the creator's OWN website (not a social platform, not a junk host). */
function isCandidateWebsite(link: string, baseHost: string | null): boolean {
  const h = hostOf(link);
  if (!h || h === baseHost) return false;
  if (classifyAccountUrl(link)) return false; // a known platform → handled as an account
  return !NON_WEBSITE_HOSTS.has(h);
}

export async function resolveContact(deps: ResolveDeps, input: ResolveInput): Promise<ContactResolution> {
  let profile = input.profile;
  let contactForm = input.contactForm ?? false;
  let contactFormUrl = input.contactFormUrl ?? null;
  const done = (email: string, source: string): ContactResolution => ({ email, source, profile, contactForm, contactFormUrl });
  const miss = (): ContactResolution => ({ email: null, source: null, profile, contactForm, contactFormUrl });

  const verify = (e: string) => deps.verify(e).catch(() => ({ deliverable: false }));

  // 1) Emails already on the seed page — free, try first.
  for (const c of input.knownEmails) {
    if ((await verify(c.email)).deliverable) return done(c.email, `page:${c.source}`);
  }
  if (!input.canFetch) return miss();

  // 2) Build the traversal frontier from the known contact URLs + every graph account.
  const visited = new Set<string>();
  const seedHost = input.seedUrl ? hostOf(input.seedUrl) : null;
  if (seedHost) visited.add(seedHost); // the homepage was already fetched upstream

  const queue: Candidate[] = [];
  const enqueue = (c: Candidate) => {
    if (queue.some((q) => norm(q.url) === norm(c.url) && !!q.viaApi === !!c.viaApi)) return;
    queue.push(c);
  };
  const enqueueWebsite = (link: string, fromHost: string | null) => {
    if (!isCandidateWebsite(link, fromHost)) return;
    const h = hostOf(link);
    if (h && !visited.has(h)) enqueue({ url: `https://${h}`, kind: "website", priority: 2 });
  };

  for (const cu of input.knownContactUrls) enqueue({ url: cu.url, kind: cu.kind, priority: contactPriority(cu.kind) });
  for (const a of profile?.accounts ?? []) enqueue(candidateForAccount(a));

  let fetches = 0;
  const budget = input.maxFetches ?? 6;

  while (queue.length && fetches < budget) {
    queue.sort((a, b) => a.priority - b.priority);
    const cand = queue.shift()!;
    const vkey = (cand.viaApi ? "api:" : "") + norm(cand.url);
    if (visited.has(vkey)) continue;
    visited.add(vkey);

    // --- YouTube via the Data API description (free, no captcha) ---
    if (cand.viaApi && cand.platform === "youtube") {
      if (!deps.enricher?.supports("youtube")) continue;
      const m = await deps.enricher.enrich({ platform: "youtube", handle: cand.handle ?? null, url: cand.url }).catch(() => null);
      for (const e of m?.emails ?? []) {
        if ((await verify(e)).deliverable) return done(e, "youtube_api:description");
      }
      for (const l of m?.links ?? []) enqueueWebsite(l, "youtube.com");
      continue; // API call — not charged against the fetch budget
    }

    // --- Generic fetch of the property ---
    if (!deps.fetcher) continue;
    let html: string | null = null;
    try {
      const r = await deps.fetcher.get(cand.url);
      if (r.status >= 200 && r.status < 300 && r.html && r.html.length > 200) html = r.html;
    } catch {
      /* unreachable property */
    }
    fetches++;
    if (!html) continue;

    const host = hostOf(cand.url);
    // Grow the identity graph from this page's links.
    const page = { url: cand.url, links: extractHrefs(html, cand.url), bioAggregator: cand.kind === "bio_aggregator" };
    profile = profile ? addPageToProfile(profile, page, input.seedUrl) : buildProfile(input.seedUrl, [page]);

    // Extract + verify emails from this property.
    for (const f of extractEmailsFromHtml(html)) {
      if ((await verify(f.email)).deliverable) return done(f.email, `${cand.kind}:${f.source}`);
    }
    if (!contactForm && detectsContactForm(html)) {
      contactForm = true;
      contactFormUrl = cand.url;
    }

    // Expand: this property's contact pages, the creator's website, and new socials.
    for (const cu of discoverContactUrls(html, cand.url)) {
      if (!visited.has(norm(cu.url))) enqueue({ url: cu.url, kind: cu.kind, priority: contactPriority(cu.kind) });
    }
    let added = 0;
    for (const link of page.links) {
      if (added >= 4) break; // bound the fan-out per page
      const acc = classifyAccountUrl(link);
      if (acc && acc.platform !== "website" && !visited.has(norm(acc.url))) {
        enqueue(candidateForAccount({ ...acc, provenance: "page_link", confidence: 0.5 } as Account));
        added++;
      } else if (isCandidateWebsite(link, host)) {
        enqueueWebsite(link, host);
        added++;
      }
    }
  }

  return miss();
}
