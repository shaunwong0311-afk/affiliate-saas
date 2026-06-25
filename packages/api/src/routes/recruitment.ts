import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Affiliate, AffiliateRelationship, OutreachCampaign, Suppression } from "@affiliate/db";
import { runSourcing, processBacklog, launchCampaign, handleReply, recordOutcome, draftOutreach, expandFrontier } from "@affiliate/recruitment";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok, paginationSchema, paginate } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { badRequest, notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import { assertWithinEntitlement, recordUsage } from "../services/entitlements.js";

const outcomeLabel = z.enum([
  "bad_fit",
  "wrong_contact",
  "not_an_affiliate",
  "already_partnered",
  "competitor_exclusive",
  "high_potential",
  "produced_sales",
]);

const sendWindowSchema = z.object({
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  timezone: z.string(),
});

const campaignSchema = z.object({
  name: z.string().min(1),
  mailboxId: z.string().nullish(),
  sendingDomainId: z.string().nullish(),
  sequence: z.array(z.any()).default([]),
  sendWindow: sendWindowSchema.optional(),
  dailyCap: z.number().int().min(1).max(10000).default(50),
});

export const recruitmentRoutes: RouteModule = (app, ctx) => {
  // ---- ICP (ideal customer / niche profile) ---------------------------------
  app.get("/recruitment/icp", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const merchant = await ctx.db.merchants.require(merchantId);
    return ok(reply, { niche: merchant.niche, competitors: merchant.competitors });
  });

  app.put("/recruitment/icp", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(
      z.object({ niche: z.string().nullish(), competitors: z.array(z.string()).optional() }),
      request,
    );
    const patch: { niche?: string | null; competitors?: string[] } = {};
    if (body.niche !== undefined) patch.niche = body.niche ?? null;
    if (body.competitors !== undefined) patch.competitors = body.competitors;
    const merchant = await ctx.db.merchants.update(merchantId, patch);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "recruitment.icp.updated",
      subjectType: "merchant",
      subjectId: merchantId,
      metadata: patch,
    });
    return ok(reply, { niche: merchant.niche, competitors: merchant.competitors });
  });

  // ---- Sourcing -------------------------------------------------------------
  app.post("/recruitment/source", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(z.object({ limit: z.number().int().min(1).max(500).default(10) }), request);
    // Enforce the recruitment-credits entitlement before spending on sourcing.
    await assertWithinEntitlement(ctx, merchantId, "recruitment_credits", "recruitment_credit", body.limit);
    const result = await runSourcing(ctx, merchantId, { limit: body.limit });
    await recordUsage(ctx, merchantId, "recruitment_credit", result.discovered);
    return ok(reply, result);
  });

  app.post("/recruitment/process-backlog", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const result = await processBacklog(ctx, merchantId);
    return ok(reply, result);
  });

  // ---- Recursive frontier (the niche map) -----------------------------------
  app.get("/recruitment/frontier", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const nodes = (await ctx.db.frontierMerchants.find((f) => f.merchantId === merchantId)).sort(
      (a, b) => a.depth - b.depth || b.coPromotions - a.coPromotions,
    );
    // How many affiliates each mined node surfaced (for node sizing / context).
    const prospectsByDomain: Record<string, number> = {};
    for (const n of nodes) {
      prospectsByDomain[n.domain] = await ctx.db.prospects.count(
        (p) => p.merchantId === merchantId && (p.evidence as { competitorPromoted?: string } | null)?.competitorPromoted === n.domain,
      );
    }
    return ok(reply, { nodes, prospectsByDomain });
  });

  app.post("/recruitment/frontier/expand", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(z.object({ maxSeedsPerCycle: z.number().int().min(1).max(10).default(3) }), request);
    const report = await expandFrontier(ctx, merchantId, { maxSeedsPerCycle: body.maxSeedsPerCycle });
    if (report.discovered > 0) await processBacklog(ctx, merchantId);
    return ok(reply, report);
  });

  // ---- Prospects ------------------------------------------------------------
  app.get("/recruitment/prospects", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(paginationSchema.extend({ tier: z.string().optional(), state: z.string().optional() }), request);
    let prospects = await ctx.db.prospects.find((p) => p.merchantId === merchantId);
    if (q.tier) prospects = prospects.filter((p) => p.tier === q.tier);
    if (q.state) prospects = prospects.filter((p) => p.state === q.state);
    prospects.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return ok(reply, paginate(prospects, q));
  });

  app.get("/recruitment/prospects/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const sources = await ctx.db.prospectSources.find((s) => s.prospectId === id);
    const signals = await ctx.db.prospectSignals.find((s) => s.prospectId === id);
    // Outreach history: every touch we sent (+ status) and every reply we got, so
    // the operator sees whether/how often we've reached out and what came back.
    const messages = (await ctx.db.outreachMessages.find((m) => m.prospectId === id)).sort((a, b) => a.step - b.step);
    const replies = (await ctx.db.replies.find((r) => r.prospectId === id)).sort((a, b) => a.ts.localeCompare(b.ts));
    return ok(reply, { ...prospect, sources, signals, messages, replies, scoreBreakdown: prospect.scoreBreakdown });
  });

  app.post("/recruitment/prospects/:id/approve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    if (!prospect.email) throw badRequest("prospect has no email to convert");

    const program = await ctx.db.programs.findOne((p) => p.merchantId === merchantId);
    if (!program) throw badRequest("merchant has no program to attach the affiliate to");

    const email = prospect.email;
    const existing = await ctx.db.affiliates.findOne((a) => a.primaryEmail === email);
    let affiliate: Affiliate;
    if (existing) {
      affiliate = existing;
    } else {
      affiliate = {
        id: newId("aff"),
        name: prospect.identity,
        primaryEmail: email,
        country: prospect.country,
        audienceProfile: null,
        status: "active",
        createdAt: ctx.clock.now().toISOString(),
      };
      await ctx.db.affiliates.insert(affiliate);
    }

    const relationship: AffiliateRelationship = {
      id: newId("rel"),
      affiliateId: affiliate.id,
      merchantId,
      programId: program.id,
      status: "active",
      joinedAt: ctx.clock.now().toISOString(),
      role: "seller",
      commissionTerms: null,
      // Carry the discovery sourceType + prospect id so a producing affiliate can
      // be traced to the source that found it (source-yield / cost-per-producing).
      source: prospect.source,
      ownerUserId: null,
      tags: [],
      sponsorAffiliateId: null,
      prospectId: id,
    };
    await ctx.db.relationships.insert(relationship);

    await ctx.db.prospects.update(id, { state: "converted" });
    await recordOutcome(ctx, id, "high_potential", { relationshipId: relationship.id });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "recruitment.prospect.approved",
      subjectType: "prospect",
      subjectId: id,
      metadata: { affiliateId: affiliate.id, relationshipId: relationship.id },
    });
    return ok(reply, { affiliateId: affiliate.id, relationshipId: relationship.id }, 201);
  });

  app.post("/recruitment/prospects/:id/reject", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    await recordOutcome(ctx, id, "bad_fit");
    return ok(reply, { ok: true });
  });

  app.post("/recruitment/prospects/:id/outcome", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const body = parseBody(z.object({ label: outcomeLabel }), request);
    await recordOutcome(ctx, id, body.label);
    return ok(reply, { ok: true });
  });

  // Pre-drafted message for the HUMAN-gated contact-form track (no auto-submit).
  app.get("/recruitment/prospects/:id/contact-draft", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const merchant = await ctx.db.merchants.require(merchantId);
    const draft = draftOutreach(merchant, prospect);
    const evidence = prospect.evidence as { contactFormUrl?: string | null } | null;
    return ok(reply, { ...draft, formUrl: evidence?.contactFormUrl ?? prospect.siteUrl ?? null });
  });

  app.post("/recruitment/prospects/:id/reply", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const body = parseBody(z.object({ raw: z.string() }), request);
    const result = await handleReply(ctx, id, body.raw);
    return ok(reply, result);
  });

  // ---- Campaigns ------------------------------------------------------------
  app.get("/recruitment/campaigns", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const campaigns = await ctx.db.campaigns.find((c) => c.merchantId === merchantId);
    return ok(reply, campaigns);
  });

  app.post("/recruitment/campaigns", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(campaignSchema, request);
    const campaign: OutreachCampaign = {
      id: newId("camp"),
      merchantId,
      mailboxId: body.mailboxId ?? null,
      sendingDomainId: body.sendingDomainId ?? null,
      name: body.name,
      sequence: body.sequence as OutreachCampaign["sequence"],
      sendWindow: body.sendWindow ?? { startHour: 9, endHour: 17, timezone: "UTC" },
      dailyCap: body.dailyCap,
      status: "draft",
    };
    await ctx.db.campaigns.insert(campaign);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "recruitment.campaign.created",
      subjectType: "campaign",
      subjectId: campaign.id,
    });
    return ok(reply, campaign, 201);
  });

  app.patch("/recruitment/campaigns/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const campaign = await ctx.db.campaigns.get(id);
    if (!campaign || campaign.merchantId !== merchantId) throw notFound("campaign");
    const body = parseBody(
      z.object({
        status: z.enum(["draft", "active", "paused", "archived"]).optional(),
        sequence: z.array(z.any()).optional(),
        dailyCap: z.number().int().min(1).max(10000).optional(),
      }),
      request,
    );
    const updated = await ctx.db.campaigns.update(id, body as Partial<OutreachCampaign>);
    return ok(reply, updated);
  });

  app.post("/recruitment/campaigns/:id/launch", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const campaign = await ctx.db.campaigns.get(id);
    if (!campaign || campaign.merchantId !== merchantId) throw notFound("campaign");
    const body = parseBody(
      z.object({ minTier: z.enum(["A", "B", "C"]).optional(), max: z.number().int().min(1).max(10000).optional() }),
      request,
    );
    const result = await launchCampaign(ctx, id, { minTier: body.minTier, max: body.max });
    return ok(reply, result);
  });

  // ---- Replies --------------------------------------------------------------
  app.get("/recruitment/replies", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const prospects = await ctx.db.prospects.find((p) => p.merchantId === merchantId);
    const ids = new Set(prospects.map((p) => p.id));
    const replies = await ctx.db.replies.find((r) => ids.has(r.prospectId));
    return ok(reply, replies);
  });

  // ---- Suppressions ---------------------------------------------------------
  app.get("/recruitment/suppressions", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    // Only this merchant's own suppressions — global rows (other tenants' emails /
    // domains) are NOT enumerable here. They still apply via isSuppressed.
    const suppressions = await ctx.db.suppressions.find((s) => s.merchantId === merchantId);
    return ok(reply, suppressions);
  });

  app.post("/recruitment/suppressions", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(
      z.object({
        email: z.string().nullish(),
        domain: z.string().nullish(),
        scope: z.enum(["global", "merchant"]).default("merchant"),
      }),
      request,
    );
    // A global (cross-tenant) suppression blocks outreach for EVERY merchant, so a
    // per-tenant "write" user must not create one — require admin for global scope.
    if (body.scope === "global") await requireMerchant(ctx, request, "admin");
    const suppression: Suppression = {
      id: newId("supp"),
      merchantId: body.scope === "global" ? null : merchantId,
      email: body.email ?? null,
      domain: body.domain ?? null,
      reason: "manual",
      scope: body.scope,
      ts: ctx.clock.now().toISOString(),
    };
    await ctx.db.suppressions.insert(suppression);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "recruitment.suppression.created",
      subjectType: "suppression",
      subjectId: suppression.id,
      metadata: { scope: suppression.scope },
    });
    return ok(reply, suppression, 201);
  });
};
