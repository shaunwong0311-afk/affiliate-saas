import { z } from "zod";
import {
  getAutomationState,
  setAutomationState,
  autonomousCycle,
  tickScheduler,
  sourceYield,
  deliverabilityHealth,
  handleReply,
  ingestReplies,
} from "@affiliate/recruitment";
import { parseInboundWebhook } from "@affiliate/integrations";
import { verifyHmacSignature, newId } from "@affiliate/core";
import type { MerchantFaq } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound, badRequest, unauthorized } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const tier = z.enum(["A", "B", "C"]);

/**
 * Operator surface for the autonomous from-scratch recruitment engine. The
 * operator's job is approve-and-monitor: flip automation on, set the HITL/meeting
 * tiers and auto-send threshold, then watch the funnel. The engine sources,
 * enriches, scores, sends, sequences, and routes replies on its own.
 */
export const automationRoutes: RouteModule = (app, ctx) => {
  // ---- Automation control ---------------------------------------------------
  app.get("/recruitment/automation", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await getAutomationState(ctx, merchantId));
  });

  app.put("/recruitment/automation", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(
      z.object({
        status: z.enum(["off", "running", "paused"]).optional(),
        autoSendMinScore: z.number().min(0).max(100).optional(),
        hitlTier: tier.optional(),
        meetingTier: tier.optional(),
        aiSdrMode: z.enum(["hitl", "autopilot"]).optional(),
        sourcingLimitPerCycle: z.number().int().min(1).max(200).optional(),
      }),
      request,
    );
    const state = await setAutomationState(ctx, merchantId, body);
    await writeAudit(ctx, { merchantId, actorId: null, action: "recruitment.automation.updated", subjectType: "automation", subjectId: merchantId, metadata: body });
    return ok(reply, state);
  });

  app.post("/recruitment/automation/start", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    return ok(reply, await setAutomationState(ctx, merchantId, { status: "running" }));
  });

  app.post("/recruitment/automation/pause", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    return ok(reply, await setAutomationState(ctx, merchantId, { status: "paused" }));
  });

  // Manually run one autonomous cycle now (the scheduler runs these on a cadence).
  app.post("/recruitment/automation/cycle", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    return ok(reply, await autonomousCycle(ctx, merchantId));
  });

  // ---- Deliverability + source yield ---------------------------------------
  app.get("/recruitment/deliverability", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await deliverabilityHealth(ctx, merchantId));
  });

  app.get("/recruitment/source-yield", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await sourceYield(ctx, merchantId));
  });

  // ---- Meetings (managed / A-tier track) -----------------------------------
  app.get("/recruitment/meetings", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const meetings = await ctx.db.meetings.find((m) => m.merchantId === merchantId);
    return ok(reply, meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  app.patch("/recruitment/meetings/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const meeting = await ctx.db.meetings.get(id);
    if (!meeting || meeting.merchantId !== merchantId) throw notFound("meeting");
    const body = parseBody(
      z.object({
        status: z.enum(["requested", "booked", "completed", "no_show", "cancelled"]).optional(),
        scheduledAt: z.string().nullish(),
        notes: z.string().nullish(),
        ownerUserId: z.string().nullish(),
      }),
      request,
    );
    return ok(reply, await ctx.db.meetings.update(id, body as Partial<typeof meeting>));
  });

  // ---- Auto-ingest replies via ESP inbound-parse webhook (PUBLIC) -----------
  // Replaces hand-pasting replies. Resolves the prospect by sender email and
  // routes the reply through the two-track router (self-serve vs meeting).
  app.post("/recruitment/reply-webhook/:merchantId", async (request, reply) => {
    const merchantId = (request.params as { merchantId: string }).merchantId;
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    // Signed: HMAC-SHA256 of the raw body with the merchant's secret. Without this
    // anyone could forge replies, globally suppress prospects, or create meetings.
    const signature = (request.headers["x-vantage-signature"] as string) ?? null;
    if (!verifyHmacSignature(request.rawBody ?? "", signature, merchant.postbackSecret)) {
      throw unauthorized("invalid webhook signature");
    }
    const inbound = parseInboundWebhook(request.body);
    if (!inbound) throw badRequest("unparseable reply payload");
    const prospect = await ctx.db.prospects.findOne(
      (p) => p.merchantId === merchantId && p.email != null && p.email.toLowerCase() === inbound.fromEmail.toLowerCase(),
    );
    if (!prospect) return ok(reply, { matched: false });
    const state = await getAutomationState(ctx, merchantId);
    const outcome = await handleReply(ctx, prospect.id, inbound.body, { meetingTier: state.meetingTier, aiSdrMode: state.aiSdrMode });
    return ok(reply, { matched: true, action: outcome.action, classification: outcome.classification, needsHuman: outcome.needsHuman ?? false, handoffId: outcome.handoff?.id ?? null });
  });

  // ---- Manual reply ingest (operator pastes a reply) -----------------------
  app.post("/recruitment/prospects/:id/route-reply", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const prospect = await ctx.db.prospects.get(id);
    if (!prospect || prospect.merchantId !== merchantId) throw notFound("prospect");
    const body = parseBody(z.object({ raw: z.string().min(1) }), request);
    const state = await getAutomationState(ctx, merchantId);
    const outcome = await handleReply(ctx, id, body.raw, { meetingTier: state.meetingTier, aiSdrMode: state.aiSdrMode });
    return ok(reply, outcome);
  });

  // ---- Poll the merchant's connected mailboxes for new replies (SMTP-rail IMAP) ----
  // The scheduler does this every tick; this is the on-demand "check for replies now"
  // button. PEEK-only + Message-Id dedup, so it's safe to call repeatedly.
  app.post("/recruitment/ingest-replies", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const summary = await ingestReplies(ctx, { merchantId });
    return ok(reply, summary);
  });

  // ---- AI-SDR human handoff queue ------------------------------------------
  // Everything the AI-SDR routed to a person: gated topics, ungrounded questions, and
  // (in HITL mode) grounded answers awaiting approval. The operator works ONE queue.
  app.get("/recruitment/handoffs", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(z.object({ status: z.enum(["open", "resolved"]).optional() }), request);
    const handoffs = await ctx.db.handoffs.find((h) => h.merchantId === merchantId && (q.status ? h.status === q.status : true));
    return ok(reply, handoffs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  // Resolve a handoff (the human actioned it).
  app.post("/recruitment/handoffs/:id/resolve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const handoff = await ctx.db.handoffs.get(id);
    if (!handoff || handoff.merchantId !== merchantId) throw notFound("handoff");
    const updated = await ctx.db.handoffs.update(id, { status: "resolved", resolvedAt: ctx.clock.now().toISOString() });
    return ok(reply, updated);
  });

  // ---- Merchant KB (the AI-SDR's grounded FAQ source) -----------------------
  app.get("/recruitment/faqs", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const faqs = await ctx.db.merchantFaqs.find((f) => f.merchantId === merchantId);
    return ok(reply, faqs);
  });

  app.post("/recruitment/faqs", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(z.object({ question: z.string().min(1), answer: z.string().min(1) }), request);
    const faq: MerchantFaq = { id: newId("faq"), merchantId, question: body.question, answer: body.answer, createdAt: ctx.clock.now().toISOString() };
    await ctx.db.merchantFaqs.insert(faq);
    return ok(reply, faq, 201);
  });

  app.delete("/recruitment/faqs/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const faq = await ctx.db.merchantFaqs.get(id);
    if (!faq || faq.merchantId !== merchantId) throw notFound("faq");
    await ctx.db.merchantFaqs.delete(id);
    return ok(reply, { id, deleted: true });
  });

  void tickScheduler;
};
