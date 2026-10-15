import { emailDomain, hostIsOrUnder, newId } from "@affiliate/core";
import { unsafeUrlReason, type RawCandidate } from "@affiliate/integrations";
import type { RecruitmentDeps } from "./deps.js";
import { excludedContactDomains, ingestExclusionReason, ingestExclusionsFor } from "./guards.js";
import { ingestCandidate, buildIdentityIndex } from "./pipeline.js";

/**
 * Bulk import (AUDIT-2026-07 #46). Two entry points migrants need on day one:
 *
 *  - importProspects: a spreadsheet of creators the merchant already wants to contact →
 *    real prospects (synthetic:false) via the SAME ingestCandidate path as discovery, so
 *    dedup + cross-platform identity merge come for free.
 *  - importAffiliateRoster: their existing affiliates from Refersion/GRIN/ShareASale →
 *    Affiliate + active Relationship. This ALSO protects them: discovery's isExistingAffiliate
 *    guard keys on the relationship/affiliate email, so once imported they can never be
 *    cold-emailed. Historical sales (producedRevenueCents) seed a `produced_sales` outcome so
 *    the learning loop warm-starts from the merchant's real history instead of cold priors.
 *
 * Both are honest: nothing is fabricated — a row with no usable identifier is skipped.
 */

export interface ProspectImportRow {
  name: string;
  email?: string | null;
  siteUrl?: string | null;
  channelUrl?: string | null;
  notes?: string | null;
}

export interface ProspectImportResult {
  imported: number; // net-new prospects created
  merged: number; // rows that matched an existing prospect (deduped)
  skipped: number; // rows with no usable identifier
  /** Rows refused because they point at a competitor's or the merchant's own domain. */
  excluded: number;
  /** URLs dropped from rows because they are not a public http(s) address (the row may still import). */
  rejectedUrls: number;
}

/**
 * An import row's URL is USER INPUT that the engine will later fetch. Accept only what
 * could be a public web page: http(s), no embedded credentials, not localhost / an
 * internal name / a private or metadata IP in any spelling. (A hostname that merely
 * RESOLVES to a private address passes here and is refused at fetch time by the outbound
 * guard — this is the cheap, synchronous half.) A bare `example.com` gets `https://`.
 */
function cleanImportUrl(raw: string | null | undefined): { url: string | null; rejected: boolean } {
  const text = raw?.trim();
  if (!text) return { url: null, rejected: false };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  if (unsafeUrlReason(withScheme)) return { url: null, rejected: true };
  return { url: withScheme, rejected: false };
}

export async function importProspects(
  deps: RecruitmentDeps,
  merchantId: string,
  rows: ProspectImportRow[],
  opts: { source?: string } = {},
): Promise<ProspectImportResult> {
  const merchant = await deps.db.merchants.require(merchantId);
  const source = opts.source ?? "import";
  // One identity index for the whole batch (same as the discovery loop) — O(1) merge lookups.
  const identityIndex = await buildIdentityIndex(deps, merchantId);
  const exclusions = await ingestExclusionsFor(deps, merchant);
  const noContactAt = excludedContactDomains(exclusions);
  let imported = 0;
  let merged = 0;
  let skipped = 0;
  let excluded = 0;
  let rejectedUrls = 0;

  for (const row of rows) {
    const name = row.name?.trim();
    const site = cleanImportUrl(row.siteUrl);
    const channel = cleanImportUrl(row.channelUrl);
    rejectedUrls += Number(site.rejected) + Number(channel.rejected);
    const siteUrl = site.url;
    const channelUrl = channel.url;

    // The address must at least be shaped like one, and — like every other contact the
    // engine keeps — must not sit at a competitor's or the merchant's own domain.
    let email = row.email?.trim().toLowerCase() || null;
    const domain = email ? emailDomain(email) : null;
    if (email && (!domain || !/^[^@\s]+@[^@\s]+$/.test(email))) email = null;
    const emailExcluded = !!email && !!domain && noContactAt.some((d) => hostIsOrUnder(domain, d));
    if (emailExcluded) email = null;

    if (!name || (!email && !siteUrl && !channelUrl)) {
      if (name && emailExcluded) excluded++;
      else skipped++;
      continue;
    }

    const cand: RawCandidate = {
      identity: name,
      siteUrl,
      channelUrl,
      sourceType: source,
      evidenceUrl: siteUrl ?? channelUrl,
      evidenceSummary: row.notes?.trim() || `Imported ${email ? `(${email})` : ""}`.trim(),
      outboundLinks: [],
      // The address is the merchant's own data: carried as a source-vouched contact.
      ...(email ? { contactEmails: [{ email, source: "import" }] } : {}),
      synthetic: false,
    };
    // The merchant chose these rows, so the retailer/platform denylist does not apply —
    // but a competitor's own domain or the merchant's own is still never a prospect.
    if (ingestExclusionReason(cand, exclusions, { trusted: true })) {
      excluded++;
      continue;
    }

    const now = deps.clock.now().toISOString();
    const prospect = await ingestCandidate(deps, merchant, cand, { identityIndex, exclusions, trusted: true });
    if (prospect) {
      // ingestCandidate always inserts email:null — stamp the merchant-provided address so
      // the prospect is immediately contactable, and record WHERE it came from: enrich
      // keeps an "import" address as given instead of overwriting it with what it finds.
      if (email) {
        await deps.db.prospects.update(prospect.id, { email, evidence: { ...(prospect.evidence ?? {}), contactSource: "import", contactVerified: false }, updatedAt: now });
      }
      imported++;
    } else {
      merged++;
      // Matched an existing prospect: fill in the email if that prospect lacks one.
      if (email) {
        const existing = await deps.db.prospects.findOne(
          (p) =>
            p.merchantId === merchantId &&
            ((!!siteUrl && p.siteUrl === siteUrl) || (!!channelUrl && p.channelUrl === channelUrl) || (!siteUrl && !channelUrl && p.identity === name)),
        );
        if (existing && !existing.email) {
          await deps.db.prospects.update(existing.id, { email, evidence: { ...(existing.evidence ?? {}), contactSource: "import", contactVerified: false }, updatedAt: now });
        }
      }
    }
  }
  return { imported, merged, skipped, excluded, rejectedUrls };
}

