import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "@affiliate/db";
import { buildApp } from "../src/app.js";
import { signJwt } from "../src/auth/jwt.js";

/**
 * AUDIT-2026-10 S5 — impersonation used to mint an ordinary affiliate session. An affiliate
 * is a GLOBAL identity and the portal filtered by affiliate only, so merchant A's owner could
 * read a shared affiliate's ledger, earnings and payouts with merchant B, and add a payout
 * account as them. A support session now carries the impersonating merchant + user, reads
 * only that merchant's slice, cannot write, expires quickly, and is attributed in the audit log.
 */
const AFFILIATE_ID = "aff_shared";
const AFFILIATE_EMAIL = "shared-creator@example.com";

let app: FastifyInstance;
let db: Database;
let a: { token: string; merchantId: string; userId: string };
let b: { token: string; merchantId: string; userId: string };

async function signup(email: string, merchantName: string) {
  const res = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email, password: "supersecret", name: email, merchantName } });
  const data = JSON.parse(res.body).data;
  return { token: data.token as string, merchantId: data.merchant.id as string, userId: data.user.id as string };
}

async function call(method: string, url: string, token: string, body?: unknown, merchantId?: string) {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(merchantId ? { "x-merchant-id": merchantId } : {}) },
    payload: body as never,
  });
  const json = res.body ? JSON.parse(res.body) : {};
  return { status: res.statusCode, data: json.data ?? json };
}

