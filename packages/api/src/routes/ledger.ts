import { z } from "zod";
import { computeBalances } from "@affiliate/core";
import type { LedgerEntry } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseQuery, ok, paginationSchema, paginate } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";

export const ledgerRoutes: RouteModule = (app, ctx) => {
  // ---- List ledger entries --------------------------------------------------
  app.get("/ledger", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const q = parseQuery(
      paginationSchema.extend({
        affiliateId: z.string().optional(),
        status: z.string().optional(),
        type: z.string().optional(),
      }),
      request,
    );
    const entries = await ctx.db.ledger.find(
      (e) =>
        e.merchantId === merchantId &&
        (q.affiliateId === undefined || e.affiliateId === q.affiliateId) &&
        (q.status === undefined || e.status === q.status) &&
        (q.type === undefined || e.type === q.type),
    );
    return ok(reply, paginate(entries, q));
  });

  // ---- Balances per affiliate -----------------------------------------------
  app.get("/ledger/balances", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const entries = await ctx.db.ledger.find((e) => e.merchantId === merchantId);
    const now = ctx.clock.now();

    const byAffiliate = new Map<string, LedgerEntry[]>();
    for (const e of entries) {
      const list = byAffiliate.get(e.affiliateId);
      if (list) list.push(e);
      else byAffiliate.set(e.affiliateId, [e]);
    }

    const result = [];
    for (const [affiliateId, affiliateEntries] of byAffiliate) {
      const affiliate = await ctx.db.affiliates.get(affiliateId);
      const balances = [...computeBalances(affiliateEntries, now).values()];
      result.push({ affiliateId, name: affiliate?.name ?? null, balances });
    }
    return ok(reply, result);
  });

  // ---- Single affiliate statement -------------------------------------------
  app.get("/affiliates/:affiliateId/statement", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const affiliateId = (request.params as { affiliateId: string }).affiliateId;
    const affiliate = await ctx.db.affiliates.get(affiliateId);
    if (!affiliate) throw notFound("affiliate");
    // Affiliates are GLOBAL entities; only expose one to a merchant it is linked to.
    const rel = await ctx.db.relationships.findOne((r) => r.affiliateId === affiliateId && r.merchantId === merchantId);
    if (!rel) throw notFound("affiliate");
    const entries = await ctx.db.ledger.find(
      (e) => e.merchantId === merchantId && e.affiliateId === affiliateId,
    );
    const balances = [...computeBalances(entries, ctx.clock.now()).values()];
    return ok(reply, { affiliate, entries, balances });
  });
};
