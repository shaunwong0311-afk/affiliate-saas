import {
  accountKey,
  classifyAccountUrl,
  emailDomain,
  hostIsOrUnder,
  isFreeMailDomain,
  isNeverProspectHost,
  isSharedPlatformHost,
  normalizeHost,
  sameSite,
} from "@affiliate/core";
import type { Merchant } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";

/**
 * Recruitment guards (Section 8.1/8.4) — "don't pursue people you already have, can't
 * use, or shouldn't contact." These run before we spend enrichment budget on a prospect
 * and, critically, before any outreach, so the engine never cold-emails its own
 * affiliates (a credibility-killer), someone who has opted out, a competitor, or the
 * merchant themselves.
 */

// ---- Who must never become a prospect (or a prospect's contact) ---------------

/**
 * The domains a merchant's discovery must keep away from, computed once per run:
 *  - `competitorDomains` — the rivals named in the ICP. "<competitor> review" ranks the
 *    competitor's own site first; it is not an affiliate and `hello@<competitor>` is not
 *    a creator.
 *  - `merchantDomains` — the merchant's OWN domains. There is no "website" field on a
 *    merchant, so they are derived from what the merchant has connected: the domains of
 *    its mailboxes and its sending domains (a mailbox at a consumer provider — gmail.com
 *    — says nothing about what the merchant owns and is ignored).
 */
export interface IngestExclusions {
  competitorDomains: string[];
  merchantDomains: string[];
}

/** The merchant's own domains, from its connected mailboxes and sending domains. */
export async function merchantOwnDomains(deps: RecruitmentDeps, merchantId: string): Promise<string[]> {
  const out = new Set<string>();
  const add = (domain: string | null | undefined) => {
    const d = domain ? normalizeHost(domain) : null;
    if (d && !isFreeMailDomain(d) && !isSharedPlatformHost(d)) out.add(d);
  };
  for (const m of await deps.db.mailboxes.find((x) => x.merchantId === merchantId)) add(emailDomain(m.email));
  for (const s of await deps.db.sendingDomains.find((x) => x.merchantId === merchantId)) add(s.domain);
  return [...out];
}

/** Build the exclusion set for one merchant (one pair of reads — reuse it across a run). */
export async function ingestExclusionsFor(deps: RecruitmentDeps, merchant: Pick<Merchant, "id" | "competitors">): Promise<IngestExclusions> {
  const competitorDomains = [...new Set(merchant.competitors.map((c) => normalizeHost(c)).filter((c): c is string => !!c))];
  return { competitorDomains, merchantDomains: await merchantOwnDomains(deps, merchant.id) };
}

/** Every domain an accepted contact address must not be at (competitors + the merchant's own). */
export function excludedContactDomains(ex: IngestExclusions): string[] {
  return [...ex.competitorDomains, ...ex.merchantDomains];
}

/**
 * Why a discovered candidate must NOT become a prospect, or null when it may.
 *  - its site (or channel) is on a competitor's own domain, or on the merchant's own;
 *  - its "site" is a retailer / marketplace / search engine / link shortener;
 *  - its "site" is a bare platform host (`https://youtube.com`) — a platform is where
 *    creators live, not a creator. A platform URL that names a page
 *    (`reddit.com/r/…`, `medium.com/@author`) is still allowed.
 * `trusted` skips the retailer/platform denylist for candidates the MERCHANT supplied
 * (a spreadsheet import may legitimately list a creator's storefront URL); the
 * competitor / own-domain rules always apply.
 */
export function ingestExclusionReason(
  cand: { siteUrl: string | null; channelUrl: string | null },
  ex: IngestExclusions,
  opts: { trusted?: boolean } = {},
): string | null {
  for (const url of [cand.siteUrl, cand.channelUrl]) {
    const host = normalizeHost(url);
    if (!host) continue;
    if (ex.competitorDomains.some((d) => hostIsOrUnder(host, d))) return `${host} is a competitor's own domain`;
    if (ex.merchantDomains.some((d) => hostIsOrUnder(host, d))) return `${host} is the merchant's own domain`;
  }
  if (opts.trusted) return null;
  const siteHost = normalizeHost(cand.siteUrl);
  if (siteHost) {
    if (isNeverProspectHost(siteHost)) return `${siteHost} is a retailer / search / shortener host, not a prospect`;
    if (isSharedPlatformHost(siteHost) && isBareHostUrl(cand.siteUrl!)) return `${siteHost} is a platform, not a creator's own site`;
  }
  return null;
}

function isBareHostUrl(url: string): boolean {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.pathname.replace(/\/+$/, "") === "";
  } catch {
    return true;
  }
}

