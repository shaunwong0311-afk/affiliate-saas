import type { RouteModule } from "./helpers.js";
import { ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { programHealth, moneyOps, recruitmentFunnel, affiliatePerformance, ltvCohort } from "../services/reporting.js";

/**
 * Dashboards (Section 9 / 13). Read-only aggregations over the merchant's data.
 * Every endpoint is scoped to the merchant resolved by requireMerchant("read").
 */
export const reportingRoutes: RouteModule = (app, ctx) => {
  app.get("/reports/program-health", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await programHealth(ctx, merchantId));
  });

  app.get("/reports/money-ops", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await moneyOps(ctx, merchantId));
  });

  app.get("/reports/recruitment-funnel", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await recruitmentFunnel(ctx, merchantId));
  });

  app.get("/reports/affiliate-performance", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await affiliatePerformance(ctx, merchantId));
  });

  app.get("/reports/ltv-cohort", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, await ltvCohort(ctx, merchantId));
  });

  app.get("/reports/overview", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    return ok(reply, {
      health: await programHealth(ctx, merchantId),
      money: await moneyOps(ctx, merchantId),
      funnel: await recruitmentFunnel(ctx, merchantId),
    });
  });
};
