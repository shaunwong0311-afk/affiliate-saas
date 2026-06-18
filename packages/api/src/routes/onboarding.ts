import type { RouteModule } from "./helpers.js";
import { ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";

/**
 * Guided launch checklist (Section 9). Read-only views that help a merchant
 * understand what is left to do before going live, and a summary of their
 * current footprint. Everything is scoped to the authenticated merchant.
 */
export const onboardingRoutes: RouteModule = (app, ctx) => {
  // ---- Launch checklist -----------------------------------------------------
  app.get("/onboarding/checklist", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");

    const integrations = await ctx.db.integrations.find((i) => i.merchantId === merchantId);
    const relationships = await ctx.db.relationships.find((r) => r.merchantId === merchantId);
    const affiliateIds = new Set(relationships.map((r) => r.affiliateId));

    const storeKinds = ["shopify", "woocommerce", "stripe", "s2s"];
    const storeConnected = integrations.some((i) => storeKinds.includes(i.kind));

    const hasStripeIntegration = integrations.some((i) => i.kind === "stripe");
    const payoutAccount = await ctx.db.payoutAccounts.findOne((a) => affiliateIds.has(a.affiliateId));
    const payoutConfigured = payoutAccount !== null || hasStripeIntegration;

    const mailbox = await ctx.db.mailboxes.findOne((m) => m.merchantId === merchantId);
    const program = await ctx.db.programs.findOne((p) => p.merchantId === merchantId);
    const offer = await ctx.db.offers.findOne((o) => o.merchantId === merchantId);
    const agreement = await ctx.db.agreements.findOne((a) => a.merchantId === merchantId);
    const creative = await ctx.db.creatives.findOne((c) => c.merchantId === merchantId);
    const conversion = await ctx.db.conversions.findOne((c) => c.merchantId === merchantId);
    const campaign = await ctx.db.campaigns.findOne((c) => c.merchantId === merchantId);

    const items: Array<{ key: string; label: string; done: boolean; hint: string }> = [
      {
        key: "storeConnected",
        label: "Connect your store",
        done: storeConnected,
        hint: "Connect Shopify, WooCommerce, Stripe, or server-to-server tracking.",
      },
      {
        key: "payoutConfigured",
        label: "Configure payouts",
        done: payoutConfigured,
        hint: "Connect Stripe or have an affiliate add a payout account.",
      },
      {
        key: "mailboxConnected",
        label: "Connect a sending mailbox",
        done: mailbox !== null,
        hint: "Connect a mailbox to run recruitment outreach.",
      },
      {
        key: "programCreated",
        label: "Create a program",
        done: program !== null,
        hint: "Set up at least one affiliate program.",
      },
      {
        key: "offerCreated",
        label: "Create an offer",
        done: offer !== null,
        hint: "Define commission terms with an offer.",
      },
      {
        key: "agreementAdded",
        label: "Add an agreement",
        done: agreement !== null,
        hint: "Publish the terms affiliates must accept.",
      },
      {
        key: "creativesUploaded",
        label: "Upload creatives",
        done: creative !== null,
        hint: "Give affiliates banners, swipe copy, or product feeds.",
      },
      {
        key: "testConversionRun",
        label: "Run a test conversion",
        done: conversion !== null,
        hint: "Fire a test postback to confirm tracking works end to end.",
      },
      {
        key: "firstAffiliate",
        label: "Recruit your first affiliate",
        done: relationships.length > 0,
        hint: "Invite or approve at least one affiliate.",
      },
      {
        key: "campaignReady",
        label: "Prepare an outreach campaign",
        done: campaign !== null,
        hint: "Draft a recruitment campaign to find new affiliates.",
      },
    ];

    const completed = items.filter((i) => i.done).length;
    const total = items.length;
    const percentComplete = total === 0 ? 0 : Math.round((completed / total) * 100);

    return ok(reply, { items, completed, total, percentComplete });
  });

  // ---- Summary --------------------------------------------------------------
  app.get("/onboarding/summary", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant || merchant.id !== merchantId) throw notFound("merchant");

    const counts = {
      programs: await ctx.db.programs.count((p) => p.merchantId === merchantId),
      offers: await ctx.db.offers.count((o) => o.merchantId === merchantId),
      affiliates: await ctx.db.relationships.count((r) => r.merchantId === merchantId),
      conversions: await ctx.db.conversions.count((c) => c.merchantId === merchantId),
    };

    return ok(reply, { merchant, counts });
  });
};
