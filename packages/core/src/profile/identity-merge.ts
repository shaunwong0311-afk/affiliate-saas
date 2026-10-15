import { accountKey, classifyAccountUrl, seedAccount, type Account, type Profile, type Provenance } from "./identity.js";
import { emailAtOwnDomain, isSharedPlatformHost, normalizeHost, ownEmailDomains } from "./hosts.js";

/**
 * Prospect-level identity resolution (Section 8.1). The identity GRAPH unifies the
 * surfaces of one creator WITHIN a prospect; this resolves whether a NEW candidate is
 * actually the SAME creator as an EXISTING prospect found via a different channel —
 * e.g. a YouTube channel discovered on its own, then the creator's website surfaced by
 * backlink mining. When they share a hard identifier we merge instead of creating a
 * duplicate, building one comprehensive profile per person.
 *
 * "Hard identifier" = a shared social account/handle, a shared website domain, or a
 * shared contact email AT THE CREATOR'S OWN DOMAIN. We deliberately do NOT merge on a
 * shared name (two people can share one), on a platform host without a handle (every
 * YouTube video is not one creator), or on an email at someone else's domain (two blogs
 * that both print an ad network's address are not the same blog).
 */

export interface IdentitySignals {
  /**
   * STRONG per-account keys ("youtube:@handle", "twitter:@x", "url:<normalized>") — an
   * account we're confident the creator OWNS (provenance seed/bio_aggregator/reciprocal,
   * or confidence ≥ 0.85). A strong key can establish a merge on its own.
   */
  accountKeys: Set<string>;
  /**
   * WEAK per-account keys — a one-directional `page_link` (0.5): the creator's page merely
   * LINKS this account (could be a friend/sponsor/quoted post, not them). A weak key only
   * corroborates a merge against a STRONG key on the other side; two weak keys never merge
   * (else two blogs linking the same brand's Instagram would collapse into one creator).
   */
  weakAccountKeys: Set<string>;
  /**
   * Lowercased contact emails AT THE CREATOR'S OWN DOMAIN — the only emails that are a
   * hard identifier. An address at any other domain (an ad network, an agency, a free
   * mailbox printed in a footer) is dropped here and can never establish a merge.
   */
  emails: Set<string>;
  /** The creator's own website domain(s) (from an owned/seed website — a hard identifier). */
  domains: Set<string>;
}

const STRONG_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["seed", "bio_aggregator", "reciprocal_link"]);

/** An account we trust the creator OWNS (not a mere one-directional link). */
export function isStrongAccount(a: Pick<Account, "provenance" | "confidence">): boolean {
  return STRONG_PROVENANCE.has(a.provenance) || a.confidence >= 0.85;
}

/** Extract the hard identifiers from a prospect's profile graph + known emails. */
export function identitySignalsFromProfile(profile: Profile | null, emails: ReadonlyArray<string | null | undefined>): IdentitySignals {
  const accountKeys = new Set<string>();
  const weakAccountKeys = new Set<string>();
  const domains = new Set<string>();
  for (const a of profile?.accounts ?? []) {
    // Re-derive the key from the URL with TODAY's parser rather than trusting the stored
    // handle: profiles persisted before the handle parser was platform-aware carry bogus
    // identities (`instagram:@p`, a "website" at youtube.com) that must not match anything.
    const current = a.platform === "website" ? seedAccount(a.url) : classifyAccountUrl(a.url);
    if (!current) continue;
    const strong = isStrongAccount(a);
    (strong ? accountKeys : weakAccountKeys).add(accountKey(current));
    // A domain is a hard identifier only for a site the creator owns — never a platform host.
    if (strong && current.platform === "website") {
      const d = normalizeHost(current.url);
      if (d && !isSharedPlatformHost(d)) domains.add(d);
    }
  }
  const own = ownEmailDomains(domains);
  const em = new Set<string>();
  for (const e of emails) {
    if (e && emailAtOwnDomain(e, own)) em.add(e.toLowerCase());
  }
  return { accountKeys, weakAccountKeys, emails: em, domains };
}

/** Whether a signal set carries any identifier at all (else not mergeable). */
export function hasIdentitySignal(s: IdentitySignals): boolean {
  return s.accountKeys.size > 0 || s.weakAccountKeys.size > 0 || s.emails.size > 0 || s.domains.size > 0;
}

/**
 * An identity-key index: hard identifier → the id it was first registered under. THE one
 * implementation of "do these two signal sets describe the same creator?" — the ingest
 * path builds one per merchant so each candidate resolves in O(1) instead of rescanning
 * every prospect.
 *
 * A STRONG identifier (owned account, own-domain email, own domain) matches an existing
 * strong OR weak key; a WEAK (page_link) account key matches only an existing STRONG key.
 * Two weak keys never match — both sides merely link the account. First writer wins per
 * key, so a match resolves to the earliest-registered id.
 */
export class IdentityKeyIndex {
  private readonly strong = new Map<string, string>(); // strong account keys + emails + domains
  private readonly weak = new Map<string, string>(); // page_link account keys

  add(id: string, s: IdentitySignals): void {
    for (const k of strongKeys(s)) if (!this.strong.has(k)) this.strong.set(k, id);
    for (const k of s.weakAccountKeys) {
      const wk = `a:${k}`;
      if (!this.weak.has(wk)) this.weak.set(wk, id);
    }
  }

  lookup(s: IdentitySignals): string | null {
    for (const k of strongKeys(s)) {
      const id = this.strong.get(k) ?? this.weak.get(k); // strong↔strong or strong↔weak
      if (id) return id;
    }
    for (const k of s.weakAccountKeys) {
      const id = this.strong.get(`a:${k}`); // weak↔strong only (never weak↔weak)
      if (id) return id;
    }
    return null;
  }
}

function* strongKeys(s: IdentitySignals): Iterable<string> {
  for (const k of s.accountKeys) yield `a:${k}`;
  for (const e of s.emails) yield `e:${e}`;
  for (const d of s.domains) yield `d:${d}`;
}
