import { computeBalances, fixedClock, newId, signPostback, type Offer, type Order, type PostbackPayload } from "@affiliate/core";
import type { Database } from "@affiliate/db";
import { PayoutRailRegistry, type PayoutRail, type PayoutRequest, type PayoutResult } from "@affiliate/integrations";
import { createContext, type AppContext } from "../src/context.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { ingestNormalizedOrder, type IngestResult } from "../src/services/conversion-pipeline.js";

/**
 * A small merchant to run money-path tests against: one program (no hold, auto-approve),
 * one 20% offer, one seller with a tax form and a payout account. Built directly on the
 * store so a test controls every detail; the services under test are the real ones.
 */
export const SECRET = "whsec_test";

export interface WorldOptions {
  db?: Database;
  /** The seller's payout method. "mock" pays instantly (dev); anything else is manual. */
  method?: string;
  accountRef?: string;
  offer?: Partial<Offer>;
  holdDays?: number;
  rails?: PayoutRailRegistry;
  config?: Partial<AppConfig>;
  /** A wall-clock start is needed when signed postbacks are verified (5-minute window). */
  start?: Date | number | string;
}

export interface World {
  ctx: AppContext;
  db: Database;
  clock: ReturnType<typeof fixedClock>;
}

export async function world(opts: WorldOptions = {}): Promise<World> {
  const clock = fixedClock(new Date(opts.start ?? "2026-06-01T00:00:00Z"));
  const config = { ...loadConfig({}), ...opts.config };
  const ctx = createContext({ clock, config, ...(opts.db ? { db: opts.db } : {}), ...(opts.rails ? { rails: opts.rails } : {}) });
  const { db } = ctx;
  const ts = clock.now().toISOString();
  await db.merchants.insert({ id: "m1", name: "M", status: "active", niche: null, competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: SECRET, physicalAddress: null, createdAt: ts });
  await db.programs.insert({ id: "p1", merchantId: "m1", name: "P", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: opts.holdDays ?? 0 });
  await db.offers.insert({ id: "o1", merchantId: "m1", programId: "p1", engine: "affiliate", name: "20%", payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active", ...opts.offer });
  await addSeller(ctx, "a1", { method: opts.method ?? "mock", accountRef: opts.accountRef });
  return { ctx, db, clock };
}

/** Another seller in program p1 (or `programId`), with a tax form and a payout account. */
export async function addSeller(
  ctx: AppContext,
  affiliateId: string,
  opts: { method?: string | null; accountRef?: string; programId?: string; email?: string; sponsorAffiliateId?: string | null; role?: "seller" | "recruiter" | "both" } = {},
): Promise<void> {
  const { db } = ctx;
  const ts = ctx.clock.now().toISOString();
  const email = opts.email ?? `${affiliateId}@x.test`;
  await db.affiliates.insert({ id: affiliateId, name: `Affiliate ${affiliateId}`, primaryEmail: email, country: null, audienceProfile: null, status: "active", createdAt: ts });
  await db.relationships.insert({ id: `r_${affiliateId}_${opts.programId ?? "p1"}`, affiliateId, merchantId: "m1", programId: opts.programId ?? "p1", status: "active", joinedAt: ts, role: opts.role ?? "seller", commissionTerms: null, source: "manual", ownerUserId: null, tags: [], sponsorAffiliateId: opts.sponsorAffiliateId ?? null, prospectId: null });
  await db.taxDocuments.insert({ id: `t_${affiliateId}`, affiliateId, rail: null, formType: "W-9", status: "on_file", collectedAt: ts });
  if (opts.method !== null) {
    await db.payoutAccounts.insert({ id: `pa_${affiliateId}`, affiliateId, rail: opts.method ?? "mock", accountRef: opts.accountRef ?? (opts.method && opts.method !== "mock" ? email : "acct_ok"), status: "active", currency: "USD" });
  }
}

export function makeOrder(ctx: AppContext, txnId: string, amountCents: number, overrides: Partial<Order> = {}): Order {
  return {
    id: newId("order"),
    merchantId: "m1",
    customerId: null,
    amountCents,
    currency: "USD",
    txnId,
    ts: ctx.clock.now().toISOString(),
    lineItems: [],
    couponCodes: [],
    isNewCustomer: true,
    isRebill: false,
    subtotalCents: amountCents,
    discountCents: 0,
    taxCents: 0,
    shippingCents: 0,
    country: null,
    ...overrides,
  };
}

/** A link-attributed sale: records a click an hour earlier, then ingests the order. */
export async function sale(
  ctx: AppContext,
  txnId: string,
  amountCents: number,
  opts: { affiliateId?: string; offerId?: string; order?: Partial<Order>; customerRef?: string | null; customerEmailHash?: string | null } = {},
): Promise<IngestResult> {
  const clickId = `clk_${txnId}`;
  if (!(await ctx.db.clicks.get(clickId))) {
    await ctx.db.clicks.insert({ clickId, merchantId: "m1", affiliateId: opts.affiliateId ?? "a1", offerId: opts.offerId ?? "o1", ts: new Date(ctx.clock.now().getTime() - 3_600_000).toISOString(), ip: null, ua: null, landingUrl: null });
  }
  return ingestNormalizedOrder(ctx, { order: makeOrder(ctx, txnId, amountCents, opts.order), clickId, customerRef: opts.customerRef ?? null, customerEmailHash: opts.customerEmailHash ?? null });
}

/** A signed S2S postback body + headers for merchant m1 (the wall clock: signatures expire). */
export function signedPostback(overrides: Record<string, unknown> = {}): { body: Record<string, unknown>; signature: string } {
  const body = { merchantId: "m1", txnId: "t1", amountCents: 10_000, currency: "USD", clickId: null, couponCodes: [], customerRef: null, ts: Math.floor(Date.now() / 1000), ...overrides };
  let signature = "unsignable";
  try {
    signature = signPostback(body as unknown as PostbackPayload, SECRET);
  } catch {
    // a shape the signer cannot serialize — validation must reject it before the signature matters
  }
  return { body, signature };
}

/** `type:amount:status` for every ledger entry, in insertion order. */
export const ledgerOf = async (db: Database): Promise<string[]> => (await db.ledger.all()).map((e) => `${e.type}:${e.amountCents}:${e.status}`);

export const balanceOf = async (ctx: AppContext, affiliateId = "a1") =>
  computeBalances(await ctx.db.ledger.find((e) => e.affiliateId === affiliateId), ctx.clock.now()).get("USD") ?? null;

export const payoutsOf = async (db: Database): Promise<string[]> => (await db.payouts.all()).map((p) => `${p.amountCents}:${p.status}`);

/**
 * A registry in which merchant m1 has "connected" a rail called `name` — the only way an
 * automated rail can exist. The rail's behaviour is scripted by the test. `sent` holds the
 * requests the rail accepted (paid or processing); `calls()` counts every attempt.
 */
export function connectedRail(name: string, disburse: (request: PayoutRequest, call: number) => Promise<PayoutResult> | PayoutResult) {
  const sent: PayoutRequest[] = [];
  let calls = 0;
  const rail: PayoutRail = {
    rail: name,
    merchantId: "m1",
    async disburse(request) {
      calls += 1;
      const result = await disburse(request, calls);
      if (result.status !== "failed") sent.push(request);
      return result;
    },
    async verifyAccount() {
      return { ok: true };
    },
  };
  const rails = new PayoutRailRegistry({
    allowMock: true,
    credentials: async (merchantId, railName) => (merchantId === "m1" && railName === name ? { merchantId, rail: railName, secret: { apiKey: "merchant-own-key" } } : null),
  });
  rails.registerFactory(name, () => rail);
  return { rails, sent, calls: () => calls };
}

export const paid = (request: PayoutRequest): PayoutResult => ({ payoutId: request.payoutId, status: "paid", railReference: `tr_${request.idempotencyKey}`, failureReason: null });
