import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Offer, Program } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const programSchema = z.object({
  name: z.string().min(1),
  approvalMode: z.enum(["auto", "manual", "invite_only"]).default("manual"),
  defaultCurrency: z.string().length(3).default("USD"),
  termsUrl: z.string().url().nullish(),
  attributionPriority: z.enum(["link_first", "code_first", "last_touch"]).default("last_touch"),
  holdDays: z.number().int().min(0).max(180).default(14),
});

const offerBaseSchema = z.object({
  name: z.string().min(1),
  // The MLM engine is a deliberate stub (it produces no commissions). Reject
  // creating MLM offers rather than silently generating zero commissions.
  engine: z.literal("affiliate").default("affiliate"),
  payoutType: z.enum(["percentage", "flat"]),
  payoutValue: z.number().min(0),
  currency: z.string().length(3).default("USD"),
  windowDays: z.number().int().min(1).max(365).default(30),
  rules: z.array(z.any()).default([]),
  tiers: z.array(z.any()).default([]),
  bonuses: z.array(z.any()).default([]),
  overridePolicy: z.any().nullish(),
});

const offerSchema = offerBaseSchema
  .refine((o) => o.payoutType !== "percentage" || (o.payoutValue > 0 && o.payoutValue <= 1), {
    message: "percentage payoutValue must be a decimal in (0, 1] — e.g. 0.2 for 20%",
    path: ["payoutValue"],
  })
  .refine((o) => o.payoutType !== "flat" || Number.isInteger(o.payoutValue), {
    message: "flat payoutValue must be an integer number of cents",
    path: ["payoutValue"],
  });

export const programRoutes: RouteModule = (app, ctx) => {
  app.get("/programs", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const programs = await ctx.db.programs.find((p) => p.merchantId === merchantId);
    return ok(reply, programs);
  });

  app.post("/programs", async (request, reply) => {
    const { merchantId, role } = await requireMerchant(ctx, request, "write");
    const body = parseBody(programSchema, request);
    const program: Program = {
      id: newId("prog"),
      merchantId,
      name: body.name,
      status: "draft",
      termsUrl: body.termsUrl ?? null,
      approvalMode: body.approvalMode,
      defaultCurrency: body.defaultCurrency.toUpperCase(),
      attributionPriority: body.attributionPriority,
      holdDays: body.holdDays,
    };
    await ctx.db.programs.insert(program);
    await writeAudit(ctx, { merchantId, actorId: null, action: "program.created", subjectType: "program", subjectId: program.id, metadata: { role } });
    return ok(reply, program, 201);
  });

  app.get("/programs/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const program = await ctx.db.programs.get(id);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const offers = await ctx.db.offers.find((o) => o.programId === id);
    return ok(reply, { ...program, offers });
  });

  app.patch("/programs/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const program = await ctx.db.programs.get(id);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const body = parseBody(programSchema.partial().extend({ status: z.enum(["draft", "active", "paused", "archived"]).optional() }), request);
    const updated = await ctx.db.programs.update(id, body as Partial<Program>);
    return ok(reply, updated);
  });

  // ---- Offers ---------------------------------------------------------------
  app.post("/programs/:id/offers", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const programId = (request.params as { id: string }).id;
    const program = await ctx.db.programs.get(programId);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const body = parseBody(offerSchema, request);
    const offer: Offer = {
      id: newId("offer"),
      merchantId,
      programId,
      engine: body.engine,
      name: body.name,
      payoutType: body.payoutType,
      payoutValue: body.payoutValue,
      currency: body.currency.toUpperCase(),
      windowDays: body.windowDays,
      rules: body.rules as Offer["rules"],
      tiers: body.tiers as Offer["tiers"],
      bonuses: body.bonuses as Offer["bonuses"],
      overridePolicy: (body.overridePolicy ?? null) as Offer["overridePolicy"],
      status: "active",
    };
    await ctx.db.offers.insert(offer);
    await writeAudit(ctx, { merchantId, actorId: null, action: "offer.created", subjectType: "offer", subjectId: offer.id });
    return ok(reply, offer, 201);
  });

  app.get("/programs/:id/offers", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const programId = (request.params as { id: string }).id;
    const offers = await ctx.db.offers.find((o) => o.programId === programId && o.merchantId === merchantId);
    return ok(reply, offers);
  });

  app.patch("/offers/:offerId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const offerId = (request.params as { offerId: string }).offerId;
    const offer = await ctx.db.offers.get(offerId);
    if (!offer || offer.merchantId !== merchantId) throw notFound("offer");
    const body = parseBody(offerBaseSchema.partial().extend({ status: z.enum(["active", "paused"]).optional() }), request);
    const updated = await ctx.db.offers.update(offerId, body as Partial<Offer>);
    return ok(reply, updated);
  });
};
