/**
 * Creator identity graph (Section 8.1, profile-graph plan). Pure logic that unifies
 * one creator across the surfaces they own — YouTube, blog, X, newsletter, podcast —
 * from the links they actually placed. No network here: the integrations layer
 * fetches pages and extracts hrefs; this classifies and resolves them into a single
 * Profile with per-account PROVENANCE and CONFIDENCE. Nothing is merged on a guess —
 * a one-directional link is low confidence; a bio-aggregator listing or a reciprocal
 * link is high. This is the substrate for "where do they come from / who's a fit".
 */

export type Platform =
  | "youtube"
  | "twitter"
  | "instagram"
  | "tiktok"
  | "substack"
  | "beehiiv"
  | "podcast"
  | "linktree"
  | "website"
  | "unknown";

/** How we learned an account belongs to the profile — ordered by trust. */
export type Provenance = "seed" | "bio_aggregator" | "reciprocal_link" | "shared_domain" | "page_link";

const PROVENANCE_CONFIDENCE: Record<Provenance, number> = {
  seed: 1.0, // the prospect's own page — certain
  reciprocal_link: 0.95, // A links B and B links back to A
  bio_aggregator: 0.9, // listed on the creator's own Linktree/Beacons
  shared_domain: 0.8, // same registrable domain as the seed
  page_link: 0.5, // a one-directional link — could be a friend/sponsor, not them
};

export interface Account {
  platform: Platform;
  /** @handle / channel id / null for a bare domain. */
  handle: string | null;
  url: string;
  provenance: Provenance;
  /** 0..1 that this account belongs to the SAME person as the seed. */
  confidence: number;
}

/**
 * Audience estimate. Every field is nullable — null = UNKNOWN (no provider/inference
 * yet), never invented. `source` records how the figures were obtained so the UI can
 * weight them. Filled cheaply by inference (Phase 3) and, later, a paid provider
 * (Phase 4) for A-tier prospects.
 */
export type AudienceSource = "api" | "scrape" | "page" | "inferred" | "provider" | "creator_provided" | null;

export interface AudienceEstimate {
  reach: number | null;
  primaryGeo: string | null;
  language: string | null;
  engagementRate: number | null;
  /** How the figures were obtained — drives the confidence UX. */
  source: AudienceSource;
}

export interface Profile {
  /** The home surface (the seed, or the highest-confidence account). */
  primary: Account | null;
  accounts: Account[];
  audience: AudienceEstimate;
  /** 0..1 — confidence that the LINKED accounts truly are the same person. */
  identityConfidence: number;
}

/** A fetched page and the outbound links found on it (hrefs extracted by integrations). */
export interface PageLinks {
  url: string;
  links: string[];
  /** True if this page is the creator's own bio aggregator (Linktree/Beacons). */
  bioAggregator?: boolean;
}

const BIO_HOSTS = [
  "linktr.ee", "beacons.ai", "bio.link", "solo.to", "lnk.bio", "carrd.co", "tap.bio",
  "withkoji.com", "koji.to", "msha.ke", "linkpop.com", "komi.io", "snipfeed.co",
  "stan.store", "flowcode.com", "shor.by", "campsite.bio", "many.link", "pillar.io",
];
const PODCAST_HOSTS = ["podcasts.apple.com", "pod.link", "anchor.fm", "podbean.com", "buzzsprout.com", "transistor.fm", "captivate.fm", "simplecast.com"];
// Hosts that are never a creator's "account" — share widgets, CDNs, platforms.
const IGNORE_HOSTS = ["facebook.com", "fb.com", "pinterest.com", "reddit.com", "amazon.com", "google.com", "apple.com", "play.google.com", "patreon.com", "discord.gg", "discord.com", "t.me", "wa.me", "paypal.com", "gofundme.com", "cdn.com", "gravatar.com", "wp.com", "shopify.com", "gumroad.com"];

