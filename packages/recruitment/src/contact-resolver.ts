import {
  accountKey,
  addPageToProfile,
  buildProfile,
  classifyAccountUrl,
  emailAtOwnDomain,
  emailDomain,
  hostIsOrUnder,
  isFreeMailDomain,
  isSharedPlatformHost,
  isStrongAccount,
  normalizeHost,
  ownEmailDomains,
  sameSite,
  seedAccount,
  type Profile,
} from "@affiliate/core";
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
 * ENTERED, this walks the creator's properties and EXPANDS as it goes. It stops at the
 * first DELIVERABLE address or when the bounded fetch budget is spent.
 *
 * THE RULE THAT MAKES IT HONEST: an address is only ever taken from a surface the
 * creator demonstrably OWNS — never from a page that is merely linked to. Creators link
 * to sponsors, brands, the agency that built their site and other people's Linktrees; a
 * link is an invitation to look, not proof of ownership. A surface is owned when it is
 *
 *   - the prospect's own site (the seed's host, any page on it), or the seed account;
 *   - an account already in the graph with seed / bio-aggregator / reciprocal provenance;
 *   - a linked surface that LINKS BACK to something owned (the creator's site links a
 *     Linktree and that Linktree lists the site; a channel description links a website
 *     and the website links the channel). Anything reached from an owned surface is a
 *     CANDIDATE; it is fetched once to look for that back-link, and if there is none its
 *     addresses, its links and its contact form are all ignored.
 *
 * One address needs no such proof: an address at the prospect's OWN domain is theirs
 * wherever it is printed. And even on an owned surface an address is refused when it is
 * at a competitor's or the merchant's own domain, at a platform's domain, or — for a
 * prospect that has its own domain — at some third party's (see {@link contactRejection}).
 */

export interface ContactResolution {
  email: string | null;
  /** Where it was found, e.g. "youtube_api:description", "bio_aggregator:mailto", "page:mailto", "feed_owner". */
  source: string | null;
  /** The identity graph, grown by every OWNED surface the traversal read. */
  profile: Profile | null;
  contactForm: boolean;
  contactFormUrl: string | null;
  /** Addresses that were found and REFUSED, with the reason — so "no contact" is explainable. */
  rejected: { email: string; reason: string }[];
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
  /**
   * Emails already on file for the seed surface (tried first, no fetch). A `source` of
   * `feed_owner` / `import` marks an address the discovery source itself vouched for.
   */
  knownEmails: { email: string; source: string }[];
  /** Contact URLs already discovered (Linktree, /contact, YouTube About). */
  knownContactUrls: { url: string; kind: string }[];
  contactForm?: boolean;
  contactFormUrl?: string | null;
  /** Max page fetches for the whole traversal (API calls are free, not counted). */
  maxFetches?: number;
  /** Domains an accepted address must never be at: the competitors' and the merchant's own. */
  excludedDomains?: string[];
}

// ---- Which addresses may be a prospect's contact --------------------------------

export interface ContactPolicy {
  /** Website hosts the creator owns. */
  ownDomains: string[];
  /** Domains an address must never be at (competitors + the merchant's own). */
  excludedDomains: string[];
}

/** Sources where the DISCOVERY SOURCE vouched for the address (not scraped off a page). */
const VOUCHED_SOURCES = new Set(["feed_owner", "import"]);

/**
 * Why an address must not be used as this prospect's contact, or null when it may.
 * `vouched` = the discovery source itself established the address (a podcast feed's
 * declared owner, a merchant's import) — it may then sit at any ordinary domain.
 */
export function contactRejection(email: string, policy: ContactPolicy, opts: { vouched?: boolean } = {}): string | null {
  const domain = emailDomain(email);
  if (!domain) return "malformed address";
  if (policy.excludedDomains.some((d) => hostIsOrUnder(domain, d))) return "at a competitor's or the merchant's own domain";
  if (isFreeMailDomain(domain)) return null; // a personal mailbox
  if (isSharedPlatformHost(domain)) return "at a platform's domain, not the creator's";
  if (opts.vouched) return null;
  // A prospect with its own domain is reached AT it (or at a personal mailbox). Any other
  // company's address on their pages is an ad network, an agency, a sponsor — not them.
  const own = ownEmailDomains(policy.ownDomains);
  if (own.length && !own.some((o) => sameSite(domain, o))) return "at a third party's domain, not the prospect's own";
  return null;
}

