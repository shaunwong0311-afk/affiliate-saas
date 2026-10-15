import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Payout, PayoutAccount, PayoutBatch, TaxDocument } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok } from "./helpers.js";
import { requireMerchant, requirePrincipal } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import {
  computePayableLines,
  createPayoutBatch,
  approveAndDisburse,
  cancelPayoutBatch,
  exportPayoutBatch,
  retryPayout,
  markPayoutPaid,
  markPayoutFailed,
  addAdjustment,
} from "../services/payout-service.js";

/**
 * Payout operations console (Section 9). Compute payable lines, batch, approve, export
 * the file the merchant pays from, mark payouts paid or failed, retry, and post manual
 * adjustments — all scoped to the caller's merchant. Money never passes through the
 * platform: an approved payout is `awaiting_payment` until the merchant says it was paid.
 */
export const payoutRoutes: RouteModule = (app, ctx) => {
  const actorOf = (request: Parameters<typeof requirePrincipal>[0]): string => requirePrincipal(request).userId ?? "system";

  /** A batch plus what the console shows for it: how many payouts it holds and what they add up to. */
  const describeBatch = (batch: PayoutBatch, payouts: Payout[]) => {
    const live = payouts.filter((p) => p.status !== "cancelled");
    return {
      ...batch,
      createdAt: batch.ts,
      approvedAt: batch.approvedAt ?? null,
      payoutCount: live.length,
      totalCents: live.reduce((s, p) => s + p.amountCents, 0),
    };
  };

  const describePayouts = async (payouts: Payout[]) => {
    const names = new Map<string, string>();
    for (const id of new Set(payouts.map((p) => p.affiliateId))) {
      names.set(id, (await ctx.db.affiliates.get(id))?.name ?? id);
    }
    return payouts.map((p) => ({ ...p, affiliateName: names.get(p.affiliateId) ?? p.affiliateId, rail: p.method, createdAt: p.ts }));
  };

  const ownBatch = async (merchantId: string, id: string): Promise<PayoutBatch> => {
    const batch = await ctx.db.payoutBatches.get(id);
    if (!batch || batch.merchantId !== merchantId) throw notFound("payout batch");
    return batch;
  };

  const ownPayout = async (merchantId: string, id: string): Promise<Payout> => {
    const payout = await ctx.db.payouts.get(id);
    if (!payout || payout.merchantId !== merchantId) throw notFound("payout");
    return payout;
  };

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
        currency: z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
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
    return ok(reply, { ...result, batch: describeBatch(result.batch, result.payouts), payouts: await describePayouts(result.payouts) }, 201);
  });

  app.get("/payouts/batches", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const batches = await ctx.db.payoutBatches.find((b) => b.merchantId === merchantId);
    const payouts = await ctx.db.payouts.find((p) => p.merchantId === merchantId);
    return ok(
      reply,
      batches.map((b) => describeBatch(b, payouts.filter((p) => p.batchId === b.id))),
    );
  });

  app.get("/payouts/batches/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const batch = await ownBatch(merchantId, id);
    const payouts = await ctx.db.payouts.find((p) => p.batchId === id && p.merchantId === merchantId);
    return ok(reply, { ...describeBatch(batch, payouts), payouts: await describePayouts(payouts) });
  });

  app.post("/payouts/batches/:id/approve", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const id = (request.params as { id: string }).id;
    await ownBatch(merchantId, id);
    const result = await approveAndDisburse(ctx, id, actorOf(request));
    return ok(reply, await describePayouts(result));
  });

  // Withdraw a draft: reservations are released, nothing is sent.
  app.post("/payouts/batches/:id/cancel", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const id = (request.params as { id: string }).id;
    await ownBatch(merchantId, id);
    const batch = await cancelPayoutBatch(ctx, id, actorOf(request));
    const payouts = await ctx.db.payouts.find((p) => p.batchId === id);
    return ok(reply, describeBatch(batch, payouts));
  });

  // The file the merchant pays from: PayPal mass-payment layout, Wise batch layout, or a
  // generic CSV. Lists the payouts still awaiting payment.
  app.get("/payouts/batches/:id/export", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const id = (request.params as { id: string }).id;
    const q = parseQuery(z.object({ format: z.enum(["paypal", "wise", "csv"]).default("csv") }), request);
    await ownBatch(merchantId, id);
    const file = await exportPayoutBatch(ctx, id, q.format, actorOf(request));
    return reply
      .status(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file.filename}"`)
      .header("cache-control", "no-store")
      .header("x-payouts-included", String(file.included))
      .header("x-payouts-omitted", String(file.omitted))
      .send(file.csv);
  });

  // ---- Individual payouts ---------------------------------------------------
  app.post("/payouts/:payoutId/retry", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const payoutId = (request.params as { payoutId: string }).payoutId;
    await ownPayout(merchantId, payoutId);
    // `manual: true` hands the payout to the merchant instead of asking a rail again.
    const body = parseBody(z.object({ manual: z.boolean().optional() }).default({}), request);
    const result = await retryPayout(ctx, payoutId, { manual: body.manual === true });
    return ok(reply, (await describePayouts([result]))[0]);
  });

  // The merchant paid it from their own account.
  app.post("/payouts/:payoutId/mark-paid", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const payoutId = (request.params as { payoutId: string }).payoutId;
    await ownPayout(merchantId, payoutId);
    const body = parseBody(z.object({ reference: z.string().max(200).optional() }).default({}), request);
    const result = await markPayoutPaid(ctx, payoutId, actorOf(request), body.reference ?? null);
    return ok(reply, (await describePayouts([result]))[0]);
  });

  // It did not go through: the balance becomes payable again.
  app.post("/payouts/:payoutId/mark-failed", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const payoutId = (request.params as { payoutId: string }).payoutId;
    await ownPayout(merchantId, payoutId);
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }), request);
    const result = await markPayoutFailed(ctx, payoutId, actorOf(request), body.reason);
    return ok(reply, (await describePayouts([result]))[0]);
  });

  app.get("/payouts", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(z.object({ status: z.string().optional() }), request);
    const payouts = await ctx.db.payouts.find(
      (p) => p.merchantId === merchantId && (!q.status || p.status === q.status),
    );
    return ok(reply, await describePayouts(payouts));
  });

  // ---- Manual adjustments ---------------------------------------------------
  app.post("/payouts/adjustments", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const body = parseBody(
      z.object({
        affiliateId: z.string().min(1),
        amountCents: z.number().int().refine((n) => Number.isSafeInteger(n) && n !== 0, "must be a non-zero whole number of cents"),
        currency: z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
        reason: z.string().min(1),
      }),
      request,
    );
    // A money adjustment may only target an affiliate linked to this merchant.
    const rel = await ctx.db.relationships.findOne((r) => r.affiliateId === body.affiliateId && r.merchantId === merchantId);
    if (!rel) throw notFound("affiliate");
    await addAdjustment(ctx, {
      merchantId,
      affiliateId: body.affiliateId,
      amountCents: body.amountCents,
      currency: body.currency.toUpperCase(),
      reason: body.reason,
      createdBy: actorOf(request),
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
      // Recorded BY this merchant: used for this merchant's payouts only (see PayoutAccount.merchantId).
      merchantId,
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
      merchantId, // counts for this merchant only (see TaxDocument.merchantId)
      rail: null,
      formType: body.formType,
      status: "on_file",
      collectedAt: ctx.clock.now().toISOString(),
    };
    await ctx.db.taxDocuments.insert(doc);
    return ok(reply, doc, 201);
  });
};