function emptyAudience(): AudienceEstimate {
  return { reach: null, primaryGeo: null, language: null, engagementRate: null, source: null };
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^www\./, "").toLowerCase();
}

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Classify a URL into a known creator-platform account. Returns null for anything
 * that isn't a recognized creator surface — we do NOT treat every outbound link as
 * "their blog" (that would be a false-positive machine). The seed's own domain is
 * added separately via {@link seedAccount}.
 */
export function classifyAccountUrl(rawUrl: string): { platform: Platform; handle: string | null; url: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = hostOf(u);
  const seg = u.pathname.split("/").filter(Boolean);
  const norm = `${u.protocol}//${host}${u.pathname.replace(/\/+$/, "")}`;

  if (hostMatches(host, BIO_HOSTS)) return { platform: "linktree", handle: seg[0] ?? null, url: norm };
  if (host === "youtube.com" || host === "youtu.be") {
    const handle = seg[0]?.startsWith("@") ? seg[0] : ["channel", "c", "user"].includes(seg[0] ?? "") ? seg[1] ?? null : null;
    return { platform: "youtube", handle: handle ?? null, url: norm };
  }
  if (host === "twitter.com" || host === "x.com") {
    const h = seg[0] && !["i", "home", "search", "intent"].includes(seg[0]) ? `@${seg[0].replace(/^@/, "")}` : null;
    return { platform: "twitter", handle: h, url: norm };
  }
  if (host === "instagram.com") return { platform: "instagram", handle: seg[0] ? `@${seg[0].replace(/^@/, "")}` : null, url: norm };
  if (host === "tiktok.com") return { platform: "tiktok", handle: seg[0]?.startsWith("@") ? seg[0] : null, url: norm };
  if (host === "substack.com") return { platform: "substack", handle: seg[0] ?? null, url: norm };
  if (host.endsWith(".substack.com")) return { platform: "substack", handle: host.split(".")[0]!, url: norm };
  if (host === "beehiiv.com" || host.endsWith(".beehiiv.com")) return { platform: "beehiiv", handle: null, url: norm };
  if (hostMatches(host, PODCAST_HOSTS) || (host === "open.spotify.com" && seg[0] === "show")) return { platform: "podcast", handle: null, url: norm };
  return null;
}

/** Classify the seed (prospect's own URL); a bare domain becomes a "website" account. */
export function seedAccount(rawUrl: string): { platform: Platform; handle: string | null; url: string } | null {
  const known = classifyAccountUrl(rawUrl);
  if (known) return known;
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { platform: "website", handle: null, url: `${u.protocol}//${hostOf(u)}` };
  } catch {
    return null;
  }
}

function keyOf(a: { platform: Platform; handle: string | null; url: string }): string {
  return a.handle ? `${a.platform}:${a.handle.toLowerCase()}` : `url:${a.url.toLowerCase()}`;
}

function rootDomain(url: string): string | null {
  try {
    return hostOf(new URL(url));
  } catch {
    return null;
  }
}

/** Build a profile from the seed plus the pages we fetched (and their outbound links). */
export function buildProfile(seedUrl: string | null, pages: PageLinks[]): Profile {
  const accounts = new Map<string, Account>();
  const seedHost = seedUrl ? rootDomain(seedUrl) : null;

  const upsert = (a: { platform: Platform; handle: string | null; url: string }, provenance: Provenance) => {
    const confidence = PROVENANCE_CONFIDENCE[provenance];
    const key = keyOf(a);
    const existing = accounts.get(key);
    if (!existing || confidence > existing.confidence) {
      accounts.set(key, { ...a, provenance, confidence });
    }
  };

  if (seedUrl) {
    const s = seedAccount(seedUrl);
    if (s) upsert(s, "seed");
  }
  for (const page of pages) addAccountsFromPage(upsert, page, seedHost);

  const list = [...accounts.values()];
  const primary = pickPrimary(list);
  const linked = list.filter((a) => a.provenance !== "seed");
  const identityConfidence = linked.length ? Math.max(...linked.map((a) => a.confidence)) : list.length ? 1 : 0;
  return { primary, accounts: list, audience: emptyAudience(), identityConfidence };
}