/** Lower = try first: vouched by the source, then the prospect's own domain, then a personal mailbox, then the rest. */
function contactRank(email: string, policy: ContactPolicy, vouched: boolean): number {
  if (vouched) return 0;
  const domain = emailDomain(email);
  if (domain && ownEmailDomains(policy.ownDomains).some((o) => sameSite(domain, o))) return 1;
  if (domain && isFreeMailDomain(domain)) return 2;
  return 3;
}

/**
 * The usable addresses among `emails`, best first, and the refused ones with reasons.
 * Also used at ingest to decide which page addresses are worth keeping.
 */
export function screenContacts(
  emails: ReadonlyArray<{ email: string; source: string }>,
  policy: ContactPolicy,
): { usable: { email: string; source: string }[]; rejected: { email: string; reason: string }[] } {
  const usable: { email: string; source: string; rank: number; i: number }[] = [];
  const rejected: { email: string; reason: string }[] = [];
  emails.forEach((e, i) => {
    const vouched = VOUCHED_SOURCES.has(e.source);
    const reason = contactRejection(e.email, policy, { vouched });
    if (reason) rejected.push({ email: e.email, reason });
    else usable.push({ ...e, rank: contactRank(e.email, policy, vouched), i });
  });
  usable.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return { usable: usable.map(({ email, source }) => ({ email, source })), rejected };
}

// ---- What the creator owns ------------------------------------------------------

/** The surfaces established as the creator's own, growing as the traversal proves more. */
class Ownership {
  /** Website hosts. */
  readonly hosts = new Set<string>();
  /** Platform account keys (`youtube:@x`, `linktree:linktr.ee/x`, …). */
  readonly accounts = new Set<string>();

  constructor(seedUrl: string | null, profile: Profile | null) {
    if (seedUrl) this.claim(seedUrl);
    for (const a of profile?.accounts ?? []) if (isStrongAccount(a)) this.claim(a.url);
  }

  /** Record a URL as the creator's own surface. A bare platform URL names nobody and is ignored. */
  claim(url: string): void {
    const account = seedAccount(url);
    if (!account) return;
    if (account.platform === "website") {
      const host = normalizeHost(account.url);
      if (host) this.hosts.add(host);
    } else {
      this.accounts.add(accountKey(account));
    }
  }

  /** Is this URL on a surface already known to be the creator's? */
  owns(url: string): boolean {
    const account = classifyAccountUrl(url);
    if (account) return this.accounts.has(accountKey(account));
    const host = normalizeHost(url);
    return !!host && !isSharedPlatformHost(host) && [...this.hosts].some((h) => sameSite(host, h));
  }
}

// ---- The traversal ----------------------------------------------------------------

type Kind = "contact_page" | "bio_aggregator" | "website" | "youtube" | "social";

interface Candidate {
  url: string;
  kind: Kind;
  /** Lower = tried first, among candidates of equal ownership. */
  priority: number;
  handle?: string | null;
  viaApi?: boolean;
}

const KIND_PRIORITY: Record<Kind, number> = { contact_page: 1, bio_aggregator: 2, youtube: 2, website: 3, social: 5 };
/** Addresses verified per surface (verification can be a paid call). */
const MAX_VERIFY_PER_SURFACE = 3;
/** Unproven websites followed from one surface (each costs a fetch just to look for a back-link). */
const MAX_WEBSITE_LEADS = 3;
/**
 * Unproven YouTube channels looked up per prospect. The lookup is "free" but spends API
 * quota, and an article that links ten creators' channels would otherwise spend it on all ten.
 */
const MAX_CHANNEL_LEADS = 3;

