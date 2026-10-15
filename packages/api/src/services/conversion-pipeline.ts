import { createHash } from "node:crypto";
import {
  newId,
  resolveAttribution,
  assessFraud,
  hasSponsorCycle,
  ipClickVelocity,
  commissionEventToEntry,
  currencyPricingIssue,
  type Attribution,
  type AttributionPriority,
  type Click,
  type Conversion,
  type Offer,
  type Order,
  type AffiliateRelationship,
  type OnOrderContext,
  type CodeMatch,
  type FraudSignals,
} from "@affiliate/core";
import { isUniqueViolation } from "@affiliate/db";
import type { NormalizedOrderWithBuyer } from "@affiliate/integrations";
import type { AppContext } from "../context.js";
import { recordUsage } from "./entitlements.js";
import { emitAfterCommit, moneyTransaction, type PendingEvent } from "./payout-service.js";

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

const duplicateOf = (order: Order): IngestResult => ({ status: "duplicate", orderId: order.id, ledgerEntryIds: [], reason: "duplicate txn_id" });

/**
 * Public entry: the entire order→conversion→ledger→overrides write set runs in ONE
 * transaction, so a mid-pipeline failure leaves nothing behind (order without ledger,
 * override without commission, …) — on Postgres AND in memory.
 *
 * Idempotency on (merchant, txn_id) has two layers:
 *  - the transaction holds the merchant's money lock, so deliveries for one merchant are
 *    processed one at a time: the second copy of an order finds the first and reports
 *    `duplicate`. The same serialization keeps "first sale" and milestone bonuses, code
 *    usage caps and customer records from being decided twice by overlapping orders;
 *  - a unique rule on orders(merchantId, txnId), enforced by the store itself, is the
 *    backstop: if a second copy ever got past the check, its insert fails, its transaction
 *    rolls back, and it is reported as the duplicate it is.
 *
 * Webhooks are emitted after commit — never for work that was rolled back.
 */
export async function ingestNormalizedOrder(ctx: AppContext, normalized: NormalizedOrderWithBuyer): Promise<IngestResult> {
  const { merchantId, txnId } = normalized.order;
  const events: PendingEvent[] = [];
  let result: IngestResult;
  try {
    result = await moneyTransaction(ctx, merchantId, (tx) => ingestImpl(tx, normalized, events));
  } catch (err) {
    if (!isUniqueViolation(err, "orders_merchant_txn")) throw err;
    const existing = await ctx.db.orders.findOne((o) => o.merchantId === merchantId && o.txnId === txnId);
    if (!existing) throw err;
    return duplicateOf(existing);
  }
  await emitAfterCommit(ctx, events);
  return result;
}