export interface AffiliateRosterRow {
  name: string;
  email: string;
  siteUrl?: string | null;
  producedRevenueCents?: number | null;
}

export interface RosterImportResult {
  created: number; // relationships newly created
  existing: number; // rows that already had a relationship (idempotent)
  skipped: number;
}

export async function importAffiliateRoster(
  deps: RecruitmentDeps,
  merchantId: string,
  rows: AffiliateRosterRow[],
): Promise<RosterImportResult> {
  const programs = await deps.db.programs.find((p) => p.merchantId === merchantId);
  const program = programs.find((p) => p.status === "active") ?? programs[0];
  if (!program) return { created: 0, existing: 0, skipped: rows.length };
  const now = deps.clock.now().toISOString();
  let created = 0;
  let existing = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    const name = row.name?.trim();
    if (!email || !email.includes("@") || !name) {
      skipped++;
      continue;
    }

    // Find-or-create the GLOBAL affiliate (spans merchants), by email.
    let affiliate = await deps.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === email);
    if (!affiliate) {
      affiliate = await deps.db.affiliates.insert({
        id: newId("aff"),
        name,
        primaryEmail: row.email.trim(),
        country: null,
        audienceProfile: row.siteUrl ? { channels: [row.siteUrl] } : null,
        status: "active",
        createdAt: now,
      });
    }

    // Find-or-create the per-merchant relationship (idempotent).
    let relationship = await deps.db.relationships.findOne((r) => r.affiliateId === affiliate!.id && r.merchantId === merchantId);
    if (!relationship) {
      relationship = await deps.db.relationships.insert({
        id: newId("rel"),
        affiliateId: affiliate.id,
        merchantId,
        programId: program.id,
        status: "active",
        joinedAt: now,
        role: "seller",
        commissionTerms: null,
        source: "import",
        ownerUserId: null,
        tags: ["imported"],
        sponsorAffiliateId: null,
        prospectId: null,
      });
      created++;
    } else {
      existing++;
    }

    // Warm-start the learning loop from the merchant's real history: a producing affiliate is
    // the strongest outcome signal weightsForMerchant learns from.
    if (row.producedRevenueCents != null && row.producedRevenueCents > 0) {
      const already = await deps.db.prospectOutcomes.findOne((o) => o.relationshipId === relationship!.id && o.label === "produced_sales");
      if (!already) {
        await deps.db.prospectOutcomes.insert({
          id: newId("pout"),
          merchantId,
          prospectId: relationship.prospectId ?? relationship.id, // no source prospect for a roster import
          relationshipId: relationship.id,
          sourceType: "import",
          label: "produced_sales",
          producedRevenueCents: row.producedRevenueCents,
          ts: now,
        });
      }
    }
  }
  return { created, existing, skipped };
}
