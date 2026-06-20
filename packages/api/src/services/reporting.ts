import { computeBalances, type LedgerEntry } from "@affiliate/core";
import type { AppContext } from "../context.js";

/**
 * Reporting framework (Section 9 / 13). Aggregations for the merchant dashboard:
 * program health, money operations, the recruitment funnel, affiliate
 * performance, and LTV/cohort analysis of affiliate-acquired customers — the
 * number that proves the program's value beyond clicks.
 */

/**
 * The producing funnel (Section 13) — the metrics best operators actually track,
 * now computable because relationships carry a prospectId/source. Goes past
 * signup to "did they produce sales", and attributes producers to the source that
 * found them: cost per PRODUCING affiliate, % producing, time-to-first-sale, and
 * revenue by source cohort.
 */
export async function producingFunnel(ctx: AppContext, merchantId: string) {
  const { db } = ctx;
  const prospects = await db.prospects.find((p) => p.merchantId === merchantId);
  const relationships = await db.relationships.find((r) => r.merchantId === merchantId);
  const recruited = relationships.filter((r) => r.prospectId != null);
  const conversions = await db.conversions.find((c) => c.merchantId === merchantId && c.status !== "rejected");
  const orders = await db.orders.find((o) => o.merchantId === merchantId);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const producingAffiliateIds = new Set(conversions.map((c) => c.affiliateId));
  const usage = await db.usageEvents.find((e) => e.merchantId === merchantId);
  const sends = usage.filter((e) => e.kind === "send").reduce((s, e) => s + e.quantity, 0);
  const enrichments = usage.filter((e) => e.kind === "enrichment").reduce((s, e) => s + e.quantity, 0);

  // Source cohorts: sourced → recruited → producing → revenue.
  const cohorts = new Map<string, { sourced: number; recruited: number; producing: number; revenueCents: number }>();
  const ensure = (s: string) => {
    let c = cohorts.get(s);
    if (!c) {
      c = { sourced: 0, recruited: 0, producing: 0, revenueCents: 0 };
      cohorts.set(s, c);
    }
    return c;
  };
  for (const p of prospects) ensure(p.source).sourced += 1;
  for (const r of recruited) {
    const c = ensure(r.source);
    c.recruited += 1;
    if (producingAffiliateIds.has(r.affiliateId)) {
      c.producing += 1;
      c.revenueCents += conversions.filter((cv) => cv.affiliateId === r.affiliateId).reduce((s, cv) => s + cv.amountCents, 0);
    }
  }

  // Time-to-first-sale: days from join to first conversion, for recruited producers.
  const ttfsDays: number[] = [];
  for (const r of recruited) {
    const first = conversions
      .filter((c) => c.affiliateId === r.affiliateId)
      .map((c) => orderById.get(c.orderId)?.ts ?? c.ts)
      .sort()[0];
    if (first) ttfsDays.push((new Date(first).getTime() - new Date(r.joinedAt).getTime()) / 86_400_000);
  }

  const recruitedProducing = recruited.filter((r) => producingAffiliateIds.has(r.affiliateId)).length;
  // Cost proxies (no real $ spend tracked): enrichment + send unit counts.
  const recruitedCount = recruited.length || 1;
  return {
    sourced: prospects.length,
    recruited: recruited.length,
    producing: recruitedProducing,
    percentProducingOfRecruited: recruited.length ? recruitedProducing / recruited.length : 0,
    avgTimeToFirstSaleDays: ttfsDays.length ? ttfsDays.reduce((a, b) => a + b, 0) / ttfsDays.length : null,
    enrichmentUnits: enrichments,
    sendUnits: sends,
    enrichmentUnitsPerRecruited: enrichments / recruitedCount,
    sendUnitsPerProducing: recruitedProducing ? sends / recruitedProducing : null,
    bySource: [...cohorts.entries()]
      .map(([source, c]) => ({ source, ...c, producingRate: c.sourced ? c.producing / c.sourced : 0 }))
      .sort((a, b) => b.producing - a.producing),
  };
}

export async function programHealth(ctx: AppContext, merchantId: string) {
  const { db, clock } = ctx;
  const now = clock.now();
  const relationships = await db.relationships.find((r) => r.merchantId === merchantId);
  const conversions = await db.conversions.find((c) => c.merchantId === merchantId);
  const clicks = await db.clicks.find((c) => c.merchantId === merchantId);
  const producingAffiliates = new Set(conversions.filter((c) => c.status !== "rejected").map((c) => c.affiliateId));

  const grossRevenueCents = conversions.filter((c) => c.status === "approved").reduce((s, c) => s + c.amountCents, 0);
  const reversed = conversions.filter((c) => c.status === "reversed").length;
  const refundRate = conversions.length ? reversed / conversions.length : 0;
  const epcCents = clicks.length ? Math.round(grossRevenueCents / clicks.length) : 0;

  return {
    activeAffiliates: relationships.filter((r) => r.status === "active").length,
    totalAffiliates: relationships.length,
    producingAffiliates: producingAffiliates.size,
    percentProducing: relationships.length ? producingAffiliates.size / relationships.length : 0,
    revenueViaAffiliatesCents: grossRevenueCents,
    clicks: clicks.length,
    conversions: conversions.filter((c) => c.status !== "rejected").length,
    epcCents,
    refundRate,
  };
}

