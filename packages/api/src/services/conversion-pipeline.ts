import {
  newId,
  resolveAttribution,
  assessFraud,
  hasSponsorCycle,
  commissionEventToEntry,
  type Attribution,
  type Click,
  type Conversion,
  type LedgerEntry,
  type Offer,
  type Order,
  type AffiliateRelationship,
  type CommissionEvent,
  type OnOrderContext,
  type CodeMatch,
  type FraudSignals,
} from "@affiliate/core";
import type { NormalizedOrder } from "@affiliate/integrations";
import type { AppContext } from "../context.js";
import { recordUsage } from "./entitlements.js";
import { emitWebhook } from "./webhooks.js";

/**
 * The substrate write path (Sections 4–7). One order in → normalized, attributed,
 * fraud-checked, priced by the routed commission engine, and written to the
 * append-only ledger. The engine is a pure function here; this service does ALL
 * the I/O (reads to assemble context, writes of conversion/ledger/overrides) and
 * never contains commission math itself.
 */

export interface IngestResult {
  status: "attributed" | "unattributed" | "duplicate" | "rejected";
  orderId: string;
  conversionId?: string;
  attribution?: Attribution;
  ledgerEntryIds: string[];
  reason: string;
  fraud?: { score: number; decision: string; reasons: string[] };
}

export async function ingestNormalizedOrder(ctx: AppContext, normalized: NormalizedOrder): Promise<IngestResult> {
  const { db, clock } = ctx;
  const now = clock.now();
  const incoming = normalized.order;

  // Idempotency: dedup on (merchant, txn_id) — Section 6.
  const existing = await db.orders.findOne((o) => o.merchantId === incoming.merchantId && o.txnId === incoming.txnId);
  if (existing) {
    return { status: "duplicate", orderId: existing.id, ledgerEntryIds: [], reason: "duplicate txn_id" };
  }

  // Resolve / persist the customer for mining + new-customer logic.
  const order = await persistCustomerAndOrder(ctx, normalized);

  // Assemble attribution inputs.
  const offers = await db.offers.find((o) => o.merchantId === order.merchantId);
  const offersById = new Map(offers.map((o) => [o.id, o]));
  const postbackClick = normalized.clickId ? await db.clicks.get(normalized.clickId) : null;
  const candidateClicks = await recentClicks(ctx, order);
  const matchedCodes = await matchCodes(ctx, order);
  const program = offers[0] ? await db.programs.get(offers[0].programId) : null;
  const priority = program?.attributionPriority ?? "last_touch";

  const lookupRelationship = makeRelationshipLookup(ctx, offersById);
  // Pre-load relationships referenced by candidate clicks + codes so the pure
  // resolver can run synchronously.
  await primeRelationshipCache(ctx, lookupRelationship, candidateClicks, matchedCodes, postbackClick);

  const { attribution, reason } = resolveAttribution({
    order,
    clickIdFromPostback: normalized.clickId ?? null,
    postbackClick: postbackClick ?? null,
    candidateClicks,
    matchedCodes,
    offersById,
    lookupRelationship: lookupRelationship.sync,
    priority,
    now,
  });

  if (!attribution) {
    await emitWebhook(ctx, order.merchantId, "order.unattributed", { orderId: order.id });
    return { status: "unattributed", orderId: order.id, ledgerEntryIds: [], reason };
  }

  const offer = offersById.get(attribution.offerId);
  if (!offer) {
    return { status: "unattributed", orderId: order.id, ledgerEntryIds: [], reason: "attributed offer missing" };
  }

  const relationship = await db.relationships.get(attribution.relationshipId);
  if (!relationship) {
    return { status: "unattributed", orderId: order.id, ledgerEntryIds: [], reason: "relationship missing" };
  }

  // ---- Fraud assessment (Section 4) ----------------------------------------
  const fraud = await assessOrderFraud(ctx, order, attribution, relationship, postbackClick ?? null);

  const conversion: Conversion = {
    id: newId("conv"),
    merchantId: order.merchantId,
    clickId: attribution.clickId,
    orderId: order.id,
    affiliateId: attribution.affiliateId,
    codeId: attribution.codeId,
    amountCents: order.amountCents,
    currency: order.currency,
    status: fraud.decision === "reject" ? "rejected" : "pending",
    reviewStatus: fraud.decision === "review" ? "flagged" : "none",
    ts: now.toISOString(),
  };
  await db.conversions.insert(conversion);

  if (fraud.decision === "reject") {
    await emitWebhook(ctx, order.merchantId, "conversion.rejected", { conversionId: conversion.id, reasons: fraud.reasons });
    return {
      status: "rejected",
      orderId: order.id,
      conversionId: conversion.id,
      ledgerEntryIds: [],
      reason: "fraud: " + fraud.reasons.join("; "),
      fraud,
      attribution,
    };
  }

  // ---- Price via the routed commission engine ------------------------------
  const onOrderCtx = await assembleOnOrderContext(ctx, { order, offer, attribution, relationship, conversionId: conversion.id, now });
  const engine = ctx.engines.get(offer.engine);
  const events = engine.onOrder(onOrderCtx);

  // ---- Write to the append-only ledger -------------------------------------
  const autoApprove = ctx.config.autoApproveConversions && fraud.decision === "approve";
  const holdDays = program?.holdDays ?? ctx.config.defaultHoldDays;
  const availableAt = new Date(now.getTime() + holdDays * 86_400_000);
  const ledgerEntryIds: string[] = [];

  for (const event of events) {
    const entry = commissionEventToEntry(event, {
      merchantId: order.merchantId,
      status: autoApprove ? "approved" : "pending",
      availableAt: autoApprove ? availableAt : null,
      now,
    });
    await db.ledger.insert(entry);
    ledgerEntryIds.push(entry.id);
    if (event.type === "override") {
      await db.overrides.insert({
        id: newId("ovr"),
        conversionId: conversion.id,
        beneficiaryAffiliateId: event.affiliateId,
        level: event.level,
        amountCents: event.amount.amountCents,
      });
    }
  }

  if (autoApprove) await db.conversions.update(conversion.id, { status: "approved" });

  // Increment code usage if a code was used.
  if (attribution.codeId) {
    const code = await db.codes.get(attribution.codeId);
    if (code) await db.codes.update(code.id, { usageCount: code.usageCount + 1 });
  }

  await recordUsage(ctx, order.merchantId, "conversion", 1, conversion.id);
  await emitWebhook(ctx, order.merchantId, "conversion.created", {
    conversionId: conversion.id,
    affiliateId: attribution.affiliateId,
    amountCents: order.amountCents,
    mechanism: attribution.mechanism,
  });

  return {
    status: "attributed",
    orderId: order.id,
    conversionId: conversion.id,
    attribution,
    ledgerEntryIds,
    reason: reason + (fraud.decision === "review" ? " (flagged for review)" : ""),
    fraud,
  };
}

