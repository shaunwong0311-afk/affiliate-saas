/**
 * Creator identity graph (Section 8.1, profile-graph plan). Pure logic that unifies
 * one creator across the surfaces they own — YouTube, blog, X, newsletter, podcast —
 * from the links they actually placed. No network here: the integrations layer
 * fetches pages and extracts hrefs; this classifies and resolves them into a single
 * Profile with per-account PROVENANCE and CONFIDENCE. Nothing is merged on a guess —
 * a one-directional link is low confidence; a bio-aggregator listing or a reciprocal
 * link is high. This is the substrate for "where do they come from / who's a fit".
 */

import { BIO_AGGREGATOR_HOSTS, isSharedPlatformHost } from "./hosts.js";

// Host classification lives next door; re-exported here so it ships with the profile API.
export * from "./hosts.js";

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

/** A URL classified as an account, before provenance is known. */
export type ClassifiedAccount = Pick<Account, "platform" | "handle" | "url">;

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
  /**
   * True if this page is the creator's own bio aggregator (Linktree/Beacons), so the
   * accounts it lists are theirs. The CALLER vouches for ownership — a bio page that was
   * merely linked from somewhere is not automatically the creator's.
   */
  bioAggregator?: boolean;
  /**
   * True when the caller has ESTABLISHED this page is the creator's own surface (it was
   * reached from a surface they own and links back to one). The page's own account then
   * joins the graph as a reciprocal link. Never set for a page that is merely linked.
   */
  owned?: boolean;
}

const PODCAST_HOSTS = ["pod.link", "anchor.fm", "podbean.com", "buzzsprout.com", "transistor.fm", "captivate.fm", "simplecast.com"];

// First path segments that are a platform FEATURE, not a creator's handle.
const INSTAGRAM_RESERVED = new Set([
  "p", "reel", "reels", "tv", "explore", "stories", "accounts", "directory", "about", "developer",
  "legal", "direct", "web", "challenge", "share", "s", "ar", "tags", "locations", "invites", "emails",
  "session", "oauth", "api", "graphql", "static", "privacy", "terms", "press", "blog",
]);
const TWITTER_RESERVED = ["i", "home", "search", "intent", "share", "hashtag", "explore", "notifications", "messages", "compose", "login", "signup", "settings", "tos", "privacy", "about", "download"];
const BIO_RESERVED = new Set(["s", "login", "register", "signup", "help", "blog", "about", "pricing", "privacy", "terms", "marketplace", "templates", "admin", "page"]);
const SUBSTACK_RESERVED = new Set(["www", "open", "on", "support", "api", "cdn", "email", "substackcdn"]);
const BEEHIIV_RESERVED = new Set(["www", "app", "blog", "support", "developers", "media"]);

