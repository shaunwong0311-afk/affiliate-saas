import { z } from "zod";
import type { RouteModule } from "./helpers.js";
import { parseQuery, parseBody, ok, paginationSchema, paginate } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { approveConversion, rejectConversion } from "../services/reversal.js";

const listQuerySchema = paginationSchema.extend({
  status: z.enum(["pending", "approved", "rejected", "reversed"]).optional(),
  reviewStatus: z.enum(["none", "flagged", "cleared", "rejected"]).optional(),
  affiliateId: z.string().optional(),
});

export const conversionRoutes: RouteModule = (app, ctx) => {
  app.get("/conversions", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(listQuerySchema, request);
    const rows = await ctx.db.conversions.find(
      (c) =>
        c.merchantId === merchantId &&
        (q.status === undefined || c.status === q.status) &&
        (q.reviewStatus === undefined || c.reviewStatus === q.reviewStatus) &&
        (q.affiliateId === undefined || c.affiliateId === q.affiliateId),
    );
    return ok(reply, paginate(rows, q));
  });

  app.get("/conversions/review-queue", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const rows = await ctx.db.conversions.find(
      (c) => c.merchantId === merchantId && c.reviewStatus === "flagged" && c.status === "pending",
    );
    return ok(reply, rows);
  });

  app.get("/conversions/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const conversion = await ctx.db.conversions.get(id);
    if (!conversion || conversion.merchantId !== merchantId) throw notFound("conversion");
    const order = await ctx.db.orders.get(conversion.orderId);
    const ledger = await ctx.db.ledger.find((e) => e.conversionId === id);
    return ok(reply, { ...conversion, order, ledger });
  });

  app.post("/conversions/:id/approve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const id = (request.params as { id: string }).id;
    const conversion = await ctx.db.conversions.get(id);
    if (!conversion || conversion.merchantId !== merchantId) throw notFound("conversion");
    await approveConversion(ctx, id, ctx.config.defaultHoldDays);
    const updated = await ctx.db.conversions.get(id);
    return ok(reply, updated);
  });

  app.post("/conversions/:id/reject", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const id = (request.params as { id: string }).id;
    const conversion = await ctx.db.conversions.get(id);
    if (!conversion || conversion.merchantId !== merchantId) throw notFound("conversion");
    const body = parseBody(z.object({ reason: z.string().optional() }), request);
    await rejectConversion(ctx, id, body.reason ?? "rejected");
    const updated = await ctx.db.conversions.get(id);
    return ok(reply, updated);
  });
};
