import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Affiliate, AffiliateRelationship } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok, paginationSchema, paginate } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound, badRequest } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import { sendActivationEmail } from "../services/activation-email.js";

const roleEnum = z.enum(["seller", "recruiter", "both"]);
const relationshipStatusEnum = z.enum(["pending", "active", "paused", "banned", "rejected"]);

/** Find an existing global affiliate by email or create one. */
async function upsertAffiliate(
  ctx: Parameters<RouteModule>[1],
  email: string,
  name: string,
): Promise<Affiliate> {
  const normalized = email.trim().toLowerCase();
  const existing = await ctx.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === normalized);
  if (existing) return existing;
  const affiliate: Affiliate = {
    id: newId("aff"),
    name,
    primaryEmail: email.trim(),
    country: null,
    audienceProfile: null,
    status: "active",
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.db.affiliates.insert(affiliate);
  return affiliate;
}

export const affiliateRoutes: RouteModule = (app, ctx) => {
  // ---- List relationships for the merchant ----------------------------------
  app.get("/affiliates", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(
      paginationSchema.extend({ status: z.string().optional(), role: z.string().optional() }),
      request,
    );
    let relationships = await ctx.db.relationships.find((r) => r.merchantId === merchantId);
    if (q.status) relationships = relationships.filter((r) => r.status === q.status);
    if (q.role) relationships = relationships.filter((r) => r.role === q.role);
    const joined = await Promise.all(
      relationships.map(async (r) => ({ ...r, affiliate: await ctx.db.affiliates.get(r.affiliateId) })),
    );
    return ok(reply, paginate(joined, q));
  });

  // ---- Create / link an affiliate -------------------------------------------
  app.post("/affiliates", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(
      z.object({
        email: z.string().email(),
        name: z.string().min(1),
        role: roleEnum,
        programId: z.string(),
        sponsorAffiliateId: z.string().nullish(),
        source: z.string().optional(),
      }),
      request,
    );
    // The program must belong to THIS merchant.
    const program = await ctx.db.programs.get(body.programId);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    // A sponsor, if given, must already be an affiliate of this merchant.
    if (body.sponsorAffiliateId) {
      const sponsorRel = await ctx.db.relationships.findOne(
        (r) => r.affiliateId === body.sponsorAffiliateId && r.merchantId === merchantId,
      );
      if (!sponsorRel) throw badRequest("sponsor is not an affiliate of this merchant");
    }
    const affiliate = await upsertAffiliate(ctx, body.email, body.name);
    const relationship: AffiliateRelationship = {
      id: newId("rel"),
      affiliateId: affiliate.id,
      merchantId,
      programId: body.programId,
      status: "active",
      joinedAt: ctx.clock.now().toISOString(),
      role: body.role,
      commissionTerms: null,
      source: body.source ?? "manual",
      ownerUserId: null,
      tags: [],
      sponsorAffiliateId: body.sponsorAffiliateId ?? null,
      prospectId: null,
    };
    await ctx.db.relationships.insert(relationship);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "affiliate.linked",
      subjectType: "relationship",
      subjectId: relationship.id,
      metadata: { affiliateId: affiliate.id, programId: body.programId, role: body.role },
    });
    return ok(reply, { ...relationship, affiliate }, 201);
  });

  // ---- Read a single relationship -------------------------------------------
  app.get("/affiliates/:relationshipId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const affiliate = await ctx.db.affiliates.get(relationship.affiliateId);
    return ok(reply, { ...relationship, affiliate });
  });

  // ---- Patch a relationship --------------------------------------------------
  app.patch("/affiliates/:relationshipId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const body = parseBody(
      z.object({
        role: roleEnum.optional(),
        status: relationshipStatusEnum.optional(),
        commissionTerms: z
          .object({ rate: z.number().optional(), flatAmountCents: z.number().optional(), note: z.string().optional() })
          .nullish(),
        tags: z.array(z.string()).optional(),
        ownerUserId: z.string().nullish(),
        reason: z.string().optional(),
      }),
      request,
    );
    const patch: Partial<AffiliateRelationship> = {};
    if (body.role !== undefined) patch.role = body.role;
    if (body.status !== undefined) patch.status = body.status;
    if (body.commissionTerms !== undefined) patch.commissionTerms = body.commissionTerms ?? null;
    if (body.tags !== undefined) patch.tags = body.tags;
    if (body.ownerUserId !== undefined) patch.ownerUserId = body.ownerUserId ?? null;
    const updated = await ctx.db.relationships.update(relationshipId, patch);
    if (body.status !== undefined && body.status !== relationship.status) {
      await writeAudit(ctx, {
        merchantId,
        actorId: null,
        action: "affiliate.status_changed",
        subjectType: "relationship",
        subjectId: relationshipId,
        metadata: { from: relationship.status, to: body.status, reason: body.reason ?? null },
      });
    }
    return ok(reply, updated);
  });

  // ---- Approve --------------------------------------------------------------
  app.post("/affiliates/:relationshipId/approve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const updated = await ctx.db.relationships.update(relationshipId, { status: "active" });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "affiliate.approved",
      subjectType: "relationship",
      subjectId: relationshipId,
    });
    // Fire the activation welcome the moment they're approved (best-effort — never fail
    // the approval on a mail hiccup; it's idempotent so a retry won't double-send).
    const welcome = await sendActivationEmail(ctx, relationshipId).catch(() => ({ sent: false as const }));
    return ok(reply, { ...updated, welcomeEmailSent: welcome.sent });
  });

  // ---- Reject ---------------------------------------------------------------
  app.post("/affiliates/:relationshipId/reject", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const body = parseBody(z.object({ reason: z.string().optional() }), request);
    const updated = await ctx.db.relationships.update(relationshipId, { status: "rejected" });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "affiliate.rejected",
      subjectType: "relationship",
      subjectId: relationshipId,
      metadata: { reason: body.reason ?? null },
    });
    return ok(reply, updated);
  });

  // ---- Public inbound application -------------------------------------------
  app.post("/programs/:programId/apply", async (request, reply) => {
    const programId = (request.params as { programId: string }).programId;
    const program = await ctx.db.programs.get(programId);
    if (!program) throw notFound("program");
    // Public applications are only accepted for ACTIVE, openly-joinable programs —
    // not draft/archived, and not invite-only.
    if (program.status !== "active") throw badRequest("program is not accepting applications");
    if (program.approvalMode === "invite_only") throw badRequest("program is invite-only");
    const body = parseBody(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        role: roleEnum.optional(),
        siteUrl: z.string().optional(),
      }),
      request,
    );
    const affiliate = await upsertAffiliate(ctx, body.email, body.name);
    const status = program.approvalMode === "auto" ? "active" : "pending";
    const relationship: AffiliateRelationship = {
      id: newId("rel"),
      affiliateId: affiliate.id,
      merchantId: program.merchantId,
      programId: program.id,
      status,
      joinedAt: ctx.clock.now().toISOString(),
      role: body.role ?? "seller",
      commissionTerms: null,
      source: "inbound",
      ownerUserId: null,
      tags: [],
      sponsorAffiliateId: null,
      prospectId: null,
    };
    await ctx.db.relationships.insert(relationship);
    await writeAudit(ctx, {
      merchantId: program.merchantId,
      actorId: null,
      action: "affiliate.applied",
      subjectType: "relationship",
      subjectId: relationship.id,
      metadata: { affiliateId: affiliate.id, programId: program.id, siteUrl: body.siteUrl ?? null },
    });
    // Auto-approval programs activate immediately → send the welcome now. Manual programs
    // send it later, on approve. Best-effort + idempotent.
    if (status === "active") await sendActivationEmail(ctx, relationship.id).catch(() => {});
    return ok(reply, { relationshipId: relationship.id, status }, 201);
  });

  // ---- Distinct tag groups with counts --------------------------------------
  app.get("/affiliates/groups", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const relationships = await ctx.db.relationships.find((r) => r.merchantId === merchantId);
    const counts = new Map<string, number>();
    for (const r of relationships) {
      for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const groups = Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
    return ok(reply, groups);
  });
};