// ---- Who is already an affiliate ------------------------------------------------

/**
 * Everything that identifies this merchant's EXISTING affiliates, computed once per run.
 * A roster rarely lists the exact address discovery will find — `star@creator.com` is on
 * file, the engine turns up the site creator.com with `hello@creator.com` — so an
 * exact-email match alone lets the engine cold-email a partner the merchant already has.
 * A prospect is an existing affiliate when:
 *  - a relationship was converted from that very prospect; or
 *  - its email IS an affiliate's email; or
 *  - its SITE is an affiliate's site, or sits at the domain of an affiliate's mailbox
 *    (creator.com ↔ star@creator.com — consumer mailbox providers never count); or
 *  - its email is at the domain of an affiliate's SITE; or
 *  - its channel is one of an affiliate's platform accounts.
 * Deliberately NOT a rule: "same email domain as some affiliate". Two people at one
 * agency, university or regional ISP share a domain without being the same partner,
 * and a false match here silently kills a good prospect.
 */
export interface ExistingAffiliateIndex {
  emails: Set<string>;
  /** Sites affiliates own (their roster entry, or the prospect they were converted from). */
  siteDomains: Set<string>;
  /** Non-consumer domains of affiliates' mailboxes. */
  emailDomains: Set<string>;
  accountKeys: Set<string>;
  /** Relationship → prospect links (a recruit converted from this exact prospect). */
  prospectIds: Set<string>;
  /** True when the prospect is one of the merchant's existing affiliates. */
  matches(prospect: { id?: string; email?: string | null; siteUrl?: string | null; channelUrl?: string | null }): boolean;
}

export async function existingAffiliateIndex(deps: RecruitmentDeps, merchantId: string): Promise<ExistingAffiliateIndex> {
  const emails = new Set<string>();
  const siteDomains = new Set<string>();
  const emailDomains = new Set<string>();
  const accountKeys = new Set<string>();
  const prospectIds = new Set<string>();

  const addSurface = (url: string | null | undefined) => {
    if (!url) return;
    const account = classifyAccountUrl(url);
    if (account) {
      accountKeys.add(accountKey(account));
      return;
    }
    const host = normalizeHost(url);
    if (host && !isSharedPlatformHost(host)) siteDomains.add(host);
  };

  const rels = await deps.db.relationships.find((r) => r.merchantId === merchantId);
  for (const r of rels) {
    if (r.prospectId) {
      prospectIds.add(r.prospectId);
      const source = await deps.db.prospects.get(r.prospectId);
      addSurface(source?.siteUrl);
      addSurface(source?.channelUrl);
    }
    const aff = await deps.db.affiliates.get(r.affiliateId);
    if (!aff) continue;
    if (aff.primaryEmail) {
      emails.add(aff.primaryEmail.toLowerCase());
      const d = emailDomain(aff.primaryEmail);
      if (d && !isFreeMailDomain(d) && !isSharedPlatformHost(d)) emailDomains.add(d);
    }
    const channels = (aff.audienceProfile as { channels?: unknown } | null)?.channels;
    if (Array.isArray(channels)) for (const c of channels) if (typeof c === "string") addSurface(c);
  }

  const within = (host: string, set: Set<string>): boolean => [...set].some((d) => sameSite(host, d));
  const matches: ExistingAffiliateIndex["matches"] = (p) => {
    if (p.id && prospectIds.has(p.id)) return true;
    const email = p.email?.toLowerCase();
    if (email) {
      if (emails.has(email)) return true;
      const d = emailDomain(email);
      if (d && !isFreeMailDomain(d) && within(d, siteDomains)) return true;
    }
    for (const url of [p.siteUrl, p.channelUrl]) {
      if (!url) continue;
      const account = classifyAccountUrl(url);
      if (account) {
        if (accountKeys.has(accountKey(account))) return true;
        continue;
      }
      const host = normalizeHost(url);
      if (host && !isSharedPlatformHost(host) && (within(host, siteDomains) || within(host, emailDomains))) return true;
    }
    return false;
  };

  return { emails, siteDomains, emailDomains, accountKeys, prospectIds, matches };
}

/**
 * True when a prospect is ALREADY an affiliate of this merchant — see
 * {@link ExistingAffiliateIndex} for what counts. We never re-recruit an existing partner.
 */
export async function isExistingAffiliate(
  deps: RecruitmentDeps,
  merchantId: string,
  prospect: { id: string; email: string | null; siteUrl?: string | null; channelUrl?: string | null },
): Promise<boolean> {
  return (await existingAffiliateIndex(deps, merchantId)).matches(prospect);
}
