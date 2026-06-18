import { z } from "zod";
import { newId } from "@affiliate/core";
import type { BillingSubscription, Entitlement } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const planSchema = z.object({
  plan: z.enum(["track_export", "managed_payouts", "done_for_you"]),
});

const entitlementSchema = z.object({
  feature: z.string().min(1),
  limitValue: z.number().int().min(0).nullable(),
});

export const billingRoutes: RouteModule = (app, ctx) => {
  // ---- Subscription ---------------------------------------------------------
  app.get("/billing/subscription", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const subscription = await ctx.db.subscriptions.findOne((s) => s.merchantId === merchantId);
    if (!subscription) throw notFound("subscription");
    return ok(reply, subscription);
  });

  app.post("/billing/subscription/plan", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const subscription = await ctx.db.subscriptions.findOne((s) => s.merchantId === merchantId);
    if (!subscription) throw notFound("subscription");
    const body = parseBody(planSchema, request);
    const updated = await ctx.db.subscriptions.update(subscription.id, {
      plan: body.plan,
      status: "active",
    } as Partial<BillingSubscription>);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "billing.plan_changed",
      subjectType: "subscription",
      subjectId: subscription.id,
      metadata: { plan: body.plan },
    });
    return ok(reply, updated);
  });

  // ---- Entitlements ---------------------------------------------------------
  app.get("/billing/entitlements", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const entitlements = await ctx.db.entitlements.find((e) => e.merchantId === merchantId);
    return ok(reply, entitlements);
  });

  app.put("/billing/entitlements", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(entitlementSchema, request);
    const existing = await ctx.db.entitlements.findOne(
      (e) => e.merchantId === merchantId && e.feature === body.feature,
    );
    if (existing) {
      const updated = await ctx.db.entitlements.update(existing.id, {
        limitValue: body.limitValue,
      } as Partial<Entitlement>);
      await writeAudit(ctx, {
        merchantId,
        actorId: null,
        action: "billing.entitlement_updated",
        subjectType: "entitlement",
        subjectId: existing.id,
        metadata: { feature: body.feature, limitValue: body.limitValue },
      });
      return ok(reply, updated);
    }
    const subscription = await ctx.db.subscriptions.findOne((s) => s.merchantId === merchantId);
    const entitlement: Entitlement = {
      id: newId("ent"),
      merchantId,
      feature: body.feature,
      limitValue: body.limitValue,
      sourcePlan: subscription?.plan ?? "track_export",
    };
    await ctx.db.entitlements.insert(entitlement);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "billing.entitlement_created",
      subjectType: "entitlement",
      subjectId: entitlement.id,
      metadata: { feature: body.feature, limitValue: body.limitValue },
    });
    return ok(reply, entitlement, 201);
  });

  // ---- Usage ----------------------------------------------------------------
  app.get("/billing/usage", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const events = await ctx.db.usageEvents.find((e) => e.merchantId === merchantId);
    const byKind: Record<string, number> = {};
    for (const event of events) {
      byKind[event.kind] = (byKind[event.kind] ?? 0) + event.quantity;
    }
    return ok(reply, { usage: byKind });
  });

  // ---- Cancel / reactivate --------------------------------------------------
  app.post("/billing/cancel", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "owner");
    const subscription = await ctx.db.subscriptions.findOne((s) => s.merchantId === merchantId);
    if (!subscription) throw notFound("subscription");
    const updated = await ctx.db.subscriptions.update(subscription.id, {
      status: "cancelled",
    } as Partial<BillingSubscription>);
    await ctx.db.merchants.update(merchantId, { billingStatus: "cancelled" });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "billing.cancelled",
      subjectType: "subscription",
      subjectId: subscription.id,
      metadata: {},
    });
    return ok(reply, updated);
  });

  app.post("/billing/reactivate", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "owner");
    const subscription = await ctx.db.subscriptions.findOne((s) => s.merchantId === merchantId);
    if (!subscription) throw notFound("subscription");
    const updated = await ctx.db.subscriptions.update(subscription.id, {
      status: "active",
    } as Partial<BillingSubscription>);
    await ctx.db.merchants.update(merchantId, { billingStatus: "active" });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "billing.reactivated",
      subjectType: "subscription",
      subjectId: subscription.id,
      metadata: {},
    });
    return ok(reply, updated);
  });
};
