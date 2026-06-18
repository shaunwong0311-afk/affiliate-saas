import { z } from "zod";
import { newCode, newId } from "@affiliate/core";
import type { AffiliateCode } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound, conflict } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const createSchema = z.object({
  affiliateId: z.string().min(1),
  kind: z.enum(["discount", "referral"]),
  discountValue: z.number().nullish(),
  usageCap: z.number().int().nullish(),
  expiresAt: z.string().nullish(),
  code: z.string().min(1).optional(),
});

const updateSchema = z.object({
  usageCap: z.number().int().nullish(),
  expiresAt: z.string().nullish(),
});

const listQuerySchema = z.object({
  affiliateId: z.string().optional(),
});

export const codeRoutes: RouteModule = (app, ctx) => {
  app.get("/codes", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(listQuerySchema, request);
    const codes = await ctx.db.codes.find(
      (c) => c.merchantId === merchantId && (q.affiliateId ? c.affiliateId === q.affiliateId : true),
    );
    return ok(reply, codes);
  });

  app.post("/codes", async (request, reply) => {
    const { merchantId, role } = await requireMerchant(ctx, request, "write");
    const body = parseBody(createSchema, request);
    // The affiliate must have a relationship with this merchant (tenant ownership).
    const rel = await ctx.db.relationships.findOne((r) => r.affiliateId === body.affiliateId && r.merchantId === merchantId);
    if (!rel) throw notFound("affiliate");
    const code = body.code ?? newCode(8);
    const existing = await ctx.db.codes.findOne((c) => c.merchantId === merchantId && c.code === code);
    if (existing) throw conflict("code already exists");
    const record: AffiliateCode = {
      id: newId("code"),
      affiliateId: body.affiliateId,
      merchantId,
      code,
      kind: body.kind,
      discountValue: body.discountValue ?? null,
      usageCap: body.usageCap ?? null,
      usageCount: 0,
      expiresAt: body.expiresAt ?? null,
    };
    await ctx.db.codes.insert(record);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "code.created",
      subjectType: "code",
      subjectId: record.id,
      metadata: { role, kind: record.kind },
    });
    return ok(reply, record, 201);
  });

  app.patch("/codes/:codeId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const codeId = (request.params as { codeId: string }).codeId;
    const code = await ctx.db.codes.get(codeId);
    if (!code || code.merchantId !== merchantId) throw notFound("code");
    const body = parseBody(updateSchema, request);
    const patch: Partial<AffiliateCode> = {};
    if (body.usageCap !== undefined) patch.usageCap = body.usageCap ?? null;
    if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt ?? null;
    const updated = await ctx.db.codes.update(codeId, patch);
    return ok(reply, updated);
  });

  app.delete("/codes/:codeId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const codeId = (request.params as { codeId: string }).codeId;
    const code = await ctx.db.codes.get(codeId);
    if (!code || code.merchantId !== merchantId) throw notFound("code");
    await ctx.db.codes.delete(codeId);
    return ok(reply, { deleted: true });
  });

  // ---- Sync into Shopify/Woo/Stripe (stub) ----------------------------------
  app.post("/codes/:codeId/sync", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const codeId = (request.params as { codeId: string }).codeId;
    const code = await ctx.db.codes.get(codeId);
    if (!code || code.merchantId !== merchantId) throw notFound("code");
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "code.synced",
      subjectType: "code",
      subjectId: code.id,
    });
    return ok(reply, { synced: true });
  });
};
