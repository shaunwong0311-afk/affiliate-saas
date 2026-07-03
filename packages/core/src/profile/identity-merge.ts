import type { Account, Profile, Provenance } from "./identity.js";

/**
 * Prospect-level identity resolution (Section 8.1). The identity GRAPH unifies the
 * surfaces of one creator WITHIN a prospect; this resolves whether a NEW candidate is
 * actually the SAME creator as an EXISTING prospect found via a different channel —
 * e.g. a YouTube channel discovered on its own, then the creator's website surfaced by
 * backlink mining. When they share a hard identifier we merge instead of creating a
 * duplicate, building one comprehensive profile per person.
 *
 * "Hard identifier" = a shared social account/handle, a shared contact email, or a
 * shared website domain. We deliberately do NOT merge on a shared name alone (two
 * different people can share a name) or on a shared platform host without a handle.
 */

function rootDomain(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

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
  /** Lowercased contact emails (always a hard identifier). */
  emails: Set<string>;
  /** The creator's own website domain(s) (from an owned/seed website — a hard identifier). */
  domains: Set<string>;
}

const STRONG_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["seed", "bio_aggregator", "reciprocal_link"]);

/** An account we trust the creator OWNS (not a mere one-directional link). */
function isStrongAccount(a: Account): boolean {
  return STRONG_PROVENANCE.has(a.provenance) || a.confidence >= 0.85;
}

/** Extract the hard identifiers from a prospect's profile graph + known emails. */
export function identitySignalsFromProfile(profile: Profile | null, emails: ReadonlyArray<string | null | undefined>): IdentitySignals {
  const accountKeys = new Set<string>();
  const weakAccountKeys = new Set<string>();
  const domains = new Set<string>();
  for (const a of profile?.accounts ?? []) {
    const key = a.handle ? `${a.platform}:${a.handle.toLowerCase()}` : `url:${a.url.toLowerCase().replace(/\/+$/, "")}`;
    const strong = isStrongAccount(a);
    (strong ? accountKeys : weakAccountKeys).add(key);
    // A domain is only a hard identifier when it comes from an account we trust they own.
    if (strong && a.platform === "website" && !a.handle) {
      const d = rootDomain(a.url);
      if (d) domains.add(d);
    }
  }
  const em = new Set<string>();
  for (const e of emails) if (e) em.add(e.toLowerCase());
  return { accountKeys, weakAccountKeys, emails: em, domains };
}

/**
 * True when two identity-signal sets share a hard identifier (→ same creator). A shared
 * account key counts only when it is STRONG on at least one side (strong↔strong or
 * strong↔weak); a purely weak↔weak account match does NOT (both sides merely link it).
 * Emails and domains are hard identifiers and always count.
 */
export function identitiesOverlap(a: IdentitySignals, b: IdentitySignals): boolean {
  // a-strong matched by b (strong or weak): strong↔strong and strong↔weak.
  for (const k of a.accountKeys) if (b.accountKeys.has(k) || b.weakAccountKeys.has(k)) return true;
  // b-strong matched by a-weak: the symmetric weak↔strong case.
  for (const k of b.accountKeys) if (a.weakAccountKeys.has(k)) return true;
  for (const e of a.emails) if (b.emails.has(e)) return true;
  for (const d of a.domains) if (b.domains.has(d)) return true;
  return false;
}

/** Whether a signal set carries any identifier at all (else not mergeable). */
export function hasIdentitySignal(s: IdentitySignals): boolean {
  return s.accountKeys.size > 0 || s.weakAccountKeys.size > 0 || s.emails.size > 0 || s.domains.size > 0;
}