function norm(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

export async function resolveContact(deps: ResolveDeps, input: ResolveInput): Promise<ContactResolution> {
  let profile = input.profile;
  let contactForm = input.contactForm ?? false;
  let contactFormUrl = input.contactFormUrl ?? null;
  const rejected: { email: string; reason: string }[] = [];
  const own = new Ownership(input.seedUrl, profile);
  const policy = (): ContactPolicy => ({ ownDomains: [...own.hosts], excludedDomains: input.excludedDomains ?? [] });

  const result = (email: string | null, source: string | null): ContactResolution => ({
    email,
    source,
    profile,
    contactForm,
    contactFormUrl,
    rejected: rejected.slice(0, 5),
  });
  const verify = (e: string) => deps.verify(e).catch(() => ({ deliverable: false }));

  /** Screen, rank, then verify the best few; the first deliverable one wins. */
  const firstDeliverable = async (
    emails: ReadonlyArray<{ email: string; source: string }>,
    label: (source: string) => string,
  ): Promise<ContactResolution | null> => {
    const screened = screenContacts(emails, policy());
    for (const r of screened.rejected) if (!rejected.some((x) => x.email === r.email)) rejected.push(r);
    for (const c of screened.usable.slice(0, MAX_VERIFY_PER_SURFACE)) {
      if ((await verify(c.email)).deliverable) return result(c.email, label(c.source));
    }
    return null;
  };

  // 1) Addresses already on file for the seed surface — free, try first. A source-vouched
  //    address (a podcast feed's declared owner) keeps its own label.
  const known = await firstDeliverable(input.knownEmails, (source) => (VOUCHED_SOURCES.has(source) ? source : `page:${source}`));
  if (known) return known;
  if (!input.canFetch) return result(null, null);

  // 2) Build the traversal frontier from the known contact URLs + every graph account.
  const visited = new Set<string>();
  const seedHost = input.seedUrl ? normalizeHost(input.seedUrl) : null;
  if (seedHost && input.seedUrl) {
    // The seed page was already fetched upstream (its emails/links are passed in). Mark every
    // key shape it can dequeue as, so it is never re-fetched and never spends a budget slot.
    visited.add(norm(`https://${seedHost}`));
    visited.add(norm(input.seedUrl));
    const seedAcc = classifyAccountUrl(input.seedUrl);
    if (seedAcc) visited.add(norm(seedAcc.url));
  }

  const queue: Candidate[] = [];
  const enqueue = (c: Candidate) => {
    const key = (c.viaApi ? "api:" : "") + norm(c.url);
    if (visited.has(key)) return;
    if (queue.some((q) => norm(q.url) === norm(c.url) && !!q.viaApi === !!c.viaApi)) return;
    queue.push(c);
  };
  /** Turn a URL into the right kind of candidate (null = not something to follow). */
  const candidateFor = (url: string, hint?: Kind): Candidate | null => {
    const account = classifyAccountUrl(url.replace(/\/about\/?$/i, ""));
    if (account?.platform === "youtube") return { url: account.url, kind: "youtube", priority: KIND_PRIORITY.youtube, handle: account.handle, viaApi: true };
    if (account?.platform === "linktree") return { url: account.url, kind: "bio_aggregator", priority: KIND_PRIORITY.bio_aggregator };
    if (account) return { url: account.url, kind: "social", priority: KIND_PRIORITY.social };
    const host = normalizeHost(url);
    if (!host || isSharedPlatformHost(host)) return null; // a retailer, a shortener, a bare platform — nobody's own page
    if (hint === "contact_page") return { url, kind: "contact_page", priority: KIND_PRIORITY.contact_page };
    return { url: `https://${host}`, kind: "website", priority: KIND_PRIORITY.website };
  };

  for (const cu of input.knownContactUrls) {
    // A "contact page" is only that on the creator's own site.
    if (cu.kind === "contact_page" && !own.owns(cu.url)) continue;
    const c = candidateFor(cu.url, cu.kind === "contact_page" ? "contact_page" : undefined);
    if (c) enqueue(c);
  }
  for (const a of profile?.accounts ?? []) {
    const c = candidateFor(a.url);
    if (c) enqueue(c);
  }

  /**
   * Follow the links of a surface we OWN. Same-site contact pages are ours by
   * construction. Everything else is a lead that must prove itself when fetched:
   * bio pages and YouTube channels always (cheap, and where creators keep their
   * address); other websites only when `followWebsites` — i.e. from a bio or a channel
   * description, where "my website" is plausibly among the links. A WEBSITE's outbound
   * links to other websites are sponsors, sources and the agency in the footer — never
   * followed.
   */
  const expand = (html: string | null, links: string[], from: string, followWebsites: boolean) => {
    if (html) {
      for (const cu of discoverContactUrls(html, from)) {
        if (cu.kind === "contact_page" && !own.owns(cu.url)) continue;
        const c = candidateFor(cu.url, cu.kind === "contact_page" ? "contact_page" : undefined);
        if (c) enqueue(c);
      }
    }
    let websiteLeads = 0;
    for (const link of links) {
      const c = candidateFor(link);
      if (!c || own.owns(link) && c.kind === "website") continue; // our own site again
      if (c.kind === "website") {
        if (!followWebsites || websiteLeads >= MAX_WEBSITE_LEADS) continue;
        websiteLeads++;
      }
      enqueue(c);
    }
  };

  let fetches = 0;
  let channelLeads = 0;
  const budget = input.maxFetches ?? 6;

  while (queue.length && fetches < budget) {
    // Surfaces already known to be the creator's go first; leads are tried with what is left.
    queue.sort((a, b) => Number(!own.owns(a.url)) - Number(!own.owns(b.url)) || a.priority - b.priority);
    const cand = queue.shift()!;
    const vkey = (cand.viaApi ? "api:" : "") + norm(cand.url);
    if (visited.has(vkey)) continue;
    visited.add(vkey);

    // --- YouTube via the Data API description (free, no captcha) ---
    if (cand.viaApi) {
      if (!deps.enricher?.supports("youtube")) continue;
      if (!own.owns(cand.url) && ++channelLeads > MAX_CHANNEL_LEADS) continue;
      const m = await deps.enricher.enrich({ platform: "youtube", handle: cand.handle ?? null, url: cand.url }).catch(() => null);
      if (!m) continue; // API call — not charged against the fetch budget
      const links = m.links ?? [];
      // The channel answers to its id and its handle; either spelling is the same account.
      const spellings = [cand.url, ...(m.aliases ?? [])];
      let owned = spellings.some((u) => own.owns(u));
      const proven = !owned && links.some((l) => own.owns(l)); // its description links back to something of ours
      if (proven) owned = true;
      if (!owned) continue; // a channel that is merely linked: its description is not this creator's word
      for (const u of spellings) own.claim(u);
      profile = profile ?? buildProfile(input.seedUrl, []);
      profile = addPageToProfile(profile, { url: cand.url, links, owned: proven }, input.seedUrl);

      const hit = await firstDeliverable(
        (m.emails ?? []).map((email) => ({ email, source: "description" })),
        () => "youtube_api:description",
      );
      if (hit) return hit;
      expand(null, links, cand.url, true);
      continue;
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

    const links = extractHrefs(html, cand.url);
    const pageEmails = extractEmailsFromHtml(html);
    let owned = own.owns(cand.url);
    const proven = !owned && links.some((l) => own.owns(l)); // it links back to something of ours
    if (proven) owned = true;

    if (!owned) {
      // Not shown to be the creator's: ignore the page — its addresses belong to whoever
      // runs it. The single exception is an address at the creator's OWN domain.
      const ownDomains = ownEmailDomains(own.hosts);
      const hit = await firstDeliverable(
        pageEmails.filter((e) => emailAtOwnDomain(e.email, ownDomains)),
        (source) => `${cand.kind}:${source}`,
      );
      if (hit) return hit;
      continue;
    }

    own.claim(cand.url);
    // Grow the identity graph from this page's links. Accounts listed on the creator's own
    // bio page are theirs; `owned` records a surface proven by its back-link.
    const isBio = cand.kind === "bio_aggregator";
    profile = profile ?? buildProfile(input.seedUrl, []);
    profile = addPageToProfile(profile, { url: cand.url, links, bioAggregator: isBio, owned: proven }, input.seedUrl);
    if (isBio) {
      for (const link of links) {
        const account = classifyAccountUrl(link);
        if (account) own.claim(account.url);
      }
    }

    const hit = await firstDeliverable(pageEmails, (source) => `${cand.kind}:${source}`);
    if (hit) return hit;
    if (!contactForm && detectsContactForm(html)) {
      contactForm = true;
      contactFormUrl = cand.url;
    }
    expand(html, links, cand.url, isBio || cand.kind === "social");
  }

  return result(null, null);
}
