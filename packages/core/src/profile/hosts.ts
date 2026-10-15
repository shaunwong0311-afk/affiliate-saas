/**
 * Host classification shared by the discovery half of the engine: ingest exclusions,
 * identity resolution, the recursive frontier and contact acceptance all need the same
 * answer to "whose is this host?". One host can be:
 *
 *  - a SHARED PLATFORM (youtube.com, instagram.com, amazon.com, bit.ly, google.com): one
 *    host, millions of unrelated accounts. Never a creator's own site, never a merchant
 *    worth mining, never a host-level identity, and an address at it is never a contact.
 *  - a HOSTED-SITE TENANT (jane.substack.com, jane.wordpress.com): the SUBDOMAIN is one
 *    creator's own space, the apex is the platform — so the subdomain can be owned, but
 *    `@wordpress.com` is not the creator's email domain.
 *  - an ordinary site (janeskin.com): the creator's (or a merchant's) own domain.
 *
 * Pure string logic, no network. The lists are deliberately SMALL and conservative: a
 * host missing from them is treated as an ordinary site, which is the honest default.
 */

/** Lowercased host with `www.` and a trailing dot removed; null when unparseable. */
export function normalizeHost(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  const raw = urlOrHost.trim();
  if (!raw || /^(mailto|tel|sms|javascript|data|file|about|blob):/i.test(raw)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/** True when `host` is `domain` itself or any subdomain of it. */
export function hostIsOrUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function inList(host: string, list: readonly string[]): boolean {
  return list.some((d) => hostIsOrUnder(host, d));
}

/** Social / video / community platforms — the creator is a PATH or handle, never the host. */
const SOCIAL_HOSTS = [
  "youtube.com", "youtu.be", "twitter.com", "x.com", "t.co", "instagram.com", "tiktok.com",
  "facebook.com", "fb.com", "fb.me", "m.me", "linkedin.com", "lnkd.in", "pinterest.com", "pin.it",
  "reddit.com", "redd.it", "threads.net", "snapchat.com", "twitch.tv", "discord.com", "discord.gg",
  "t.me", "telegram.me", "wa.me", "whatsapp.com", "quora.com", "vimeo.com", "soundcloud.com",
  "spotify.com", "patreon.com", "ko-fi.com", "buymeacoffee.com", "github.com", "gravatar.com",
];

/** Bio aggregators (Linktree-style) — one host, one page per creator. */
export const BIO_AGGREGATOR_HOSTS: readonly string[] = [
  "linktr.ee", "beacons.ai", "bio.link", "solo.to", "lnk.bio", "carrd.co", "tap.bio",
  "withkoji.com", "koji.to", "msha.ke", "linkpop.com", "komi.io", "snipfeed.co",
  "stan.store", "flowcode.com", "shor.by", "campsite.bio", "many.link", "pillar.io",
];

/** Retailers / marketplaces everyone links to — never a prospect, never a niche competitor. */
const MARKETPLACE_HOSTS = [
  "amzn.to", "a.co", "walmart.com", "target.com", "etsy.com", "aliexpress.com", "alibaba.com",
  "bestbuy.com", "wayfair.com", "costco.com", "homedepot.com", "lowes.com", "temu.com", "shein.com",
  "shopify.com", "gumroad.com",
];
// Country-code storefronts (amazon.co.uk, ebay.de, …) without enumerating every TLD.
const MARKETPLACE_BRAND_RE = /(^|\.)(amazon|ebay)\.[a-z]{2,3}(\.[a-z]{2})?$/;

/**
 * Search engines, big tech, payment and reference sites. Mailbox providers (yahoo.com,
 * outlook.com) are deliberately NOT here: an address at one is a person's real mailbox.
 */
const REFERENCE_HOSTS = [
  "goo.gl", "apple.com", "microsoft.com", "bing.com", "duckduckgo.com",
  "wikipedia.org", "wikimedia.org", "archive.org", "w3.org", "schema.org", "wordpress.org",
  "paypal.com", "stripe.com", "gofundme.com", "trustpilot.com", "yelp.com", "tripadvisor.com",
  "cloudflare.com", "play.google.com",
];
const REFERENCE_BRAND_RE = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

/** Link shorteners / affiliate-link cloakers — a redirector, never a destination. */
const SHORTENER_HOSTS = [
  "bit.ly", "tinyurl.com", "ow.ly", "buff.ly", "rebrand.ly", "cutt.ly", "is.gd", "t.ly",
  "shorturl.at", "geni.us", "smarturl.it", "rstyle.me", "shopstyle.it", "howl.me", "magik.ly",
];

/**
 * Hosted publishing: the APEX is the platform (shared), a SUBDOMAIN is one tenant's own
 * site. `jane.wordpress.com` can be owned; `wordpress.com` and `@wordpress.com` cannot.
 */
const HOSTED_SITE_SUFFIXES = [
  "wordpress.com", "blogspot.com", "medium.com", "substack.com", "beehiiv.com", "tumblr.com",
  "wixsite.com", "weebly.com", "squarespace.com", "webflow.io", "github.io", "gitlab.io",
  "netlify.app", "vercel.app", "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com",
  "ghost.io", "notion.site", "myshopify.com", "podbean.com", "buzzsprout.com", "libsyn.com",
  "transistor.fm", "simplecast.com", "captivate.fm", "anchor.fm", "typepad.com", "bandcamp.com",
];

/** Consumer mailbox providers — an address here is personal, and the domain is nobody's own. */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com", "yandex.com",
  "yandex.ru", "fastmail.com", "hey.com", "tutanota.com", "tuta.io", "qq.com", "163.com", "naver.com",
  "web.de", "t-online.de", "orange.fr", "free.fr", "btinternet.com", "comcast.net", "verizon.net",
  "att.net", "sbcglobal.net",
]);
const FREE_MAIL_BRAND_RE = /^(yahoo|hotmail|outlook|live)\.[a-z]{2,3}(\.[a-z]{2})?$/;

