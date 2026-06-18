import { newId, newCode, type Order } from "@affiliate/core";
import type { NormalizedOrder } from "@affiliate/integrations";
import { runSourcing } from "@affiliate/recruitment";
import type { AppContext } from "../context.js";
import { hashPassword } from "../auth/jwt.js";
import { ingestNormalizedOrder } from "../services/conversion-pipeline.js";
import { reverseOrder } from "../services/reversal.js";
import { mintClickId, writeClick } from "../services/tracking.js";

/**
 * Seed a realistic demo tenant so the dashboards, ledger, payout console, and
 * recruitment queue are populated. Runs entirely through the real substrate
 * services (no shortcuts), so what you see in the UI is what the engine computed.
 */
export interface SeedResult {
  email: string;
  password: string;
  merchantId: string;
}

export async function seedDemo(ctx: AppContext): Promise<SeedResult> {
  const { db, clock } = ctx;
  const now = () => clock.now().toISOString();
  const email = "owner@demo.test";
  const password = "demo1234";

  const user = await db.users.insert({ id: newId("usr"), email, name: "Dana Owner", passwordHash: hashPassword(password), createdAt: now() });
  const merchant = await db.merchants.insert({
    id: newId("mer"),
    name: "Lumen Skincare",
    status: "active",
    niche: "skincare",
    competitors: ["glowrival.com", "dewdrop.com"],
    billingStatus: "active",
    defaultCurrency: "USD",
    postbackSecret: `whsec_${newId()}`,
    physicalAddress: "1 Market St, San Francisco, CA",
    createdAt: now(),
  });
  await db.merchantUsers.insert({ id: newId("mu"), merchantId: merchant.id, userId: user.id, email, name: user.name, role: "owner", status: "active" });
  await db.subscriptions.insert({ id: newId("sub"), merchantId: merchant.id, plan: "done_for_you", status: "active", trialEndsAt: null, renewsAt: null });
  await db.entitlements.insert({ id: newId("ent"), merchantId: merchant.id, feature: "recruitment_credits", limitValue: 500, sourcePlan: "done_for_you" });

  const program = await db.programs.insert({
    id: newId("prog"),
    merchantId: merchant.id,
    name: "Creator Program",
    status: "active",
    termsUrl: null,
    approvalMode: "auto",
    defaultCurrency: "USD",
    attributionPriority: "last_touch",
    holdDays: 0,
  });

  const offer = await db.offers.insert({
    id: newId("offer"),
    merchantId: merchant.id,
    programId: program.id,
    engine: "affiliate",
    name: "20% + tiers + recruiter override",
    payoutType: "percentage",
    payoutValue: 0.2,
    currency: "USD",
    windowDays: 30,
    rules: [{ kind: "commissionable_basis", basis: "net_of_discount" }],
    tiers: [
      { id: newId("tier"), offerId: "x", minVolumeCents: 50_000, rate: 0.25 },
      { id: newId("tier"), offerId: "x", minVolumeCents: 150_000, rate: 0.3 },
    ],
    bonuses: [{ id: newId("bonus"), offerId: "x", triggerType: "first_sale", threshold: 1, amountCents: 2_500 }],
    overridePolicy: { id: newId("op"), offerId: "x", structure: "percentage", value: 0.1, trigger: "per_sale", maxDepth: 1 },
    status: "active",
  });

  // Affiliates: a recruiter + three sellers (one sponsored by the recruiter).
  const mkAffiliate = async (name: string, mail: string) =>
    db.affiliates.insert({ id: newId("aff"), name, primaryEmail: mail, country: "US", audienceProfile: null, status: "active", createdAt: now() });

  const recruiter = await mkAffiliate("Rae Recruiter", "rae@creators.test");
  const sam = await mkAffiliate("Sam Seller", "sam@creators.test");
  const nina = await mkAffiliate("Nina Niche", "nina@creators.test");
  const otto = await mkAffiliate("Otto Outdoors", "otto@creators.test");

  const mkRel = async (affiliateId: string, role: "seller" | "recruiter" | "both", sponsor: string | null, source: string) =>
    db.relationships.insert({
      id: newId("rel"),
      affiliateId,
      merchantId: merchant.id,
      programId: program.id,
      status: "active",
      joinedAt: now(),
      role,
      commissionTerms: null,
      source,
      ownerUserId: null,
      tags: role === "recruiter" ? ["vip"] : [],
      sponsorAffiliateId: sponsor,
    });

  await mkRel(recruiter.id, "recruiter", null, "inbound");
  await mkRel(sam.id, "seller", recruiter.id, "recruitment"); // sponsored → override fires
  await mkRel(nina.id, "seller", null, "inbound");
  await mkRel(otto.id, "seller", null, "inbound");

  // A discount code for Nina (code attribution).
  const ninaCode = await db.codes.insert({
    id: newId("code"),
    affiliateId: nina.id,
    merchantId: merchant.id,
    code: "NINA15",
    kind: "discount",
    discountValue: 15,
    usageCap: null,
    usageCount: 0,
    expiresAt: null,
  });

  // Tax docs + payout accounts so the payout console shows eligible lines.
  for (const aff of [sam, nina, recruiter]) {
    await db.taxDocuments.insert({ id: newId("tax"), affiliateId: aff.id, rail: "stripe", formType: "W-9", status: "on_file", collectedAt: now() });
    await db.payoutAccounts.insert({ id: newId("pa"), affiliateId: aff.id, rail: "mock", accountRef: `acct_${aff.id.slice(-6)}`, status: "active", currency: "USD" });
  }

  // ---- Conversions through the real pipeline -------------------------------
  const baseOrder = (txn: string, amountCents: number, opts: Partial<Order> = {}): Order => ({
    id: newId("order"),
    merchantId: merchant.id,
    customerId: null,
    amountCents,
    currency: "USD",
    txnId: txn,
    ts: now(),
    lineItems: [],
    couponCodes: [],
    isNewCustomer: true,
    isRebill: false,
    subtotalCents: amountCents,
    discountCents: 0,
    taxCents: 0,
    shippingCents: 0,
    country: "US",
    ...opts,
  });

  // Sam: link-attributed sale → commission + first-sale bonus + recruiter override.
  const samClick = mintClickId();
  await writeClick(ctx, samClick, { merchantId: merchant.id, affiliateId: sam.id, offerId: offer.id, ip: "70.1.2.3", ua: "demo" });
  await ingestNormalizedOrder(ctx, { order: baseOrder("ord_sam_1", 14_000), clickId: samClick, customerRef: "cust_a" } as NormalizedOrder);

  // Nina: code-attributed sale.
  await ingestNormalizedOrder(ctx, {
    order: baseOrder("ord_nina_1", 9_000, { couponCodes: [ninaCode.code], discountCents: 1_350 }),
    clickId: null,
    customerRef: "cust_b",
  } as NormalizedOrder);

  // Otto: a larger link sale, then a refund to demonstrate the clawback cascade.
  const ottoClick = mintClickId();
  await writeClick(ctx, ottoClick, { merchantId: merchant.id, affiliateId: otto.id, offerId: offer.id, ip: "70.9.9.9", ua: "demo" });
  const ottoResult = await ingestNormalizedOrder(ctx, { order: baseOrder("ord_otto_1", 22_000), clickId: ottoClick, customerRef: "cust_c" } as NormalizedOrder);
  await reverseOrder(ctx, ottoResult.orderId, "customer refund");

  // Sam again to push toward the next volume tier.
  const samClick2 = mintClickId();
  await writeClick(ctx, samClick2, { merchantId: merchant.id, affiliateId: sam.id, offerId: offer.id, ip: "70.1.2.3", ua: "demo" });
  await ingestNormalizedOrder(ctx, { order: baseOrder("ord_sam_2", 60_000), clickId: samClick2, customerRef: "cust_d" } as NormalizedOrder);

  // ---- Recruitment: source a prospect queue --------------------------------
  await runSourcing(ctx, merchant.id, { limit: 14 });

  // A campaign so the recruitment surface has something to launch.
  await db.campaigns.insert({
    id: newId("camp"),
    merchantId: merchant.id,
    mailboxId: null,
    sendingDomainId: null,
    name: "Q3 Competitor Affiliates",
    sequence: [
      { step: 1, delayDays: 0, subject: "Partner with {{merchant}}?", body: "Hi {{name}}, {{angle}} — want to earn on {{offer}}?", kind: "initial" },
      { step: 2, delayDays: 3, subject: "Following up", body: "Just circling back, {{name}}.", kind: "follow_up" },
    ],
    sendWindow: { startHour: 9, endHour: 17, timezone: "America/Los_Angeles" },
    dailyCap: 40,
    status: "active",
  });

  return { email, password, merchantId: merchant.id };
}