/** Fold one more fetched page's links into an existing profile (incremental enrich). */
export function addPageToProfile(profile: Profile, page: PageLinks, seedUrl?: string | null): Profile {
  const accounts = new Map<string, Account>(profile.accounts.map((a) => [keyOf(a), a]));
  const upsert = (a: { platform: Platform; handle: string | null; url: string }, provenance: Provenance) => {
    const confidence = PROVENANCE_CONFIDENCE[provenance];
    const key = keyOf(a);
    const existing = accounts.get(key);
    if (!existing || confidence > existing.confidence) accounts.set(key, { ...a, provenance, confidence });
  };
  addAccountsFromPage(upsert, page, seedUrl ? rootDomain(seedUrl) : profile.primary ? rootDomain(profile.primary.url) : null);

  const list = [...accounts.values()];
  const linked = list.filter((a) => a.provenance !== "seed");
  const identityConfidence = linked.length ? Math.max(...linked.map((a) => a.confidence)) : list.length ? 1 : 0;
  return { ...profile, accounts: list, primary: profile.primary ?? pickPrimary(list), identityConfidence };
}

function addAccountsFromPage(
  upsert: (a: { platform: Platform; handle: string | null; url: string }, p: Provenance) => void,
  page: PageLinks,
  seedHost: string | null,
): void {
  const onBio = page.bioAggregator ?? false;
  const pageLinksBackToSeed = seedHost != null && page.links.some((l) => rootDomain(l) === seedHost);
  const pageHost = rootDomain(page.url);
  for (const link of page.links) {
    if (hostMatches(rootDomain(link) ?? "", IGNORE_HOSTS)) continue;
    const acc = classifyAccountUrl(link);
    if (!acc) continue;
    if (rootDomain(acc.url) === seedHost) continue; // the seed itself, already added
    // A link found on a bio aggregator the creator owns is high-confidence theirs.
    // If this page links the account AND links back to the seed, treat as reciprocal.
    const provenance: Provenance = onBio ? "bio_aggregator" : pageLinksBackToSeed && pageHost !== seedHost ? "reciprocal_link" : "page_link";
    upsert(acc, provenance);
  }
}

/**
 * Merge two profiles for the SAME creator (discovered via different surfaces) into one.
 * Accounts are unioned by identity key, keeping the highest-confidence provenance for
 * each; audience figures prefer the known (non-null) value. Used by prospect-level
 * identity resolution to build one comprehensive profile per person.
 */
export function mergeProfiles(a: Profile, b: Profile): Profile {
  const accounts = new Map<string, Account>(a.accounts.map((x) => [keyOf(x), x]));
  for (const acc of b.accounts) {
    const key = keyOf(acc);
    const existing = accounts.get(key);
    if (!existing || acc.confidence > existing.confidence) accounts.set(key, acc);
  }
  const list = [...accounts.values()];
  const primary = a.primary ?? b.primary ?? pickPrimary(list);
  const linked = list.filter((x) => x.provenance !== "seed");
  const identityConfidence = linked.length ? Math.max(...linked.map((x) => x.confidence)) : list.length ? 1 : 0;
  const audience: AudienceEstimate = {
    reach: a.audience.reach ?? b.audience.reach,
    primaryGeo: a.audience.primaryGeo ?? b.audience.primaryGeo,
    language: a.audience.language ?? b.audience.language,
    engagementRate: a.audience.engagementRate ?? b.audience.engagementRate,
    source: a.audience.source ?? b.audience.source,
  };
  return { primary, accounts: list, audience, identityConfidence };
}

function pickPrimary(accounts: Account[]): Account | null {
  if (accounts.length === 0) return null;
  const seed = accounts.find((a) => a.provenance === "seed");
  if (seed) return seed;
  // No explicit seed — prefer the highest-confidence, then a content platform.
  const order: Platform[] = ["youtube", "substack", "beehiiv", "podcast", "website", "twitter", "instagram", "tiktok", "linktree", "unknown"];
  return [...accounts].sort((a, b) => b.confidence - a.confidence || order.indexOf(a.platform) - order.indexOf(b.platform))[0]!;
}
