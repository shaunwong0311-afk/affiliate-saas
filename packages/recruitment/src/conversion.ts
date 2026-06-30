import { newId, type Affiliate, type AffiliateRelationship } from "@affiliate/core";
import type { RecruitmentDeps } from "./deps.js";

/**
 * Prospect → affiliate conversion (OUTREACH-SPEC §6). The bridge from the recruitment
 * half to the portal: once a prospect says yes, we materialize a real **Affiliate** +
 * **AffiliateRelationship** so they can magic-link into the affiliate portal. The
 * relationship carries `prospectId`, which is what makes source-yield / cost-per-
 * producing-affiliate computable (a producing affiliate traces back to the source that
 * found it). Idempotent: find-or-create on both the global affiliate (by email) and the
 * per-merchant relationship.
 */

export interface ConversionResult {
  affiliate: Affiliate;
  relationship: AffiliateRelationship;
  created: { affiliate: boolean; relationship: boolean };
}

async function pickProgramId(deps: RecruitmentDeps, merchantId: string): Promise<string | null> {
  const programs = await deps.db.programs.find((p) => p.merchantId === merchantId);
  return (programs.find((p) => p.status === "active") ?? programs[0])?.id ?? null;
}

export async function convertProspectToAffiliate(
  deps: RecruitmentDeps,
  prospectId: string,
  opts: { programId?: string; ownerUserId?: string } = {},
): Promise<ConversionResult | null> {
  const prospect = await deps.db.prospects.require(prospectId);
  if (!prospect.email) return null; // no email → no portal account possible
  const now = deps.clock.now().toISOString();
  const email = prospect.email.toLowerCase();

  // 1) Find-or-create the GLOBAL affiliate (an affiliate spans merchants).
  let affiliate = await deps.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === email);
  let createdAffiliate = false;
  if (!affiliate) {
    const reach = (prospect.evidence as { profile?: { audience?: { reach?: number | null } } } | null)?.profile?.audience?.reach ?? undefined;
    affiliate = await deps.db.affiliates.insert({
      id: newId("aff"),
      name: prospect.identity,
      primaryEmail: prospect.email,
      country: prospect.country,
      audienceProfile: reach ? { reach } : null,
      status: "active",
      createdAt: now,
    });
    createdAffiliate = true;
  }

  // 2) Resolve the program for the merchant relationship.
  const programId = opts.programId ?? (await pickProgramId(deps, prospect.merchantId));
  if (!programId) return null; // merchant has no program configured → can't form a relationship

  // 3) Find-or-create the per-merchant relationship (carries the prospectId FK).
  let relationship = await deps.db.relationships.findOne((r) => r.affiliateId === affiliate!.id && r.merchantId === prospect.merchantId);
  let createdRel = false;
  if (!relationship) {
    relationship = await deps.db.relationships.insert({
      id: newId("rel"),
      affiliateId: affiliate.id,
      merchantId: prospect.merchantId,
      programId,
      status: "active",
      joinedAt: now,
      role: "seller",
      commissionTerms: null,
      source: prospect.source,
      ownerUserId: opts.ownerUserId ?? null,
      tags: ["recruited"],
      sponsorAffiliateId: null,
      prospectId: prospect.id,
    });
    createdRel = true;
  }

  // 4) Close the loop on the prospect.
  if (prospect.state !== "converted") {
    await deps.db.prospects.update(prospectId, { state: "converted", updatedAt: now });
  }

  return { affiliate, relationship, created: { affiliate: createdAffiliate, relationship: createdRel } };
}

export interface ApplyResult {
  affiliateId: string;
  relationshipId: string;
  status: "active" | "pending";
  created: boolean;
}

/**
 * Inbound "apply to join the program" (OUTREACH-SPEC §8 / the marketplaces' lowest-cost
 * recruiting channel). A creator submits the public join form → we find-or-create their
 * affiliate + relationship. Auto-approval programs activate immediately; manual/invite
 * programs land "pending" for operator review. Idempotent by email.
 */
export async function applyToJoin(
  deps: RecruitmentDeps,
  merchantId: string,
  input: { email: string; name: string; socialUrl?: string; source?: string },
): Promise<ApplyResult | null> {
  const merchant = await deps.db.merchants.get(merchantId);
  if (!merchant) return null;
  const programs = await deps.db.programs.find((p) => p.merchantId === merchantId);
  const program = programs.find((p) => p.status === "active") ?? programs[0];
  if (!program) return null;
  const now = deps.clock.now().toISOString();
  const email = input.email.toLowerCase();

  let affiliate = await deps.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === email);
  let created = false;
  if (!affiliate) {
    affiliate = await deps.db.affiliates.insert({
      id: newId("aff"),
      name: input.name,
      primaryEmail: input.email,
      country: null,
      audienceProfile: input.socialUrl ? { channels: [input.socialUrl] } : null,
      status: "active",
      createdAt: now,
    });
    created = true;
  }

  let rel = await deps.db.relationships.findOne((r) => r.affiliateId === affiliate!.id && r.merchantId === merchantId);
  if (!rel) {
    const status: "active" | "pending" = program.approvalMode === "auto" ? "active" : "pending";
    rel = await deps.db.relationships.insert({
      id: newId("rel"),
      affiliateId: affiliate.id,
      merchantId,
      programId: program.id,
      status,
      joinedAt: now,
      role: "seller",
      commissionTerms: null,
      source: input.source ?? "inbound_apply",
      ownerUserId: null,
      tags: ["inbound"],
      sponsorAffiliateId: null,
      prospectId: null,
    });
  }
  return { affiliateId: affiliate.id, relationshipId: rel.id, status: rel.status as "active" | "pending", created };
}
