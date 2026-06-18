import { z } from "zod";
import { newId, computeBalances } from "@affiliate/core";
import type { PayoutAccount, TaxDocument, AgreementAcceptance } from "@affiliate/db";
import { linkCode } from "@affiliate/tracking-edge";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireAffiliate } from "../auth/middleware.js";
import { notFound } from "../errors.js";

export const portalRoutes: RouteModule = (app, ctx) => {
  // ---- Relationships across merchants ---------------------------------------
  app.get("/portal/relationships", async (request, reply) => {
    const me = requireAffiliate(request);
    const relationships = await ctx.db.relationships.find((r) => r.affiliateId === me);
    const withMerchant = await Promise.all(
      relationships.map(async (rel) => {
        const merchant = await ctx.db.merchants.get(rel.merchantId);
        return { ...rel, merchantName: merchant?.name ?? null };
      }),
    );
    return ok(reply, withMerchant);
  });

  // ---- Tracking links per active offer --------------------------------------
  app.get("/portal/links", async (request, reply) => {
    const me = requireAffiliate(request);
    const relationships = await ctx.db.relationships.find((r) => r.affiliateId === me && r.status === "active");
    const links: { offerId: string; offerName: string; code: string; url: string }[] = [];
    for (const rel of relationships) {
      const offers = await ctx.db.offers.find((o) => o.programId === rel.programId && o.status === "active");
      for (const offer of offers) {
        const code = linkCode(me, offer.id);
        links.push({
          offerId: offer.id,
          offerName: offer.name,
          code,
          url: ctx.config.trackingBaseUrl + "/c/" + code,
        });
      }
    }
    return ok(reply, links);
  });

  // ---- My affiliate codes ---------------------------------------------------
  app.get("/portal/codes", async (request, reply) => {
    const me = requireAffiliate(request);
    const codes = await ctx.db.codes.find((c) => c.affiliateId === me);
    return ok(reply, codes);
  });

  // ---- Aggregate stats ------------------------------------------------------
  app.get("/portal/stats", async (request, reply) => {
    const me = requireAffiliate(request);
    const clicks = await ctx.db.clicks.count((c) => c.affiliateId === me);
    const conversions = await ctx.db.conversions.count((c) => c.affiliateId === me && c.status !== "rejected");
    const entries = await ctx.db.ledger.find((e) => e.affiliateId === me && e.status !== "reversed");
    const earningsCents = entries.reduce((sum, e) => sum + e.amountCents, 0);
    return ok(reply, { clicks, conversions, earningsCents });
  });

  // ---- Statement: ledger + derived balances ---------------------------------
  app.get("/portal/statement", async (request, reply) => {
    const me = requireAffiliate(request);
    const entries = await ctx.db.ledger.find((e) => e.affiliateId === me);
    const balances = Array.from(computeBalances(entries, ctx.clock.now()).values());
    return ok(reply, { entries, balances });
  });

  // ---- Payouts --------------------------------------------------------------
  app.get("/portal/payouts", async (request, reply) => {
    const me = requireAffiliate(request);
    const payouts = await ctx.db.payouts.find((p) => p.affiliateId === me);
    return ok(reply, payouts);
  });

  // ---- Tax document on file -------------------------------------------------
  app.post("/portal/tax-document", async (request, reply) => {
    const me = requireAffiliate(request);
    const body = parseBody(
      z.object({ formType: z.enum(["W-9", "W-8BEN", "W-8BEN-E", "other"]) }),
      request,
    );
    const doc: TaxDocument = {
      id: newId("tax"),
      affiliateId: me,
      rail: null,
      formType: body.formType,
      status: "on_file",
      collectedAt: ctx.clock.now().toISOString(),
    };
    await ctx.db.taxDocuments.insert(doc);
    return ok(reply, doc, 201);
  });

  // ---- Payout account -------------------------------------------------------
  app.post("/portal/payout-account", async (request, reply) => {
    const me = requireAffiliate(request);
    const body = parseBody(
      z.object({ rail: z.string().min(1), accountRef: z.string().min(1), currency: z.string().length(3) }),
      request,
    );
    const account: PayoutAccount = {
      id: newId("pa"),
      affiliateId: me,
      rail: body.rail,
      accountRef: body.accountRef,
      status: "active",
      currency: body.currency.toUpperCase(),
    };
    await ctx.db.payoutAccounts.insert(account);
    return ok(reply, account, 201);
  });

  // ---- Agreement acceptance -------------------------------------------------
  app.post("/portal/agreements/:agreementId/accept", async (request, reply) => {
    const me = requireAffiliate(request);
    const agreementId = (request.params as { agreementId: string }).agreementId;
    const body = parseBody(z.object({ relationshipId: z.string().min(1) }), request);
    // The relationship must belong to the calling affiliate, and the agreement must
    // exist and target that relationship's program — never trust the body alone.
    const relationship = await ctx.db.relationships.findOne((r) => r.id === body.relationshipId && r.affiliateId === me);
    if (!relationship) throw notFound("relationship");
    const agreement = await ctx.db.agreements.get(agreementId);
    if (!agreement || agreement.programId !== relationship.programId) throw notFound("agreement");
    const acceptance: AgreementAcceptance = {
      id: newId("acc"),
      agreementId,
      affiliateId: me, // derived from the verified principal + relationship
      relationshipId: relationship.id,
      acceptedAt: ctx.clock.now().toISOString(),
      ip: request.ip,
    };
    await ctx.db.agreementAcceptances.insert(acceptance);
    return ok(reply, acceptance, 201);
  });

  // ---- Creatives for programs I'm in ----------------------------------------
  app.get("/portal/creatives", async (request, reply) => {
    const me = requireAffiliate(request);
    const relationships = await ctx.db.relationships.find((r) => r.affiliateId === me);
    const programIds = new Set(relationships.map((r) => r.programId));
    const creatives = await ctx.db.creatives.find((c) => programIds.has(c.programId));
    return ok(reply, creatives);
  });
};
