import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Offer, Program } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { badRequest, notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO-4217 code");

const programSchema = z.object({
  name: z.string().min(1),
  approvalMode: z.enum(["auto", "manual", "invite_only"]).default("manual"),
  defaultCurrency: currencyCode.default("USD"),
  termsUrl: z.string().url().nullish(),
  attributionPriority: z.enum(["link_first", "code_first", "last_touch"]).default("last_touch"),
  holdDays: z.number().int().min(0).max(180).default(14),
});

// ---- Offer money configuration ------------------------------------------------
// Everything that decides how much is paid is validated here, on create AND on update.
// It used to be `z.any()` (and unchecked on PATCH), so `payoutValue: 20`, a tier with
// `rate: 15` or a negative bonus were stored as given and paid as given.

/** A share of the commissionable base: 0.2 = 20%. Never more than the whole. */
const share = z.number().gt(0, "must be greater than 0").lte(1, "must be a decimal no greater than 1 — 0.2 means 20%");
const cents = z.number().int("must be a whole number of cents").min(0).max(Number.MAX_SAFE_INTEGER);
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date-time");
const stringList = z.array(z.string().min(1)).min(1).max(1000);
const countryList = z.array(z.string().regex(/^[A-Za-z]{2}$/, "must be a 2-letter country code").transform((c) => c.toUpperCase())).min(1).max(250);

const ruleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commissionable_basis"), basis: z.enum(["gross", "net_of_discount", "net_of_tax_shipping"]) }),
  z.object({ kind: z.literal("first_order_only"), value: z.literal(true) }),
  z.object({ kind: z.literal("new_customer_only"), value: z.literal(true) }),
  z.object({ kind: z.literal("min_order_cents"), value: cents }),
  z.object({ kind: z.literal("max_commission_cents"), value: cents }),
  z.object({ kind: z.literal("sku_include"), skus: stringList }),
  z.object({ kind: z.literal("sku_exclude"), skus: stringList }),
  z.object({ kind: z.literal("category_rate"), category: z.string().min(1), rate: z.number().min(0).max(1) }),
  z.object({ kind: z.literal("geo_allow"), countries: countryList }),
  z.object({ kind: z.literal("geo_block"), countries: countryList }),
  z.object({ kind: z.literal("excluded_coupons"), codes: stringList }),
  z.object({ kind: z.literal("time_boost"), rate: share, startsAt: isoDate, endsAt: isoDate }),
  z.object({ kind: z.literal("recurring"), value: z.literal(true) }),
  z.object({ kind: z.literal("manual_review_over_cents"), value: cents }),
]);

const rulesSchema = z
  .array(ruleSchema)
  .max(100)
  .superRefine((rules, issue) => {
    rules.forEach((rule, index) => {
      if (rule.kind === "time_boost" && Date.parse(rule.startsAt) >= Date.parse(rule.endsAt)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: [index, "endsAt"], message: "must be after startsAt" });
      }
    });
  });

const tierSchema = z.object({ id: z.string().min(1).optional(), minVolumeCents: cents, rate: share });
const bonusSchema = z.object({
  id: z.string().min(1).optional(),
  triggerType: z.enum(["lifetime_volume", "conversion_count", "first_sale"]),
  threshold: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  amountCents: cents.min(1),
});
const overridePolicySchema = z
  .object({
    id: z.string().min(1).optional(),
    structure: z.enum(["flat", "percentage"]),
    value: z.number(),
    trigger: z.enum(["first_sale", "per_sale"]),
    maxDepth: z.literal(1).default(1), // two-tier cap — hard constraint
  })
  .superRefine((policy, issue) => {
    const okValue =
      policy.structure === "percentage"
        ? policy.value > 0 && policy.value <= 1
        : Number.isSafeInteger(policy.value) && policy.value >= 1;
    if (!okValue) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: policy.structure === "percentage" ? "must be a decimal in (0, 1] — 0.1 means 10%" : "must be a whole number of cents, at least 1",
      });
    }
  });

const uniqueIds = (what: string) => (items: Array<{ id?: string }>, issue: z.RefinementCtx) => {
  const ids = items.map((i) => i.id).filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length) issue.addIssue({ code: z.ZodIssueCode.custom, message: `${what} ids must be distinct` });
};

const offerBaseSchema = z.object({
  name: z.string().min(1),
  // The MLM engine is a deliberate stub (it produces no commissions). Reject
  // creating MLM offers rather than silently generating zero commissions.
  engine: z.literal("affiliate").default("affiliate"),
  payoutType: z.enum(["percentage", "flat"]),
  payoutValue: z.number().min(0),
  /** The currency of every amount in the offer. Defaults to the program's. */
  currency: currencyCode.optional(),
  windowDays: z.number().int().min(1).max(365).default(30),
  rules: rulesSchema.default([]),
  tiers: z.array(tierSchema).max(50).superRefine(uniqueIds("tier")).default([]),
  bonuses: z.array(bonusSchema).max(50).superRefine(uniqueIds("bonus")).default([]),
  overridePolicy: overridePolicySchema.nullish(),
});

/** The rule that ties the payout value to its type: a share for percentage, whole cents for flat. */
function payoutValueProblem(payoutType: "percentage" | "flat", payoutValue: number): string | null {
  if (payoutType === "percentage") {
    return payoutValue > 0 && payoutValue <= 1 ? null : "percentage payoutValue must be a decimal in (0, 1] — e.g. 0.2 for 20%";
  }
  return Number.isSafeInteger(payoutValue) && payoutValue >= 0 ? null : "flat payoutValue must be an integer number of cents";
}

const offerSchema = offerBaseSchema.superRefine((o, issue) => {
  const problem = payoutValueProblem(o.payoutType, o.payoutValue);
  if (problem) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["payoutValue"], message: problem });
});