// Two-label public suffixes we must never mistake for a registrable domain.
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "com.au", "net.au", "org.au", "co.nz", "com.br", "co.jp",
  "co.in", "com.mx", "co.za", "com.sg", "com.hk", "co.kr", "com.tr", "com.ar", "com.co", "co.id",
  "com.my", "com.ph", "com.ua", "com.pl", "co.il", "com.cn", "com.tw", "co.th", "com.vn",
]);

export function isMarketplaceHost(host: string): boolean {
  return inList(host, MARKETPLACE_HOSTS) || MARKETPLACE_BRAND_RE.test(host);
}

export function isReferenceHost(host: string): boolean {
  return inList(host, REFERENCE_HOSTS) || REFERENCE_BRAND_RE.test(host);
}

export function isShortenerHost(host: string): boolean {
  return inList(host, SHORTENER_HOSTS);
}

export function isSocialHost(host: string): boolean {
  return inList(host, SOCIAL_HOSTS);
}

export function isBioAggregatorHost(host: string): boolean {
  return inList(host, BIO_AGGREGATOR_HOSTS);
}

/** The apex of a hosted-publishing platform (wordpress.com itself, not a tenant). */
function isHostedApex(host: string): boolean {
  return HOSTED_SITE_SUFFIXES.includes(host);
}

/** A tenant subdomain of a hosted-publishing platform (jane.wordpress.com). */
export function isHostedTenantHost(host: string): boolean {
  return HOSTED_SITE_SUFFIXES.some((s) => host.endsWith(`.${s}`));
}

/**
 * A host shared by many unrelated parties — never ONE creator's own site, never a
 * host-level identity, never a mineable merchant. (A hosted TENANT subdomain is not
 * shared: it belongs to one creator.)
 */
export function isSharedPlatformHost(host: string): boolean {
  return (
    isSocialHost(host) ||
    isBioAggregatorHost(host) ||
    isMarketplaceHost(host) ||
    isReferenceHost(host) ||
    isShortenerHost(host) ||
    isHostedApex(host)
  );
}

/** Hosts that can never be a prospect's site, whatever the path (retailers, search, shorteners). */
export function isNeverProspectHost(host: string): boolean {
  return isMarketplaceHost(host) || isReferenceHost(host) || isShortenerHost(host);
}

/** Lowercased domain part of an email address, or null when malformed. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain) || FREE_MAIL_BRAND_RE.test(domain);
}

/**
 * Same site: equal, or one is a subdomain of the other — as long as the shared parent
 * is a real registrable domain (not `co.uk`, not a hosting suffix like `wordpress.com`).
 */
export function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (!long.endsWith(`.${short}`)) return false;
  if (!short.includes(".") || SECOND_LEVEL_SUFFIXES.has(short)) return false;
  return !isSharedPlatformHost(short);
}

/**
 * The hosts among `hosts` whose DOMAIN an owner's email address can be at: ordinary
 * sites only. A hosted tenant (`jane.wordpress.com`) or a platform contributes none —
 * `someone@wordpress.com` is not the creator.
 */
export function ownEmailDomains(hosts: Iterable<string>): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    if (!h || isSharedPlatformHost(h) || isHostedTenantHost(h)) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** True when `email` is at one of `ownDomains` (or a sub/parent domain of one). */
export function emailAtOwnDomain(email: string, ownDomains: readonly string[]): boolean {
  const d = emailDomain(email);
  return d != null && ownDomains.some((o) => sameSite(d, o));
}
