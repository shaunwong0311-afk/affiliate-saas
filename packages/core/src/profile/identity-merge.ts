import type { Profile } from "./identity.js";

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
  /** Strong per-account keys: "youtube:@handle", "twitter:@x", or "url:<normalized>". */
  accountKeys: Set<string>;
  /** Lowercased contact emails. */
  emails: Set<string>;
  /** The creator's own website domain(s). */
  domains: Set<string>;
}

/** Extract the hard identifiers from a prospect's profile graph + known emails. */
export function identitySignalsFromProfile(profile: Profile | null, emails: ReadonlyArray<string | null | undefined>): IdentitySignals {
  const accountKeys = new Set<string>();
  const domains = new Set<string>();
  for (const a of profile?.accounts ?? []) {
    if (a.handle) {
      accountKeys.add(`${a.platform}:${a.handle.toLowerCase()}`);
    } else {
      accountKeys.add(`url:${a.url.toLowerCase().replace(/\/+$/, "")}`);
      if (a.platform === "website") {
        const d = rootDomain(a.url);
        if (d) domains.add(d);
      }
    }
  }
  const em = new Set<string>();
  for (const e of emails) if (e) em.add(e.toLowerCase());
  return { accountKeys, emails: em, domains };
}

/** True when two identity-signal sets share any hard identifier (→ same creator). */
export function identitiesOverlap(a: IdentitySignals, b: IdentitySignals): boolean {
  for (const k of a.accountKeys) if (b.accountKeys.has(k)) return true;
  for (const e of a.emails) if (b.emails.has(e)) return true;
  for (const d of a.domains) if (b.domains.has(d)) return true;
  return false;
}

/** Whether a signal set carries any hard identifier at all (else not mergeable). */
export function hasIdentitySignal(s: IdentitySignals): boolean {
  return s.accountKeys.size > 0 || s.emails.size > 0 || s.domains.size > 0;
}
