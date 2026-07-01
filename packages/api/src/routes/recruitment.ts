import { z } from "zod";
import { newId, scanContent } from "@affiliate/core";
import { parseInboundWebhook } from "@affiliate/integrations";
import type { OutreachCampaign, Suppression } from "@affiliate/db";
import { runSourcing, processBacklog, launchCampaign, handleReply, recordOutcome, draftOutreach, expandFrontier, convertProspectToAffiliate, previewOutreach, processInboundReply, activationMetrics, draftDm, bestDmTarget, dmFollowupTargets, abResults, applyToJoin, firstStep, getAutomationState } from "@affiliate/recruitment";
import { renderTemplate } from "@affiliate/integrations";
import type { Profile } from "@affiliate/core";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok, paginationSchema, paginate } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { badRequest, notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import { assertWithinEntitlement, recordUsage } from "../services/entitlements.js";
import { sendActivationEmail } from "../services/activation-email.js";

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

  // Approve a prospect → materialize a portal-ready affiliate + relationship (the
  // recruitment→portal seam). Idempotent via the shared conversion service.
  app.post("/recruitment/prospects/:id/approve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    if (!prospect.email) throw badRequest("prospect has no email to convert");

    const result = await convertProspectToAffiliate(ctx, id);
    if (!result) throw badRequest("merchant has no program to attach the affiliate to");

    await recordOutcome(ctx, id, "high_potential", { relationshipId: result.relationship.id });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "recruitment.prospect.approved",
      subjectType: "prospect",
      subjectId: id,
      metadata: { affiliateId: result.affiliate.id, relationshipId: result.relationship.id },
    });
    // The conversion made an active relationship → send the activation welcome now
    // (best-effort + idempotent).
    const welcome = await sendActivationEmail(ctx, result.relationship.id).catch(() => ({ sent: false as const }));
    return ok(reply, { affiliateId: result.affiliate.id, relationshipId: result.relationship.id, welcomeEmailSent: welcome.sent }, 201);
  });

  // Preview the exact personalized email for a prospect under a campaign (incl. LLM).
  app.post("/recruitment/prospects/:id/preview", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const body = parseBody(z.object({ campaignId: z.string() }), request);
    const campaign = await ctx.db.campaigns.get(body.campaignId);
    if (!campaign || campaign.merchantId !== merchantId) throw notFound("campaign");
    const preview = await previewOutreach(ctx, id, campaign);
    if (!preview) throw badRequest("campaign has no sequence steps");
    return ok(reply, preview);
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
    const state = await getAutomationState(ctx, merchantId);
    const result = await handleReply(ctx, id, body.raw, { meetingTier: state.meetingTier, aiSdrMode: state.aiSdrMode });
    return ok(reply, result);
  });

  // ---- Pre-send content gate (compose-time spam/deliverability check) -------
  app.post("/recruitment/content-scan", async (request, reply) => {
    await requireMerchant(ctx, request, "read");
    const body = parseBody(z.object({ subject: z.string(), body: z.string() }), request);
    return ok(reply, scanContent({ subject: body.subject, body: body.body }));
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

  // ---- Multichannel DM assist (semi-assisted — operator sends, never auto) --
  // Prospects with a DM-able social handle, worth a DM nudge (no reply yet).
  app.get("/recruitment/dm-queue", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const states = new Set(["scored", "queued", "contacted", "in_sequence"]);
    const prospects = await ctx.db.prospects.find((p) => p.merchantId === merchantId && states.has(p.state));
    const queue = prospects
      .map((p) => ({ p, target: bestDmTarget((p.evidence?.profile as Profile | null) ?? null) }))
      .filter((x) => x.target)
      .map((x) => ({ prospectId: x.p.id, identity: x.p.identity, tier: x.p.tier, state: x.p.state, target: x.target }));
    return ok(reply, queue);
  });

  // High-value social-follow-up queue: high-quality prospects we EMAILED who didn't reply,
  // surfaced for a DM nudge. ?minTier=A|B|C &minDaysSinceEmail=N (defaults B / 3 days).
  app.get("/recruitment/dm-followup", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = request.query as { minTier?: "A" | "B" | "C"; minDaysSinceEmail?: string };
    const targets = await dmFollowupTargets(ctx, merchantId, {
      minTier: q.minTier,
      minDaysSinceEmail: q.minDaysSinceEmail != null ? Number(q.minDaysSinceEmail) : undefined,
    });
    return ok(reply, targets);
  });

  // The drafted DM + deep link for one prospect (the operator copies + sends).
  app.get("/recruitment/prospects/:id/dm-draft", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const merchant = await ctx.db.merchants.require(merchantId);
    const draft = await draftDm(ctx, merchant, prospect);
    if (!draft) throw badRequest("no DM-able social handle for this prospect");
    return ok(reply, draft);
  });

  // Record that the operator sent the DM (a manual touch); optionally capture the reply.
  app.post("/recruitment/prospects/:id/dm-sent", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const body = parseBody(z.object({ reply: z.string().optional() }), request);
    await writeAudit(ctx, { merchantId, actorId: null, action: "recruitment.dm.sent", subjectType: "prospect", subjectId: id });
    // If they pasted a DM reply, route it through the same two-track handler.
    if (body.reply?.trim()) {
      const state = await getAutomationState(ctx, merchantId);
      const outcome = await handleReply(ctx, id, body.reply, { meetingTier: state.meetingTier, aiSdrMode: state.aiSdrMode });
      return ok(reply, { recorded: true, outcome });
    }
    if (prospect.state === "scored" || prospect.state === "queued") await ctx.db.prospects.update(id, { state: "contacted", updatedAt: ctx.clock.now().toISOString() });
    return ok(reply, { recorded: true });
  });

  // ---- Prepared DM-task queue (sequence-generated; the human just presses send) ----
  // A `channel:"dm"` sequence step auto-creates these — message drafted, best handle picked,
  // deep link ready. The operator works the queue and marks each sent (or skips).
  app.get("/recruitment/dm-tasks", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(z.object({ status: z.enum(["pending", "sent", "skipped"]).optional() }), request);
    const tasks = await ctx.db.dmTasks.find((t) => t.merchantId === merchantId && (q.status ? t.status === q.status : true));
    const withProspect = await Promise.all(
      tasks
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(async (t) => ({ ...t, prospect: await ctx.db.prospects.get(t.prospectId).then((p) => (p ? { identity: p.identity, tier: p.tier, score: p.score } : null)) })),
    );
    return ok(reply, withProspect);
  });

  // Operator sent the prepared DM. Marks the task sent, advances the prospect, and — if they
  // pasted the creator's DM reply — routes it through the same AI-SDR two-track handler.
  app.post("/recruitment/dm-tasks/:id/sent", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const task = await ctx.db.dmTasks.get(id);
    if (!task || task.merchantId !== merchantId) throw notFound("dm task");
    const body = parseBody(z.object({ reply: z.string().optional() }), request);
    const now = ctx.clock.now().toISOString();
    await ctx.db.dmTasks.update(id, { status: "sent", sentAt: now });
    await writeAudit(ctx, { merchantId, actorId: null, action: "recruitment.dm_task.sent", subjectType: "prospect", subjectId: task.prospectId, metadata: { platform: task.platform, step: task.step } });
    const prospect = await ctx.db.prospects.get(task.prospectId);
    if (prospect && (prospect.state === "scored" || prospect.state === "queued")) await ctx.db.prospects.update(prospect.id, { state: "contacted", updatedAt: now });
    if (body.reply?.trim()) {
      const state = await getAutomationState(ctx, merchantId);
      const outcome = await handleReply(ctx, task.prospectId, body.reply, { meetingTier: state.meetingTier, aiSdrMode: state.aiSdrMode });
      return ok(reply, { recorded: true, outcome });
    }
    return ok(reply, { recorded: true });
  });

  // Skip a prepared DM (not a fit / wrong handle) — advances the cadence past it.
  app.post("/recruitment/dm-tasks/:id/skip", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const task = await ctx.db.dmTasks.get(id);
    if (!task || task.merchantId !== merchantId) throw notFound("dm task");
    const updated = await ctx.db.dmTasks.update(id, { status: "skipped" });
    return ok(reply, updated);
  });

  // ---- Activation analytics (the recruitment ROI metric) --------------------
  app.get("/recruitment/activation", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await activationMetrics(ctx, merchantId));
  });

  // A/B variant reply-rates for a campaign.
  app.get("/recruitment/campaigns/:id/ab", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const campaign = await ctx.db.campaigns.get(id);
    if (!campaign || campaign.merchantId !== merchantId) throw notFound("campaign");
    return ok(reply, await abResults(ctx, id));
  });

  // ---- Personalization plan (billed differently) ----------------------------
  app.get("/recruitment/personalization", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const merchant = await ctx.db.merchants.require(merchantId);
    return ok(reply, { plan: merchant.personalizationPlan ?? "hybrid" });
  });

  app.put("/recruitment/personalization", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(z.object({ plan: z.enum(["template", "hybrid", "llm"]) }), request);
    const merchant = await ctx.db.merchants.update(merchantId, { personalizationPlan: body.plan });
    await writeAudit(ctx, { merchantId, actorId: null, action: "recruitment.personalization.updated", subjectType: "merchant", subjectId: merchantId, metadata: { plan: body.plan } });
    return ok(reply, { plan: merchant.personalizationPlan });
  });

  // ---- Public "apply to join the program" (inbound recruiting) --------------
  // No JWT — the applicant isn't logged in. Keyed by merchant id in the path.
  app.post("/join/:merchantId", async (request, reply) => {
    const merchantId = (request.params as { merchantId: string }).merchantId;
    const body = parseBody(z.object({ email: z.string().email(), name: z.string().min(1), socialUrl: z.string().url().optional() }), request);
    const result = await applyToJoin(ctx, merchantId, body);
    if (!result) throw notFound("program");
    // Auto-approval → active immediately → welcome now. Manual → welcome fires on approve.
    if (result.status === "active") await sendActivationEmail(ctx, result.relationshipId).catch(() => {});
    return ok(reply, result, 201);
  });

  // ---- Inbox-placement seed test (#7) ---------------------------------------
  // Send the rendered first-touch to operator-provided seed inboxes (Gmail/Outlook/Yahoo)
  // so placement (primary vs spam) can be checked before spending a campaign. NOTE:
  // automated folder DETECTION needs the seed mailboxes' IMAP or a GlockApps integration —
  // this delivers the seed-SEND; detection is the documented next rung.
  app.post("/recruitment/campaigns/:id/seed-test", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const campaign = await ctx.db.campaigns.get(id);
    if (!campaign || campaign.merchantId !== merchantId) throw notFound("campaign");
    const body = parseBody(z.object({ seeds: z.array(z.string().email()).min(1).max(10) }), request);
    const merchant = await ctx.db.merchants.require(merchantId);
    const step = firstStep(campaign);
    if (!step) throw badRequest("campaign has no sequence steps");
    const tokens = { name: "there", merchant: merchant.name, offer: merchant.niche ?? "our products", angle: "Your content is a great match for our products." };
    const mailbox = campaign.mailboxId ? await ctx.db.mailboxes.get(campaign.mailboxId) : null;
    const sender = await ctx.mailboxResolver(campaign.mailboxId);
    const results: Array<{ seed: string; status: string }> = [];
    for (const seed of body.seeds) {
      const r = await sender.send({
        fromName: merchant.name,
        fromEmail: mailbox?.email ?? `team@${merchant.name.toLowerCase().replace(/\s+/g, "")}.com`,
        toEmail: seed,
        subject: `[seed] ${renderTemplate(step.subject, tokens)}`,
        body: renderTemplate(step.body, tokens),
      });
      results.push({ seed, status: r.status });
    }
    await writeAudit(ctx, { merchantId, actorId: null, action: "recruitment.seed_test", subjectType: "campaign", subjectId: id, metadata: { count: body.seeds.length } });
    return ok(reply, { results, note: "Check each seed inbox for primary-vs-spam placement. Automated detection requires seed-inbox IMAP or a GlockApps integration." });
  });

  // ---- Inbound reply webhook (Graph / ESP inbound-parse) --------------------
  // Public endpoint (no JWT — the provider posts here). Guarded by a shared secret:
  // set INBOUND_WEBHOOK_SECRET in prod; when unset (dev) the guard is skipped.
  app.post("/webhooks/inbound", async (request, reply) => {
    const secret = process.env.INBOUND_WEBHOOK_SECRET;
    if (secret) {
      const provided = (request.headers["x-webhook-secret"] as string | undefined) ?? (request.query as { secret?: string }).secret;
      if (provided !== secret) throw badRequest("invalid webhook secret");
    }
    const inbound = parseInboundWebhook(request.body);
    if (!inbound) return ok(reply, { matched: false, reason: "unparseable payload" });
    const result = await processInboundReply(ctx, inbound);
    return ok(reply, { matched: result.matched, action: result.outcome?.action ?? null });
  });
};
