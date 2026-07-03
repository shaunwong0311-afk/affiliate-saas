import { newId } from "@affiliate/core";
import type { RawCandidate } from "@affiliate/integrations";
import type { RecruitmentDeps } from "./deps.js";
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
  let imported = 0;
  let merged = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = row.email?.trim().toLowerCase() || null;
    const siteUrl = row.siteUrl?.trim() || null;
    const channelUrl = row.channelUrl?.trim() || null;
    const name = row.name?.trim();
    if (!name || (!email && !siteUrl && !channelUrl)) {
      skipped++;
      continue;
    }

    const cand: RawCandidate = {
      identity: name,
      siteUrl,
      channelUrl,
      sourceType: source,
      evidenceUrl: siteUrl ?? channelUrl,
      evidenceSummary: row.notes?.trim() || `Imported ${email ? `(${email})` : ""}`.trim(),
      // The email is the merchant's own data — surface it as an outbound link so the identity
      // graph/merge can key on its domain, then set it on the prospect below.
      outboundLinks: email ? [`mailto:${email}`] : [],
      synthetic: false,
    };

    const prospect = await ingestCandidate(deps, merchant, cand, { identityIndex });
    if (prospect) {
      // ingestCandidate always inserts email:null (RawCandidate has no email field) — stamp
      // the merchant-provided address so the prospect is immediately contactable.
      if (email && !prospect.email) await deps.db.prospects.update(prospect.id, { email, updatedAt: deps.clock.now().toISOString() });
      imported++;
    } else {
      merged++;
      // Merged into an existing prospect: fill in the email if that prospect lacks one.
      if (email) {
        const existing = await deps.db.prospects.findOne(
          (p) => p.merchantId === merchantId && ((siteUrl && p.siteUrl === siteUrl) || (channelUrl && p.channelUrl === channelUrl) || p.identity === name),
        );
        if (existing && !existing.email) await deps.db.prospects.update(existing.id, { email, updatedAt: deps.clock.now().toISOString() });
      }
    }
  }
  return { imported, merged, skipped };
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