// ---- helpers ----------------------------------------------------------------

async function persistCustomerAndOrder(ctx: AppContext, normalized: NormalizedOrder): Promise<Order> {
  const { db, clock } = ctx;
  const order = { ...normalized.order };
  if (normalized.customerRef) {
    let customer = await db.customers.findOne(
      (c) => c.merchantId === order.merchantId && c.externalCustomerId === normalized.customerRef,
    );
    if (!customer) {
      customer = {
        id: newId("cust"),
        merchantId: order.merchantId,
        externalCustomerId: normalized.customerRef,
        emailHash: null,
        country: order.country,
        firstSeenAt: clock.now().toISOString(),
      };
      await db.customers.insert(customer);
    }
    order.customerId = customer.id;
  }
  return db.orders.insert(order);
}

async function recentClicks(ctx: AppContext, order: Order): Promise<Click[]> {
  // Fallback last-click pool: merchant clicks within the widest offer window.
  const clicks = await ctx.db.clicks.find((c) => c.merchantId === order.merchantId);
  const orderTs = new Date(order.ts).getTime();
  return clicks.filter((c) => new Date(c.ts).getTime() <= orderTs).slice(-200);
}

async function matchCodes(ctx: AppContext, order: Order): Promise<CodeMatch[]> {
  if (order.couponCodes.length === 0) return [];
  const out: CodeMatch[] = [];
  for (const codeStr of order.couponCodes) {
    const code = await ctx.db.codes.findOne((c) => c.merchantId === order.merchantId && c.code === codeStr);
    if (!code) continue;
    const relationship = await ctx.db.relationships.findOne(
      (r) => r.affiliateId === code.affiliateId && r.merchantId === order.merchantId,
    );
    if (relationship) out.push({ code, relationship });
  }
  return out;
}

interface RelationshipLookup {
  sync: (affiliateId: string, offerId: string) => AffiliateRelationship | null;
  cache: Map<string, AffiliateRelationship>;
}

function makeRelationshipLookup(ctx: AppContext, offersById: Map<string, Offer>): RelationshipLookup {
  const cache = new Map<string, AffiliateRelationship>();
  return {
    cache,
    sync: (affiliateId, offerId) => {
      const offer = offersById.get(offerId);
      if (!offer) return null;
      return cache.get(`${affiliateId}:${offer.programId}`) ?? null;
    },
  };
}