function emptyAudience(): AudienceEstimate {
  return { reach: null, primaryGeo: null, language: null, engagementRate: null, source: null };
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^www\./, "").toLowerCase();
}

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function parseHttpUrl(rawUrl: string): URL | null {
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Classify a URL into a known creator-platform account. Returns null for anything
 * that isn't a recognized creator surface — we do NOT treat every outbound link as
 * "their blog" (that would be a false-positive machine). The seed's own domain is
 * added separately via {@link seedAccount}.
 *
 * Handle parsing is PLATFORM-AWARE: a path that names a platform feature (an Instagram
 * `/p/<post>`, a TikTok `/tag/…`, `substack.com/home`) carries no creator identity and
 * returns null rather than a bogus handle (`@p`) that every embedded post would share.
 */
export function classifyAccountUrl(rawUrl: string): ClassifiedAccount | null {
  const u = parseHttpUrl(rawUrl);
  if (!u) return null;
  const host = hostOf(u);
  const seg = u.pathname.split("/").filter(Boolean);
  const first = (seg[0] ?? "").toLowerCase();
  const origin = `${u.protocol}//${host}`;
  const norm = `${origin}${u.pathname.replace(/\/+$/, "")}`;

  if (hostMatches(host, BIO_AGGREGATOR_HOSTS)) {
    // The identity is the creator's page ON THAT HOST — `linktr.ee/jane` and
    // `beacons.ai/jane` are different people, so the host is part of the handle.
    const apex = BIO_AGGREGATOR_HOSTS.find((h) => host === h || host.endsWith(`.${h}`))!;
    if (host !== apex) return { platform: "linktree", handle: host, url: origin }; // tenant subdomain (jane.carrd.co)
    const name = seg[0]?.replace(/^@/, "").toLowerCase();
    if (!name || BIO_RESERVED.has(name)) return null;
    return { platform: "linktree", handle: `${host}/${name}`, url: `${origin}/${seg[0]}` };
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    // Video / search / utility paths carry NO channel identity — a link to one is not an
    // owned account (two unrelated sites can embed the same video, and query-stripping
    // would collapse every `watch?v=…` to one shared, handle-less key). Only real channel
    // handles/ids resolve to an account.
    if (host === "youtu.be") return null; // youtu.be/<videoId> — a video share
    const handle = seg[0]?.startsWith("@") ? seg[0] : ["channel", "c", "user"].includes(first) ? seg[1] ?? null : null;
    if (!handle) return null;
    const path = seg[0]!.startsWith("@") ? `/${seg[0]}` : `/${first}/${handle}`;
    return { platform: "youtube", handle, url: `${u.protocol}//youtube.com${path}` };
  }
  if (host === "twitter.com" || host === "x.com" || host === "mobile.twitter.com") {
    // Share widgets (/intent/tweet, /share), utility tabs, and a specific tweet
    // (/<user>/status/<id> — usually an EMBEDDED/quoted tweet) are not the page owner's
    // handle, so we never attribute them as an owned account.
    if (!first || TWITTER_RESERVED.includes(first)) return null;
    if ((seg[1] ?? "").toLowerCase() === "status") return null; // a tweet, not their profile
    const name = seg[0]!.replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return null;
    return { platform: "twitter", handle: `@${name}`, url: `${origin}/${name}` };
  }
  if (host === "instagram.com") {
    const name = seg[0]?.replace(/^@/, "");
    // /p/<post>, /reel/<id>, /explore/tags/… are posts and features, not a profile.
    if (!name || INSTAGRAM_RESERVED.has(name.toLowerCase()) || !/^[A-Za-z0-9._]{1,30}$/.test(name)) return null;
    return { platform: "instagram", handle: `@${name}`, url: `${origin}/${name}` };
  }
  if (host === "tiktok.com" || host === "m.tiktok.com") {
    if (!seg[0] || !/^@[A-Za-z0-9._]{2,24}$/.test(seg[0])) return null; // /tag/…, /discover, /music/…
    return { platform: "tiktok", handle: seg[0], url: `${u.protocol}//tiktok.com/${seg[0]}` };
  }
  if (host === "substack.com") {
    // Only a profile handle identifies someone here; /home, /inbox, /p/… do not. A profile
    // handle keeps its `@` so it can never collide with a publication subdomain of the same name.
    if (!seg[0]?.startsWith("@") || seg[0].length < 2) return null;
    return { platform: "substack", handle: seg[0].toLowerCase(), url: `${origin}/${seg[0]}` };
  }
  if (host === "open.substack.com") {
    const pub = seg[0] === "pub" ? seg[1]?.toLowerCase() : undefined;
    return pub ? { platform: "substack", handle: pub, url: `${u.protocol}//${pub}.substack.com` } : null;
  }
  if (host.endsWith(".substack.com")) {
    const sub = host.split(".")[0]!;
    return SUBSTACK_RESERVED.has(sub) ? null : { platform: "substack", handle: sub, url: origin };
  }
  if (host.endsWith(".beehiiv.com")) {
    const sub = host.split(".")[0]!;
    return BEEHIIV_RESERVED.has(sub) ? null : { platform: "beehiiv", handle: sub, url: origin };
  }
  if (host === "podcasts.apple.com") {
    // A show is /<country>/podcast/<slug>/id<digits>; genre and chart pages carry ids too.
    const id = seg.includes("podcast") ? seg.find((s) => /^id\d+$/.test(s)) : undefined;
    return id ? { platform: "podcast", handle: `apple:${id}`, url: norm } : null;
  }
  if (host === "open.spotify.com") {
    return seg[0] === "show" && seg[1] ? { platform: "podcast", handle: `spotify:${seg[1]}`, url: `${origin}/show/${seg[1]}` } : null;
  }
  if (hostMatches(host, PODCAST_HOSTS)) {
    // A show is a path on the host (anchor.fm/<show>) or a tenant subdomain (show.podbean.com);
    // the bare platform host is nobody's show.
    const tenant = !PODCAST_HOSTS.includes(host);
    if (!tenant && seg.length === 0) return null;
    return { platform: "podcast", handle: null, url: tenant ? origin : `${origin}/${seg[0]}` };
  }
  return null;
}

/**
 * Classify the seed (prospect's own URL); a bare domain becomes a "website" account.
 * A handle-less URL on a SHARED platform (a YouTube `/watch`, an Instagram `/p/…`,
 * `medium.com/…`) has no per-creator identity, so it yields NO account — promoting the
 * platform host to a "website" would make every such prospect the same creator.
 */
export function seedAccount(rawUrl: string): ClassifiedAccount | null {
  const known = classifyAccountUrl(rawUrl);
  if (known) return known;
  const u = parseHttpUrl(rawUrl);
  if (!u) return null;
  const host = hostOf(u);
  if (!host || isSharedPlatformHost(host)) return null;
  return { platform: "website", handle: null, url: `${u.protocol}//${host}` };
}

/** Stable identity key for an account: `platform:handle`, or the normalized URL when handle-less. */
export function accountKey(a: { platform: string; handle: string | null; url: string }): string {
  return a.handle ? `${a.platform}:${a.handle.toLowerCase()}` : `url:${a.url.toLowerCase().replace(/\/+$/, "")}`;
}

function rootDomain(url: string): string | null {
  const u = parseHttpUrl(url);
  return u ? hostOf(u) : null;
}

/** What "the seed" is, for back-link checks: a website host, or one platform account. */
interface SeedRef {
  account: ClassifiedAccount | null;
  key: string | null;
  /** Set only for a website seed. */
  host: string | null;
}

function refOf(account: ClassifiedAccount | null): SeedRef {
  return { account, key: account ? accountKey(account) : null, host: account?.platform === "website" ? rootDomain(account.url) : null };
}

/** Does `link` point at the given account (same site for a website, same account otherwise)? */
function refersTo(link: string, ref: SeedRef): boolean {
  if (!ref.account) return false;
  if (ref.host) return rootDomain(link) === ref.host;
  const a = classifyAccountUrl(link);
  return a != null && accountKey(a) === ref.key;
}

/** Build a profile from the seed plus the pages we fetched (and their outbound links). */
export function buildProfile(seedUrl: string | null, pages: PageLinks[]): Profile {
  const accounts = new Map<string, Account>();
  const seed = refOf(seedUrl ? seedAccount(seedUrl) : null);

  const upsert = (a: ClassifiedAccount, provenance: Provenance) => {
    const confidence = PROVENANCE_CONFIDENCE[provenance];
    const key = accountKey(a);
    const existing = accounts.get(key);
    if (!existing || confidence > existing.confidence) {
      accounts.set(key, { ...a, provenance, confidence });
    }
  };

  if (seed.account) upsert(seed.account, "seed");
  // What the seed's OWN pages link to — the forward half of reciprocity.
  const seedLinks = pages.filter((p) => refersTo(p.url, seed)).flatMap((p) => p.links);
  for (const page of pages) addAccountsFromPage(upsert, page, seed, seedLinks);

  const list = [...accounts.values()];
  const primary = pickPrimary(list);
  const linked = list.filter((a) => a.provenance !== "seed");
  const identityConfidence = linked.length ? Math.max(...linked.map((a) => a.confidence)) : list.length ? 1 : 0;
  return { primary, accounts: list, audience: emptyAudience(), identityConfidence };
}

/** Fold one more fetched page's links into an existing profile (incremental enrich). */
export function addPageToProfile(profile: Profile, page: PageLinks, seedUrl?: string | null): Profile {
  const accounts = new Map<string, Account>(profile.accounts.map((a) => [accountKey(a), a]));
  const upsert = (a: ClassifiedAccount, provenance: Provenance) => {
    const confidence = PROVENANCE_CONFIDENCE[provenance];
    const key = accountKey(a);
    const existing = accounts.get(key);
    if (!existing || confidence > existing.confidence) accounts.set(key, { ...a, provenance, confidence });
  };
  const seed = refOf(seedUrl ? seedAccount(seedUrl) : profile.primary);
  // Incrementally we no longer hold the seed page's links, so reciprocity here is only
  // ever granted on the caller's say-so (`page.owned`).
  addAccountsFromPage(upsert, page, seed, []);

  const list = [...accounts.values()];
  const linked = list.filter((a) => a.provenance !== "seed");
  const identityConfidence = linked.length ? Math.max(...linked.map((a) => a.confidence)) : list.length ? 1 : 0;
  return { ...profile, accounts: list, primary: profile.primary ?? pickPrimary(list), identityConfidence };
}

function addAccountsFromPage(
  upsert: (a: ClassifiedAccount, p: Provenance) => void,
  page: PageLinks,
  seed: SeedRef,
  seedLinks: string[],
): void {
  const isSeedPage = refersTo(page.url, seed);
  // The surface this page IS (a platform profile, a bio page, or a plain website).
  const self = isSeedPage ? null : refOf(seedAccount(page.url));
  // The seed's own bio page vouches for itself; any other bio page needs the caller's word.
  const onBio = page.bioAggregator ?? (isSeedPage && seed.account?.platform === "linktree");

  // TRUE reciprocity: the seed links this surface AND this surface links back to the seed
  // (or the caller established ownership). A third-party page that merely mentions the
  // seed proves nothing about the other accounts it happens to link.
  if (self?.account) {
    const linkedFromSeed = seedLinks.some((l) => refersTo(l, self));
    const linksBack = page.links.some((l) => refersTo(l, seed));
    if (page.owned || (linkedFromSeed && linksBack)) upsert(self.account, "reciprocal_link");
  }

  for (const link of page.links) {
    const acc = classifyAccountUrl(link);
    if (!acc) continue;
    const key = accountKey(acc);
    if (key === seed.key || key === self?.key) continue; // the seed / this page itself
    // A link found on a bio aggregator the creator owns is high-confidence theirs;
    // anywhere else it is a one-directional mention.
    upsert(acc, onBio ? "bio_aggregator" : "page_link");
  }
}

/**
 * Merge two profiles for the SAME creator (discovered via different surfaces) into one.
 * Accounts are unioned by identity key, keeping the highest-confidence provenance for
 * each; audience figures prefer the known (non-null) value. Used by prospect-level
 * identity resolution to build one comprehensive profile per person.
 */
export function mergeProfiles(a: Profile, b: Profile): Profile {
  const accounts = new Map<string, Account>(a.accounts.map((x) => [accountKey(x), x]));
  for (const acc of b.accounts) {
    const key = accountKey(acc);
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