export async function moneyOps(ctx: AppContext, merchantId: string) {
  const { db, clock } = ctx;
  const now = clock.now();
  const entries = await db.ledger.find((e) => e.merchantId === merchantId);
  const byAffiliate = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const list = byAffiliate.get(e.affiliateId) ?? [];
    list.push(e);
    byAffiliate.set(e.affiliateId, list);
  }
  let unpaidLiability = 0;
  let heldBalance = 0;
  let pending = 0;
  let negativeExposure = 0;
  for (const list of byAffiliate.values()) {
    for (const [, b] of computeBalances(list, now)) {
      unpaidLiability += Math.max(0, b.availableCents);
      heldBalance += b.onHoldCents;
      pending += b.pendingCents;
      if (b.availableCents < 0) negativeExposure += b.availableCents;
    }
  }
  const payouts = await db.payouts.find((p) => p.merchantId === merchantId);
  const failed = payouts.filter((p) => p.status === "failed").length;
  const reversalEntries = entries.filter((e) => e.type === "reversal").length;

  return {
    unpaidLiabilityCents: unpaidLiability,
    heldBalanceCents: heldBalance,
    pendingCents: pending,
    negativeBalanceExposureCents: negativeExposure,
    failedPayoutRate: payouts.length ? failed / payouts.length : 0,
    reversalCount: reversalEntries,
    paidCents: payouts.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountCents, 0),
  };
}

export async function recruitmentFunnel(ctx: AppContext, merchantId: string) {
  const prospects = await ctx.db.prospects.find((p) => p.merchantId === merchantId);
  const byState: Record<string, number> = {};
  for (const p of prospects) byState[p.state] = (byState[p.state] ?? 0) + 1;
  const byTier: Record<string, number> = {};
  for (const p of prospects) if (p.tier) byTier[p.tier] = (byTier[p.tier] ?? 0) + 1;
  const sourced = prospects.length;
  const contacted = prospects.filter((p) => ["contacted", "in_sequence", "replied", "converted"].includes(p.state)).length;
  const replied = prospects.filter((p) => ["replied", "converted"].includes(p.state)).length;
  const converted = prospects.filter((p) => p.state === "converted").length;
  return {
    sourced,
    contacted,
    replied,
    converted,
    replyRate: contacted ? replied / contacted : 0,
    conversionRate: contacted ? converted / contacted : 0,
    byState,
    byTier,
  };
}

export async function affiliatePerformance(ctx: AppContext, merchantId: string) {
  const { db } = ctx;
  const relationships = await db.relationships.find((r) => r.merchantId === merchantId);
  const out = [];
  for (const rel of relationships) {
    const affiliate = await db.affiliates.get(rel.affiliateId);
    const clicks = await db.clicks.count((c) => c.merchantId === merchantId && c.affiliateId === rel.affiliateId);
    const conversions = await db.conversions.find((c) => c.merchantId === merchantId && c.affiliateId === rel.affiliateId);
    const earnings = (await db.ledger.find((e) => e.merchantId === merchantId && e.affiliateId === rel.affiliateId && e.status !== "reversed")).reduce(
      (s, e) => s + e.amountCents,
      0,
    );
    out.push({
      affiliateId: rel.affiliateId,
      name: affiliate?.name ?? rel.affiliateId,
      role: rel.role,
      status: rel.status,
      clicks,
      conversions: conversions.filter((c) => c.status !== "rejected").length,
      earningsCents: earnings,
      epcCents: clicks ? Math.round(earnings / clicks) : 0,
    });
  }
  return out.sort((a, b) => b.earningsCents - a.earningsCents);
}

/** LTV / cohort analysis of affiliate-acquired customers (Section 9). */
export async function ltvCohort(ctx: AppContext, merchantId: string) {
  const { db } = ctx;
  const conversions = await db.conversions.find((c) => c.merchantId === merchantId && c.status !== "rejected");
  const orders = await db.orders.find((o) => o.merchantId === merchantId);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const cohorts = new Map<string, { customers: Set<string>; revenueCents: number; orders: number }>();
  for (const c of conversions) {
    const order = orderById.get(c.orderId);
    const month = (order?.ts ?? c.ts).slice(0, 7);
    const cohort = cohorts.get(month) ?? { customers: new Set(), revenueCents: 0, orders: 0 };
    if (order?.customerId) cohort.customers.add(order.customerId);
    cohort.revenueCents += c.amountCents;
    cohort.orders += 1;
    cohorts.set(month, cohort);
  }
  return [...cohorts.entries()]
    .map(([month, c]) => ({
      cohortMonth: month,
      affiliateAcquiredCustomers: c.customers.size,
      revenueCents: c.revenueCents,
      orders: c.orders,
      avgOrderValueCents: c.orders ? Math.round(c.revenueCents / c.orders) : 0,
    }))
    .sort((a, b) => a.cohortMonth.localeCompare(b.cohortMonth));
}