const offerPatchSchema = offerBaseSchema.partial().extend({ status: z.enum(["active", "paused"]).optional() });

/** Ids are the platform's to assign: a bonus id is how "already earned" is recognised. */
function ownedConfig(
  offerId: string,
  body: { tiers?: z.infer<typeof tierSchema>[]; bonuses?: z.infer<typeof bonusSchema>[]; overridePolicy?: z.infer<typeof overridePolicySchema> | null },
): Partial<Pick<Offer, "tiers" | "bonuses" | "overridePolicy">> {
  const out: Partial<Pick<Offer, "tiers" | "bonuses" | "overridePolicy">> = {};
  if (body.tiers !== undefined) out.tiers = body.tiers.map((t) => ({ id: t.id ?? newId("tier"), offerId, minVolumeCents: t.minVolumeCents, rate: t.rate }));
  if (body.bonuses !== undefined) {
    out.bonuses = body.bonuses.map((b) => ({ id: b.id ?? newId("bonus"), offerId, triggerType: b.triggerType, threshold: b.threshold, amountCents: b.amountCents }));
  }
  if (body.overridePolicy !== undefined) {
    const p = body.overridePolicy;
    out.overridePolicy = p ? { id: p.id ?? newId("op"), offerId, structure: p.structure, value: p.value, trigger: p.trigger, maxDepth: 1 } : null;
  }
  return out;
}

export const programRoutes: RouteModule = (app, ctx) => {
  app.get("/programs", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const programs = await ctx.db.programs.find((p) => p.merchantId === merchantId);
    return ok(reply, programs);
  });

  app.post("/programs", async (request, reply) => {
    const { merchantId, role } = await requireMerchant(ctx, request, "write");
    const body = parseBody(programSchema, request);
    const program: Program = {
      id: newId("prog"),
      merchantId,
      name: body.name,
      status: "draft",
      termsUrl: body.termsUrl ?? null,
      approvalMode: body.approvalMode,
      defaultCurrency: body.defaultCurrency.toUpperCase(),
      attributionPriority: body.attributionPriority,
      holdDays: body.holdDays,
    };
    await ctx.db.programs.insert(program);
    await writeAudit(ctx, { merchantId, actorId: null, action: "program.created", subjectType: "program", subjectId: program.id, metadata: { role } });
    return ok(reply, program, 201);
  });

  app.get("/programs/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const id = (request.params as { id: string }).id;
    const program = await ctx.db.programs.get(id);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const offers = await ctx.db.offers.find((o) => o.programId === id);
    return ok(reply, { ...program, offers });
  });

  app.patch("/programs/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const id = (request.params as { id: string }).id;
    const program = await ctx.db.programs.get(id);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const body = parseBody(programSchema.partial().extend({ status: z.enum(["draft", "active", "paused", "archived"]).optional() }), request);
    const patch = { ...body, ...(body.defaultCurrency ? { defaultCurrency: body.defaultCurrency.toUpperCase() } : {}) };
    const updated = await ctx.db.programs.update(id, patch as Partial<Program>);
    return ok(reply, updated);
  });

  // ---- Offers ---------------------------------------------------------------
  app.post("/programs/:id/offers", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const programId = (request.params as { id: string }).id;
    const program = await ctx.db.programs.get(programId);
    if (!program || program.merchantId !== merchantId) throw notFound("program");
    const body = parseBody(offerSchema, request);
    const id = newId("offer");
    const offer: Offer = {
      id,
      merchantId,
      programId,
      engine: body.engine,
      name: body.name,
      payoutType: body.payoutType,
      payoutValue: body.payoutValue,
      // An offer with no currency of its own is in the program's — not in USD regardless.
      currency: (body.currency ?? program.defaultCurrency).toUpperCase(),
      windowDays: body.windowDays,
      rules: body.rules,
      tiers: [],
      bonuses: [],
      overridePolicy: null,
      ...ownedConfig(id, body),
      status: "active",
    };
    await ctx.db.offers.insert(offer);
    await writeAudit(ctx, { merchantId, actorId: null, action: "offer.created", subjectType: "offer", subjectId: offer.id });
    return ok(reply, offer, 201);
  });

  app.get("/programs/:id/offers", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const programId = (request.params as { id: string }).id;
    const offers = await ctx.db.offers.find((o) => o.programId === programId && o.merchantId === merchantId);
    return ok(reply, offers);
  });

  app.patch("/offers/:offerId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const offerId = (request.params as { offerId: string }).offerId;
    const offer = await ctx.db.offers.get(offerId);
    if (!offer || offer.merchantId !== merchantId) throw notFound("offer");
    const body = parseBody(offerPatchSchema, request);

    // The payout value means something only together with its type, so check the pair as it
    // will be STORED — the patch on its own passed `payoutValue: 20` straight through.
    if (body.payoutType !== undefined || body.payoutValue !== undefined) {
      const problem = payoutValueProblem(body.payoutType ?? offer.payoutType, body.payoutValue ?? offer.payoutValue);
      if (problem) throw badRequest(`validation: payoutValue ${problem}`);
    }

    const { tiers: _tiers, bonuses: _bonuses, overridePolicy: _policy, currency, ...fields } = body;
    const patch: Partial<Offer> = {
      ...fields,
      ...(currency !== undefined ? { currency: currency.toUpperCase() } : {}),
      ...ownedConfig(offerId, body),
    };
    const updated = await ctx.db.offers.update(offerId, patch);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "offer.updated",
      subjectType: "offer",
      subjectId: offerId,
      metadata: { fields: Object.keys(patch) },
    });
    return ok(reply, updated);
  });
};
