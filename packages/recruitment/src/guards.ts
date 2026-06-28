import type { RecruitmentDeps } from "./deps.js";

/**
 * Recruitment guards (Section 8.1/8.4) — "don't pursue people you already have, can't
 * use, or shouldn't contact." These run before we spend enrichment budget on a prospect
 * and, critically, before any outreach, so the engine never cold-emails its own
 * affiliates (a credibility-killer) or someone who has opted out.
 */

/**
 * True when a prospect is ALREADY an affiliate of this merchant — matched by the
 * relationship's `prospectId` FK (converted from this exact prospect) or by the
 * affiliate's primary email. We never re-recruit an existing partner.
 */
export async function isExistingAffiliate(
  deps: RecruitmentDeps,
  merchantId: string,
  prospect: { id: string; email: string | null },
): Promise<boolean> {
  const rels = await deps.db.relationships.find((r) => r.merchantId === merchantId);
  if (rels.length === 0) return false;
  if (rels.some((r) => r.prospectId === prospect.id)) return true;
  const email = prospect.email?.toLowerCase();
  if (!email) return false;
  for (const r of rels) {
    const aff = await deps.db.affiliates.get(r.affiliateId);
    if (aff?.primaryEmail?.toLowerCase() === email) return true;
  }
  return false;
}

/**
 * The set of primary emails of this merchant's existing affiliates (lowercased).
 * Computed ONCE per sourcing run so the triage loop can cheaply skip enriching/
 * contacting people we already have, instead of scanning relationships per prospect.
 */
export async function existingAffiliateEmails(deps: RecruitmentDeps, merchantId: string): Promise<Set<string>> {
  const rels = await deps.db.relationships.find((r) => r.merchantId === merchantId);
  const emails = new Set<string>();
  for (const r of rels) {
    const aff = await deps.db.affiliates.get(r.affiliateId);
    if (aff?.primaryEmail) emails.add(aff.primaryEmail.toLowerCase());
  }
  return emails;
}