/** Runs inside the transaction: `ctx.db` IS the transaction handle. */
async function ingestImpl(ctx: AppContext, normalized: NormalizedOrderWithBuyer, events: PendingEvent[]): Promise<IngestResult> {
  const { db, clock } = ctx;
  const now = clock.now();
  const incoming = normalized.order;

  // Idempotency: dedup on (merchant, txn_id) — Section 6.
  const existing = await db.orders.findOne((o) => o.merchantId === incoming.merchantId && o.txnId === incoming.txnId);
  if (existing) return duplicateOf(existing);

  // Resolve / persist the customer for mining + new-customer logic.
  const order = await persistCustomerAndOrder(ctx, normalized);

  // Assemble attribution inputs.
  const offers = await db.offers.find((o) => o.merchantId === order.merchantId);
  const offersById = new Map(offers.map((o) => [o.id, o]));
  const programs = await db.programs.find((p) => p.merchantId === order.merchantId);
  const programsById = new Map(programs.map((p) => [p.id, p]));
  const claimedClick = normalized.clickId ? await db.clicks.get(normalized.clickId) : null;
  // A click id is only a claim: it has to be one of THIS merchant's clicks.
  const postbackClick = claimedClick && claimedClick.merchantId === order.merchantId ? claimedClick : null;
  const candidateClicks = await recentClicks(ctx, order);
  const relationships = await db.relationships.find((r) => r.merchantId === order.merchantId);
  const matchedCodes = await matchCodes(ctx, order, relationships);
  const lookupRelationship = makeRelationshipLookup(relationships, offersById);
  const inactiveAffiliates = await inactiveAffiliateIds(ctx, [
    ...(postbackClick ? [postbackClick.affiliateId] : []),
    ...candidateClicks.map((c) => c.affiliateId),
    ...matchedCodes.map((m) => m.relationship.affiliateId),
  ]);

  const { attribution, reason } = resolveAttribution({
    order,
    clickIdFromPostback: normalized.clickId ?? null,
    postbackClick,
    candidateClicks,
    matchedCodes,
    offersById,
    lookupRelationship,
    isAffiliateActive: (affiliateId) => !inactiveAffiliates.has(affiliateId),
    // Link-vs-code precedence is a PROGRAM setting. It used to be read from the program
    // of the merchant's first offer, whichever program the sale belonged to.
    priority: "last_touch",
    priorityByProgram: new Map<string, AttributionPriority>(programs.map((p) => [p.id, p.attributionPriority ?? "last_touch"])),
    now,
  });

  if (!attribution) {
    events.push({ merchantId: order.merchantId, type: "order.unattributed", payload: { orderId: order.id } });
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
  const fraud = await assessOrderFraud(ctx, order, attribution, relationship, postbackClick, offer, normalized.customerEmailHash ?? null);

  // The offer's amounts are in ITS currency and there is no FX. An order in another
  // currency is priced only when the offer is a plain percentage; otherwise nothing is
  // paid (a USD flat fee used to go out as that many yen) and a human decides.
  const currencyIssue = fraud.decision === "reject" ? null : currencyPricingIssue(order, offer);

  const conversion: Conversion = {
    id: newId("conv"),
    merchantId: order.merchantId,
    clickId: attribution.clickId,
    orderId: order.id,
    affiliateId: attribution.affiliateId,
    offerId: attribution.offerId, // route reversals to the right engine
    codeId: attribution.codeId,
    amountCents: order.amountCents,
    currency: order.currency,
    status: fraud.decision === "reject" ? "rejected" : "pending",
    reviewStatus: fraud.decision === "review" || currencyIssue ? "flagged" : "none",
    flagReason: currencyIssue ? `not priced: ${currencyIssue}` : null,
    ts: now.toISOString(),
  };
  await db.conversions.insert(conversion);

  if (fraud.decision === "reject") {
    events.push({ merchantId: order.merchantId, type: "conversion.rejected", payload: { conversionId: conversion.id, reasons: fraud.reasons } });
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
  const ledgerEntryIds: string[] = [];
  const autoApprove = ctx.config.autoApproveConversions && fraud.decision === "approve" && !currencyIssue;
  if (!currencyIssue) {
    const onOrderCtx = await assembleOnOrderContext(ctx, { order, offer, attribution, relationship, relationships, conversionId: conversion.id, now });
    const engine = ctx.engines.get(offer.engine);
    const commissionEvents = engine.onOrder(onOrderCtx);

    // ---- Write to the append-only ledger -----------------------------------
    // The hold period is the ATTRIBUTED offer's program's (it was the first offer's).
    const holdDays = programsById.get(offer.programId)?.holdDays ?? ctx.config.defaultHoldDays;
    const availableAt = new Date(now.getTime() + holdDays * 86_400_000);

    for (const event of commissionEvents) {
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
  }

  if (autoApprove) await db.conversions.update(conversion.id, { status: "approved" });

  // Increment code usage if a code was used.
  if (attribution.codeId) {
    const code = await db.codes.get(attribution.codeId);
    if (code) await db.codes.update(code.id, { usageCount: code.usageCount + 1 });
  }

  await recordUsage(ctx, order.merchantId, "conversion", 1, conversion.id);
  events.push({
    merchantId: order.merchantId,
    type: "conversion.created",
    payload: {
      conversionId: conversion.id,
      affiliateId: attribution.affiliateId,
      amountCents: order.amountCents,
      mechanism: attribution.mechanism,
      ...(currencyIssue ? { unpriced: currencyIssue } : {}),
    },
  });

  const notes = [currencyIssue ? `not priced: ${currencyIssue}` : null, fraud.decision === "review" || currencyIssue ? "flagged for review" : null].filter(Boolean);
  return {
    status: "attributed",
    orderId: order.id,
    conversionId: conversion.id,
    attribution,
    ledgerEntryIds,
    reason: reason + (notes.length ? ` (${notes.join(" — ")})` : ""),
    fraud,
  };
}

// ---- helpers ----------------------------------------------------------------

async function persistCustomerAndOrder(ctx: AppContext, normalized: NormalizedOrderWithBuyer): Promise<Order> {
  const { db, clock } = ctx;
  const order = { ...normalized.order };
  const emailHash = normalized.customerEmailHash ?? null;
  if (normalized.customerRef) {
    let customer = await db.customers.findOne(
      (c) => c.merchantId === order.merchantId && c.externalCustomerId === normalized.customerRef,
    );
    if (!customer) {
      customer = {
        id: newId("cust"),
        merchantId: order.merchantId,
        externalCustomerId: normalized.customerRef,
        emailHash, // was always null, so the self-referral check could never fire
        country: order.country,
        firstSeenAt: clock.now().toISOString(),
      };
      await db.customers.insert(customer);
    } else if (emailHash && customer.emailHash !== emailHash) {
      await db.customers.update(customer.id, { emailHash });
    }
    order.customerId = customer.id;
  }
  return db.orders.insert(order);
}

async function recentClicks(ctx: AppContext, order: Order): Promise<Click[]> {
  // Last-click fallback must be scoped to THIS customer's clicks, never the whole
  // merchant — crediting an unrelated customer's order to the merchant's most
  // recent click is wrong attribution. We only have a reliable customer→click link
  // when the click recorded the same customer ref, so scope to that. If there is
  // no customer linkage, there is no safe fallback: attribution then relies on the
  // deterministic click_id (carried through the funnel) or the code used at
  // checkout — both of which are unambiguous.
  if (!order.customerId) return [];
  const customer = await ctx.db.customers.get(order.customerId);
  const ref = customer?.externalCustomerId;
  if (!ref) return [];
  const orderTs = new Date(order.ts).getTime();
  const clicks = await ctx.db.clicks.find(
    (c) => c.merchantId === order.merchantId && (c.sub1 === ref || c.sub2 === ref || c.sub3 === ref || c.sub4 === ref || c.sub5 === ref),
  );
  return clicks.filter((c) => new Date(c.ts).getTime() <= orderTs).slice(-50);
}

async function matchCodes(ctx: AppContext, order: Order, relationships: AffiliateRelationship[]): Promise<CodeMatch[]> {
  if (order.couponCodes.length === 0) return [];
  const out: CodeMatch[] = [];
  for (const codeStr of order.couponCodes) {
    const code = await ctx.db.codes.findOne((c) => c.merchantId === order.merchantId && c.code === codeStr);
    if (!code) continue;
    // A code is the affiliate's, not a program's: use a relationship that can earn if there is one.
    const theirs = relationships.filter((r) => r.affiliateId === code.affiliateId);
    const relationship = theirs.find((r) => r.status === "active") ?? theirs[0];
    if (relationship) out.push({ code, relationship });
  }
  return out;
}

/** Resolve the relationship for a click's affiliate + offer: the one in that offer's program. */
function makeRelationshipLookup(
  relationships: AffiliateRelationship[],
  offersById: Map<string, Offer>,
): (affiliateId: string, offerId: string) => AffiliateRelationship | null {
  const byAffiliateAndProgram = new Map<string, AffiliateRelationship>();
  for (const r of relationships) byAffiliateAndProgram.set(`${r.affiliateId}:${r.programId}`, r);
  return (affiliateId, offerId) => {
    const offer = offersById.get(offerId);
    if (!offer) return null;
    return byAffiliateAndProgram.get(`${affiliateId}:${offer.programId}`) ?? null;
  };
}

/** Which of these affiliates are paused or banned (the affiliate's own, global status). */
async function inactiveAffiliateIds(ctx: AppContext, affiliateIds: string[]): Promise<Set<string>> {
  const inactive = new Set<string>();
  for (const id of new Set(affiliateIds)) {
    const affiliate = await ctx.db.affiliates.get(id);
    if (affiliate && affiliate.status !== "active") inactive.add(id);
  }
  return inactive;
}

async function assembleOnOrderContext(
  ctx: AppContext,
  args: {
    order: Order;
    offer: Offer;
    attribution: Attribution;
    relationship: AffiliateRelationship;
    relationships: AffiliateRelationship[];
    conversionId: string;
    now: Date;
  },
): Promise<OnOrderContext> {
  const { db } = ctx;
  const { order, offer, attribution, relationship, relationships, conversionId, now } = args;

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

  // Bonuses of this offer the affiliate already holds. A refund can pull the count or
  // volume back under a threshold; the next sale crossing it again must not pay again.
  const bonusIds = new Set(offer.bonuses.map((b) => b.id));
  const awardedBonusIds = (
    await db.ledger.find(
      (e) => e.merchantId === order.merchantId && e.affiliateId === relationship.affiliateId && e.type === "bonus" && e.status !== "reversed",
    )
  )
    .map((e) => e.metadata?.["bonusId"])
    .filter((id): id is string => typeof id === "string" && bonusIds.has(id));

  // Sponsor relationship (for two-tier override eligibility), guarding cycles.
  let sponsorRelationship: AffiliateRelationship | null = null;
  if (relationship.sponsorAffiliateId) {
    const byAffiliate = new Map(relationships.map((r) => [r.affiliateId, r]));
    const cyclic = hasSponsorCycle(
      relationship.affiliateId,
      (id) => byAffiliate.get(id)?.sponsorAffiliateId ?? null,
    );
    if (!cyclic) {
      sponsorRelationship =
        relationships.find((r) => r.affiliateId === relationship.sponsorAffiliateId && r.programId === offer.programId) ?? null;
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
    awardedBonusIds,
    now,
  };
}

async function assessOrderFraud(
  ctx: AppContext,
  order: Order,
  attribution: Attribution,
  relationship: AffiliateRelationship,
  click: Click | null,
  offer: Offer,
  buyerEmailHash: string | null,
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

  // Real self-referral: the converting affiliate is the buyer. Compare the affiliate's
  // email hash with the buyer's — from this order when the feed carried the email, else
  // from what an earlier order recorded for the same customer.
  let isSelfReferral = false;
  const customer = order.customerId ? await ctx.db.customers.get(order.customerId) : null;
  const buyerHash = buyerEmailHash ?? customer?.emailHash ?? null;
  if (buyerHash) {
    const affiliate = await ctx.db.affiliates.get(attribution.affiliateId);
    if (affiliate?.primaryEmail) {
      isSelfReferral = buyerHash === sha256Hex(affiliate.primaryEmail.trim().toLowerCase());
    }
  }

  // IP velocity over a WINDOW (last hour), not all history.
  const windowMs = 60 * 60 * 1000;
  const ipClickCountInWindow = click?.ip ? ipClickVelocity(allClicks, click.ip, windowMs, ctx.clock.now()) : 0;

  const reviewRule = offer.rules.find((r) => r.kind === "manual_review_over_cents");
  // A threshold in the offer's currency says nothing about an amount in another one.
  const sameCurrency = order.currency.toUpperCase() === offer.currency.toUpperCase();

  const signals: FraudSignals = {
    ipClickCountInWindow,
    ipIsDatacenter: false, // requires an IP-intelligence provider (not configured)
    clickToConversionSeconds,
    affiliateReversalRate: reversalRate,
    isSelfReferral,
    isCircularSponsorship: isCircular,
    amountCents: order.amountCents,
    manualReviewOverCents: reviewRule && reviewRule.kind === "manual_review_over_cents" && sameCurrency ? reviewRule.value : null,
  };
  return assessFraud(signals);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
