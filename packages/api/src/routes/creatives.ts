import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Agreement, AgreementAcceptance, Creative } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const creativeSchema = z.object({
  programId: z.string().min(1),
  type: z.enum(["banner", "swipe_copy", "product_feed", "video", "qr", "landing_page"]),
  name: z.string().min(1),
  assetRef: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const creativePatchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["active", "archived"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const agreementSchema = z.object({
  version: z.string().min(1),
  bodyRef: z.string().min(1),
  effectiveAt: z.string().optional(),
});

const acceptSchema = z.object({
  agreementId: z.string().min(1),
});

export const creativeRoutes: RouteModule = (app, ctx) => {
  // ---- Creatives ------------------------------------------------------------
  app.get("/creatives", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(z.object({ programId: z.string().optional() }), request);
    const creatives = await ctx.db.creatives.find(
      (c) => c.merchantId === merchantId && (!q.programId || c.programId === q.programId),
    );
    return ok(reply, creatives);
  });

  app.post("/creatives", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const body = parseBody(creativeSchema, request);
    const program = await ctx.db.programs.get(body.programId);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const creative: Creative = {
      id: newId("crv"),
      merchantId,
      programId: body.programId,
      type: body.type,
      name: body.name,
      assetRef: body.assetRef,
      metadata: body.metadata ?? {},
      status: "active",
    };
    await ctx.db.creatives.insert(creative);
    await writeAudit(ctx, { merchantId, actorId: null, action: "creative.created", subjectType: "creative", subjectId: creative.id });
    return ok(reply, creative, 201);
  });

  app.patch("/creatives/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const creative = await ctx.db.creatives.get(id);
    if (!creative || creative.merchantId !== merchantId) throw notFound("creative");
    const body = parseBody(creativePatchSchema, request);
    const updated = await ctx.db.creatives.update(id, body as Partial<Creative>);
    await writeAudit(ctx, { merchantId, actorId: null, action: "creative.updated", subjectType: "creative", subjectId: id });
    return ok(reply, updated);
  });

  app.delete("/creatives/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const creative = await ctx.db.creatives.get(id);
    if (!creative || creative.merchantId !== merchantId) throw notFound("creative");
    await ctx.db.creatives.delete(id);
    await writeAudit(ctx, { merchantId, actorId: null, action: "creative.deleted", subjectType: "creative", subjectId: id });
    return ok(reply, { id, deleted: true });
  });

  // ---- Program agreements ---------------------------------------------------
  app.get("/programs/:programId/agreements", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const programId = (request.params as { programId: string }).programId;
    const program = await ctx.db.programs.get(programId);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const agreements = await ctx.db.agreements.find((a) => a.programId === programId && a.merchantId === merchantId);
    return ok(reply, agreements);
  });

  app.post("/programs/:programId/agreements", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const programId = (request.params as { programId: string }).programId;
    const program = await ctx.db.programs.get(programId);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const body = parseBody(agreementSchema, request);
    const agreement: Agreement = {
      id: newId("agr"),
      merchantId,
      programId,
      version: body.version,
      bodyRef: body.bodyRef,
      effectiveAt: body.effectiveAt ?? ctx.clock.now().toISOString(),
    };
    await ctx.db.agreements.insert(agreement);
    await writeAudit(ctx, { merchantId, actorId: null, action: "agreement.created", subjectType: "agreement", subjectId: agreement.id });
    return ok(reply, agreement, 201);
  });

  // ---- Agreement acceptance -------------------------------------------------
  app.post("/affiliates/:relationshipId/accept-agreement", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const body = parseBody(acceptSchema, request);
    const agreement = await ctx.db.agreements.get(body.agreementId);
    if (!agreement || agreement.merchantId !== merchantId) throw notFound("agreement");
    const acceptance: AgreementAcceptance = {
      id: newId("acc"),
      agreementId: agreement.id,
      affiliateId: relationship.affiliateId,
      relationshipId,
      acceptedAt: ctx.clock.now().toISOString(),
      ip: request.ip ?? null,
    };
    await ctx.db.agreementAcceptances.insert(acceptance);
    await writeAudit(ctx, { merchantId, actorId: null, action: "agreement.accepted", subjectType: "agreementAcceptance", subjectId: acceptance.id, metadata: { relationshipId, agreementId: agreement.id } });
    return ok(reply, acceptance, 201);
  });
};