/** One affiliate working with BOTH merchants: a relationship, an offer, a click, a conversion, earnings, a payout and a code at each. */
async function seedSharedAffiliate() {
  const now = new Date().toISOString();
  await db.affiliates.insert({ id: AFFILIATE_ID, name: "Shared Creator", primaryEmail: AFFILIATE_EMAIL, country: "US", audienceProfile: null, status: "active", createdAt: now });
  for (const [tag, merchantId, cents] of [["a", a.merchantId, 1000], ["b", b.merchantId, 7700]] as const) {
    await db.programs.insert({ id: `prog_${tag}`, merchantId, name: `Program ${tag}`, status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 0 });
    await db.offers.insert({ id: `off_${tag}`, merchantId, programId: `prog_${tag}`, engine: "affiliate", name: `Offer ${tag}`, payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
    await db.relationships.insert({ id: `rel_${tag}`, affiliateId: AFFILIATE_ID, merchantId, programId: `prog_${tag}`, status: "active", joinedAt: now, role: "seller", commissionTerms: null, source: "manual", ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null });
    await db.clicks.insert({ clickId: `click_${tag}`, merchantId, affiliateId: AFFILIATE_ID, offerId: `off_${tag}`, ts: now, ip: null, ua: null, landingUrl: null });
    await db.conversions.insert({ id: `conv_${tag}`, merchantId, clickId: `click_${tag}`, orderId: `ord_${tag}`, affiliateId: AFFILIATE_ID, offerId: `off_${tag}`, codeId: null, amountCents: cents * 5, currency: "USD", status: "approved", reviewStatus: "none", ts: now });
    await db.ledger.insert({ id: `led_${tag}`, merchantId, affiliateId: AFFILIATE_ID, conversionId: `conv_${tag}`, type: "commission", amountCents: cents, currency: "USD", status: "approved", availableAt: null, ts: now, reversesEntryId: null, metadata: {} });
    await db.payouts.insert({ id: `pay_${tag}`, batchId: null, merchantId, affiliateId: AFFILIATE_ID, amountCents: cents, currency: "USD", method: "paypal", status: "paid", failureReason: null, ts: now });
    await db.codes.insert({ id: `code_${tag}`, affiliateId: AFFILIATE_ID, merchantId, code: `SHARED${tag.toUpperCase()}`, kind: "referral", discountValue: null, usageCap: null, usageCount: 0, expiresAt: null });
    await db.creatives.insert({ id: `cre_${tag}`, merchantId, programId: `prog_${tag}`, type: "banner", name: `Banner ${tag}`, assetRef: "r2://x", metadata: {}, status: "active" });
  }
}

async function impersonate(as = a): Promise<{ token: string; raw: Record<string, unknown> }> {
  const res = await call("POST", `/admin/impersonate/${AFFILIATE_ID}`, as.token, {}, as.merchantId);
  expect(res.status).toBe(200);
  return { token: res.data.token as string, raw: res.data };
}

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, any>;

beforeEach(async () => {
  app = await buildApp();
  db = app.appContext.db;
  a = await signup("owner-a@imp.test", "Merchant A");
  b = await signup("owner-b@imp.test", "Merchant B");
  await seedSharedAffiliate();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("impersonated portal session (S5)", () => {
  it("reads are scoped to the impersonating merchant — nothing from the affiliate's other merchants", async () => {
    const { token } = await impersonate(a);

    const statement = (await call("GET", "/portal/statement", token)).data;
    expect(statement.entries.map((e: { id: string }) => e.id)).toEqual(["led_a"]);
    expect(statement.balances).toEqual([expect.objectContaining({ currency: "USD", availableCents: 1000 })]);

    expect((await call("GET", "/portal/stats", token)).data).toEqual({ clicks: 1, conversions: 1, earningsCents: 1000 });
    expect((await call("GET", "/portal/payouts", token)).data.map((p: { id: string }) => p.id)).toEqual(["pay_a"]);
    expect((await call("GET", "/portal/relationships", token)).data.map((r: { id: string }) => r.id)).toEqual(["rel_a"]);
    expect((await call("GET", "/portal/links", token)).data.map((l: { offerId: string }) => l.offerId)).toEqual(["off_a"]);
    expect((await call("GET", "/portal/codes", token)).data.map((c: { id: string }) => c.id)).toEqual(["code_a"]);
    expect((await call("GET", "/portal/creatives", token)).data.map((c: { id: string }) => c.id)).toEqual(["cre_a"]);

    // Nothing in any response mentions merchant B.
    for (const path of ["statement", "stats", "payouts", "relationships", "links", "codes", "creatives"]) {
      const res = await app.inject({ method: "GET", url: `/portal/${path}`, headers: { authorization: `Bearer ${token}` } });
      expect(res.body, path).not.toContain(b.merchantId);
      expect(res.body, path).not.toMatch(/_b\b/); // no row seeded for merchant B (led_b, pay_b, rel_b, …)
    }
  });

  it("the affiliate's OWN session still spans every merchant they work with", async () => {
    const link = await app.inject({ method: "POST", url: "/auth/affiliate/request-link", headers: { "content-type": "application/json" }, payload: { email: AFFILIATE_EMAIL } });
    const verified = await app.inject({ method: "POST", url: "/auth/affiliate/verify", headers: { "content-type": "application/json" }, payload: { token: JSON.parse(link.body).data.devToken } });
    const own = JSON.parse(verified.body).data.token as string;

    expect((await call("GET", "/portal/stats", own)).data).toEqual({ clicks: 2, conversions: 2, earningsCents: 8700 });
    expect((await call("GET", "/portal/statement", own)).data.entries).toHaveLength(2);
    expect((await call("GET", "/portal/payouts", own)).data).toHaveLength(2);
    expect((await call("GET", "/portal/relationships", own)).data).toHaveLength(2);
    // …and can still change their own account.
    expect((await call("POST", "/portal/payout-account", own, { rail: "paypal", accountRef: "me@example.com", currency: "usd" })).status).toBe(201);
  });

  it("writes are refused: no payout account, tax document or agreement acceptance as the affiliate", async () => {
    const { token } = await impersonate(a);
    await db.agreements.insert({ id: "agr_a", merchantId: a.merchantId, programId: "prog_a", version: "1", bodyRef: "r2://terms", effectiveAt: new Date().toISOString() });

    expect((await call("POST", "/portal/payout-account", token, { rail: "paypal", accountRef: "attacker@evil.test", currency: "USD" })).status).toBe(403);
    expect((await call("POST", "/portal/tax-document", token, { formType: "W-9" })).status).toBe(403);
    expect((await call("POST", "/portal/agreements/agr_a/accept", token, { relationshipId: "rel_a" })).status).toBe(403);

    expect(await db.payoutAccounts.count(() => true)).toBe(0);
    expect(await db.taxDocuments.count(() => true)).toBe(0);
    expect(await db.agreementAcceptances.count(() => true)).toBe(0);
  });

  it("the token names the merchant and the user, and expires within minutes", async () => {
    const { token, raw } = await impersonate(a);
    const claims = claimsOf(token);
    expect(claims.imp).toEqual({ merchantId: a.merchantId, userId: a.userId });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);
    expect(raw).toMatchObject({ readOnly: true, merchantId: a.merchantId, expiresInSeconds: claims.exp - claims.iat });

    // /auth/me says whose view this is, so the portal can show a read-only banner.
    const me = await call("GET", "/auth/me", token);
    expect(me.data.impersonation).toEqual({ merchantId: a.merchantId, userId: a.userId });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect((await call("GET", "/portal/stats", token)).status).toBe(401);
  });

  it("the audit row records who impersonated whom", async () => {
    await impersonate(a);
    const row = await db.auditLogs.findOne((l) => l.action === "affiliate.impersonated");
    expect(row).toMatchObject({ merchantId: a.merchantId, actorId: a.userId, subjectType: "affiliate", subjectId: AFFILIATE_ID });
  });

  it("only a merchant the affiliate works with can impersonate them", async () => {
    const outsider = await signup("owner-c@imp.test", "Merchant C");
    expect((await call("POST", `/admin/impersonate/${AFFILIATE_ID}`, outsider.token, {}, outsider.merchantId)).status).toBe(404);
  });

  it("a session whose impersonation claim is malformed is not a session at all (never an unscoped one)", async () => {
    for (const imp of [{}, { merchantId: a.merchantId }, { merchantId: "", userId: a.userId }, null, "yes"]) {
      const forged = signJwt({ sub: AFFILIATE_ID, kind: "affiliate", email: AFFILIATE_EMAIL, imp: imp as never }, app.appContext.config.jwtSecret, 900);
      expect((await call("GET", "/portal/statement", forged)).status, JSON.stringify(imp)).toBe(401);
    }
  });
});
