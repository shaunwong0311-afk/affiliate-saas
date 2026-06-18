import { newId } from "@affiliate/core";
import type { UsageEvent } from "@affiliate/db";
import type { AppContext } from "../context.js";

/**
 * Usage metering + entitlement checks (Section 9 billing). Records usage events
 * (enrichment, sends, active affiliates, recruitment credits) and enforces plan
 * limits before metered actions run.
 */
export async function recordUsage(
  ctx: AppContext,
  merchantId: string,
  kind: UsageEvent["kind"],
  quantity = 1,
  sourceId: string | null = null,
): Promise<void> {
  await ctx.db.usageEvents.insert({
    id: newId("use"),
    merchantId,
    kind,
    quantity,
    sourceId,
    ts: ctx.clock.now().toISOString(),
  });
}

export async function usageThisPeriod(ctx: AppContext, merchantId: string, kind: UsageEvent["kind"]): Promise<number> {
  const events = await ctx.db.usageEvents.find((e) => e.merchantId === merchantId && e.kind === kind);
  return events.reduce((s, e) => s + e.quantity, 0);
}

export class EntitlementExceededError extends Error {
  statusCode = 402;
  constructor(feature: string, limit: number) {
    super(`entitlement "${feature}" exceeded (limit ${limit})`);
    this.name = "EntitlementExceededError";
  }
}

/** Throws if a metered action would exceed the merchant's entitlement. */
export async function assertWithinEntitlement(
  ctx: AppContext,
  merchantId: string,
  feature: string,
  usageKind: UsageEvent["kind"],
  additional = 1,
): Promise<void> {
  const ent = await ctx.db.entitlements.findOne((e) => e.merchantId === merchantId && e.feature === feature);
  if (!ent || ent.limitValue == null) return; // unlimited / unset
  const used = await usageThisPeriod(ctx, merchantId, usageKind);
  if (used + additional > ent.limitValue) {
    throw new EntitlementExceededError(feature, ent.limitValue);
  }
}
