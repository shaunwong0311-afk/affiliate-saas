import { z } from "zod";
import { signPostback, type PostbackPayload } from "@affiliate/core";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { badRequest, notFound } from "../errors.js";
import { ingestOrder, mintClickId, writeClick, resolveTrackingCode } from "../services/tracking.js";
import { reverseOrder } from "../services/reversal.js";

export const ingestionRoutes: RouteModule = (app, ctx) => {
  // ---- Public signed S2S postback (Section 6) -------------------------------
  // The robust conversion path: HMAC-signed with the per-merchant secret.
  app.post("/track/postback/:merchantId", async (request, reply) => {
    const merchantId = (request.params as { merchantId: string }).merchantId;
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    const signature = (request.headers["x-affiliate-signature"] as string) ?? null;
    const result = await ingestOrder(ctx, "s2s", {
      merchantId,
      raw: request.body,
      signature,
      secret: merchant.postbackSecret,
    });
    return ok(reply, result, result.status === "rejected" ? 422 : 200);
  });

  // ---- Authenticated ingestion for connected integrations -------------------
  app.post("/ingest/:source", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const source = (request.params as { source: string }).source;
    if (!["shopify", "woocommerce", "stripe", "s2s"].includes(source)) throw badRequest("unknown source");
    const merchant = await ctx.db.merchants.require(merchantId);
    const result = await ingestOrder(ctx, source, {
      merchantId,
      raw: request.body,
      signature: (request.headers["x-affiliate-signature"] as string) ?? null,
      secret: merchant.postbackSecret,
    });
    return ok(reply, result);
  });

  // ---- Click capture (off-edge fallback / SDK) ------------------------------
  app.post("/track/click", async (request, reply) => {
    const body = parseBody(
      z.object({
        code: z.string(),
        ip: z.string().nullish(),
        ua: z.string().nullish(),
        landingUrl: z.string().nullish(),
        sub1: z.string().optional(),
        sub2: z.string().optional(),
      }),
      request,
    );
    const resolved = await resolveTrackingCode(ctx, body.code);
    if (!resolved) throw badRequest("unknown tracking code");
    const clickId = mintClickId();
    await writeClick(ctx, clickId, {
      ...resolved,
      ip: body.ip ?? null,
      ua: body.ua ?? null,
      landingUrl: body.landingUrl ?? null,
      ...(body.sub1 ? { sub1: body.sub1 } : {}),
      ...(body.sub2 ? { sub2: body.sub2 } : {}),
    });
    return ok(reply, { clickId });
  });

  // ---- Validation/test tool (Section 6) -------------------------------------
  // Lets a merchant confirm conversions fire before going live; returns the
  // signature they should send so they can wire their checkout.
  app.post("/track/test-postback", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const merchant = await ctx.db.merchants.require(merchantId);
    const body = parseBody(
      z.object({
        txnId: z.string(),
        amountCents: z.number().int().positive(),
        currency: z.string().length(3).default("USD"),
        clickId: z.string().nullish(),
        couponCodes: z.array(z.string()).default([]),
      }),
      request,
    );
    const payload: PostbackPayload = {
      merchantId,
      txnId: body.txnId,
      amountCents: body.amountCents,
      currency: body.currency,
      clickId: body.clickId ?? null,
      couponCodes: body.couponCodes,
      customerRef: null,
      ts: Math.floor(ctx.clock.now().getTime() / 1000),
    };
    const signature = signPostback(payload, merchant.postbackSecret);
    const result = await ingestOrder(ctx, "s2s", { merchantId, raw: payload, signature, secret: merchant.postbackSecret });
    return ok(reply, { signature, result, exampleHeader: { "x-affiliate-signature": signature } });
  });

  // ---- Refund / clawback ----------------------------------------------------
  app.post("/orders/:orderId/refund", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const orderId = (request.params as { orderId: string }).orderId;
    const order = await ctx.db.orders.get(orderId);
    if (!order || order.merchantId !== merchantId) throw notFound("order");
    const body = parseBody(z.object({ reason: z.string().default("refund") }), request);
    const result = await reverseOrder(ctx, orderId, body.reason);
    if (!result) throw notFound("no reversible conversion for order");
    return ok(reply, result);
  });
};
