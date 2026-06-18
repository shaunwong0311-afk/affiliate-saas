import { z } from "zod";
import { newId } from "@affiliate/core";
import type { PayoutAccount, TaxDocument } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok } from "./helpers.js";
import { requireMerchant, requirePrincipal } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import {
  computePayableLines,
  createPayoutBatch,
  approveAndDisburse,
  retryPayout,
  addAdjustment,
} from "../services/payout-service.js";

/**
 * Payout operations console (Section 9). Compute payable lines, batch, approve &
 * disburse through the connected rail, retry failures, and post manual
 * adjustments — all scoped to the caller's merchant.
 */
export const payoutRoutes: RouteModule = (app, ctx) => {
  // ---- Payable balances -----------------------------------------------------
  app.get("/payouts/payable", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(
      z.object({ minPayoutCents: z.coerce.number().int().min(0).default(ctx.config.defaultMinPayoutCents) }),
      request,
    );
    const lines = await computePayableLines(ctx, merchantId, q.minPayoutCents);
    return ok(reply, lines);
  });

  // ---- Batches --------------------------------------------------------------
  app.post("/payouts/batches", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const body = parseBody(
      z.object({
        currency: z.string().length(3).default("USD"),
        minPayoutCents: z.number().int().min(0).optional(),
      }),
      request,
    );
    const result = await createPayoutBatch(
      ctx,
      merchantId,
      body.currency.toUpperCase(),
      body.minPayoutCents ?? ctx.config.defaultMinPayoutCents,
    );
    return ok(reply, result, 201);
  });

  app.get("/payouts/batches", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const batches = await ctx.db.payoutBatches.find((b) => b.merchantId === merchantId);
    return ok(reply, batches);
  });

  app.get("/payouts/batches/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const batch = await ctx.db.payoutBatches.get(id);
    if (!batch || batch.merchantId !== merchantId) throw notFound("payout batch");
    const payouts = await ctx.db.payouts.find((p) => p.batchId === id && p.merchantId === merchantId);
    return ok(reply, { ...batch, payouts });
  });

  app.post("/payouts/batches/:id/approve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const id = (request.params as { id: string }).id;
    const batch = await ctx.db.payoutBatches.get(id);
    if (!batch || batch.merchantId !== merchantId) throw notFound("payout batch");
    const p = requirePrincipal(request);
    const result = await approveAndDisburse(ctx, id, p.userId ?? "system");
    return ok(reply, result);
  });

  // ---- Individual payouts ---------------------------------------------------
  app.post("/payouts/:payoutId/retry", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const payoutId = (request.params as { payoutId: string }).payoutId;
    const payout = await ctx.db.payouts.get(payoutId);
    if (!payout || payout.merchantId !== merchantId) throw notFound("payout");
    const result = await retryPayout(ctx, payoutId);
    return ok(reply, result);
  });

  app.get("/payouts", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(z.object({ status: z.string().optional() }), request);
    const payouts = await ctx.db.payouts.find(
      (p) => p.merchantId === merchantId && (!q.status || p.status === q.status),
    );
    return ok(reply, payouts);
  });

  // ---- Manual adjustments ---------------------------------------------------
  app.post("/payouts/adjustments", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const body = parseBody(
      z.object({
        affiliateId: z.string().min(1),
        amountCents: z.number().int(),
        currency: z.string().length(3).default("USD"),
        reason: z.string().min(1),
      }),
      request,
    );
    // A money adjustment may only target an affiliate linked to this merchant.
    const rel = await ctx.db.relationships.findOne((r) => r.affiliateId === body.affiliateId && r.merchantId === merchantId);
    if (!rel) throw notFound("affiliate");
    const createdBy = requirePrincipal(request).userId ?? "system";
    await addAdjustment(ctx, {
      merchantId,
      affiliateId: body.affiliateId,
      amountCents: body.amountCents,
      currency: body.currency.toUpperCase(),
      reason: body.reason,
      createdBy,
    });
    return ok(reply, { ok: true }, 201);
  });

  // ---- Affiliate payout account & tax document ------------------------------
  app.post("/affiliates/:affiliateId/payout-account", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const affiliateId = (request.params as { affiliateId: string }).affiliateId;
    const relationship = await ctx.db.relationships.findOne(
      (r) => r.affiliateId === affiliateId && r.merchantId === merchantId,
    );
    if (!relationship) throw notFound("affiliate");
    const body = parseBody(
      z.object({
        rail: z.string().min(1),
        accountRef: z.string().min(1),
        currency: z.string().length(3),
      }),
      request,
    );
    const account: PayoutAccount = {
      id: newId("pa"),
      affiliateId,
      rail: body.rail,
      accountRef: body.accountRef,
      status: "active",
      currency: body.currency.toUpperCase(),
    };
    await ctx.db.payoutAccounts.insert(account);
    return ok(reply, account, 201);
  });

  app.post("/affiliates/:affiliateId/tax-document", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const affiliateId = (request.params as { affiliateId: string }).affiliateId;
    const relationship = await ctx.db.relationships.findOne(
      (r) => r.affiliateId === affiliateId && r.merchantId === merchantId,
    );
    if (!relationship) throw notFound("affiliate");
    const body = parseBody(
      z.object({ formType: z.enum(["W-9", "W-8BEN", "W-8BEN-E", "other"]) }),
      request,
    );
    const doc: TaxDocument = {
      id: newId("tax"),
      affiliateId,
      rail: null,
      formType: body.formType,
      status: "on_file",
      collectedAt: ctx.clock.now().toISOString(),
    };
    await ctx.db.taxDocuments.insert(doc);
    return ok(reply, doc, 201);
  });
};