async function primeRelationshipCache(
  ctx: AppContext,
  lookup: RelationshipLookup,
  candidateClicks: Click[],
  matchedCodes: CodeMatch[],
  postbackClick: Click | null,
): Promise<void> {
  const all = await ctx.db.relationships.all();
  for (const r of all) lookup.cache.set(`${r.affiliateId}:${r.programId}`, r);
  void candidateClicks;
  void matchedCodes;
  void postbackClick;
}

async function assembleOnOrderContext(
  ctx: AppContext,
  args: {
    order: Order;
    offer: Offer;
    attribution: Attribution;
    relationship: AffiliateRelationship;
    conversionId: string;
    now: Date;
  },
): Promise<OnOrderContext> {
  const { db } = ctx;
  const { order, offer, attribution, relationship, conversionId, now } = args;

  // Prior conversions for this affiliate on this merchant (volume + counts).
  const priorConversions = await db.conversions.find(
    (c) =>
      c.merchantId === order.merchantId &&
      c.affiliateId === relationship.affiliateId &&
      c.id !== conversionId &&
      (c.status === "approved" || c.status === "pending"),
  );
  const priorVolumeCents = priorConversions.reduce((s, c) => s + c.amountCents, 0);
  const priorConversionCount = priorConversions.length;

  // Sponsor relationship (for two-tier override eligibility), guarding cycles.
  let sponsorRelationship: AffiliateRelationship | null = null;
  if (relationship.sponsorAffiliateId) {
    const all = await db.relationships.find((r) => r.merchantId === order.merchantId);
    const byAffiliate = new Map(all.map((r) => [r.affiliateId, r]));
    const cyclic = hasSponsorCycle(
      relationship.affiliateId,
      (id) => byAffiliate.get(id)?.sponsorAffiliateId ?? null,
    );
    if (!cyclic) {
      sponsorRelationship =
        all.find((r) => r.affiliateId === relationship.sponsorAffiliateId && r.programId === offer.programId) ?? null;
    }
  }

  return {
    order,
    attribution,
    conversionId,
    offer,
    relationship,
    sponsorRelationship,
    priorVolumeCents,
    priorConversionCount,
    isFirstConversionForAffiliate: priorConversionCount === 0,
    isFirstSaleUnderSponsor: priorConversionCount === 0,
    now,
  };
}

async function assessOrderFraud(
  ctx: AppContext,
  order: Order,
  attribution: Attribution,
  relationship: AffiliateRelationship,
  click: Click | null,
): Promise<{ score: number; decision: "approve" | "review" | "reject"; reasons: string[] }> {
  const allClicks = await ctx.db.clicks.find((c) => c.merchantId === order.merchantId);
  const affiliateConversions = await ctx.db.conversions.find(
    (c) => c.merchantId === order.merchantId && c.affiliateId === attribution.affiliateId,
  );
  const reversed = affiliateConversions.filter((c) => c.status === "reversed").length;
  const reversalRate = affiliateConversions.length ? reversed / affiliateConversions.length : 0;

  const clickToConversionSeconds = click ? (new Date(order.ts).getTime() - new Date(click.ts).getTime()) / 1000 : null;

  // Self-referral / cycle detection on the sponsor graph.
  const all = await ctx.db.relationships.find((r) => r.merchantId === order.merchantId);
  const byAffiliate = new Map(all.map((r) => [r.affiliateId, r]));
  const isCircular = hasSponsorCycle(relationship.affiliateId, (id) => byAffiliate.get(id)?.sponsorAffiliateId ?? null);

  const reviewRule = order.country; // placeholder for geo-based review; not used directly
  void reviewRule;
  const manualReviewOver = findManualReviewThreshold(ctx, attribution.offerId);

  const signals: FraudSignals = {
    ipClickCountInWindow: click?.ip ? allClicks.filter((c) => c.ip === click.ip).length : 0,
    ipIsDatacenter: false,
    clickToConversionSeconds,
    affiliateReversalRate: reversalRate,
    isSelfReferral: false,
    isCircularSponsorship: isCircular,
    amountCents: order.amountCents,
    manualReviewOverCents: await manualReviewOver,
  };
  return assessFraud(signals);
}

async function findManualReviewThreshold(ctx: AppContext, offerId: string): Promise<number | null> {
  const offer = await ctx.db.offers.get(offerId);
  const rule = offer?.rules.find((r) => r.kind === "manual_review_over_cents");
  return rule && rule.kind === "manual_review_over_cents" ? rule.value : null;
}
