import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * AUDIT-2026-10 M7: money configuration was validated on create only. PATCH /offers/:id
 * accepted `payoutValue: 20` (a $100 sale wrote a $2,000 approved commission); tiers,
 * bonuses, overridePolicy and rules were `z.any()`; a relationship's negotiated rate was
 * unbounded.
 */
let app: FastifyInstance;
let token: string;
let merchantId: string;
let programId: string;
let offerId: string;
let affiliateId: string;
let relationshipId: string;

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-merchant-id": merchantId };
  const res = await app.inject({ method: method as any, url, headers, payload: body as any });
  const json = res.body ? JSON.parse(res.body) : {};
  return { status: res.statusCode, data: json.data ?? json, error: json.error?.message as string | undefined };
}

async function saleLedger(txnId: string): Promise<string[]> {
  const click = (await call("POST", "/track/click", { code: `${affiliateId}.${offerId}` })).data;
  const r = (await call("POST", "/track/test-postback", { txnId, amountCents: 10_000, currency: "USD", clickId: click.clickId })).data.result;
  return (await call("GET", `/conversions/${r.conversionId}`)).data.ledger.map((e: any) => `${e.type}:${e.amountCents}:${e.status}`);
}

beforeAll(async () => {
  app = await buildApp();
  const s = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email: "cfg@demo.test", password: "supersecret", name: "C", merchantName: "ConfigCo" } });
  const sd = JSON.parse(s.body).data;
  token = sd.token;
  merchantId = sd.merchant.id;
  programId = (await call("POST", "/programs", { name: "P", approvalMode: "auto", holdDays: 0, defaultCurrency: "EUR" })).data.id;
  offerId = (await call("POST", `/programs/${programId}/offers`, { name: "20%", payoutType: "percentage", payoutValue: 0.2, currency: "USD" })).data.id;
  const aff = (await call("POST", "/affiliates", { email: "s@demo.test", name: "S", role: "seller", programId })).data;
  affiliateId = aff.affiliateId;
  relationshipId = aff.id;
});

describe("offer updates are validated like offer creation", () => {
  it("rejects a percentage above 100% on PATCH, and the stored offer is unchanged", async () => {
    const patch = await call("PATCH", `/offers/${offerId}`, { payoutValue: 20 });
    expect(patch.status).toBe(400);
    expect(patch.error).toMatch(/payoutValue/);
    expect(await saleLedger("m7-1")).toEqual(["commission:2000:approved"]); // $20 on $100 — was $2,000
  });

  it("checks the value against the type it will be stored with", async () => {
    expect((await call("PATCH", `/offers/${offerId}`, { payoutType: "flat" })).status).toBe(400); // 0.2 is not whole cents
    expect((await call("PATCH", `/offers/${offerId}`, { payoutType: "flat", payoutValue: 500.5 })).status).toBe(400);
    expect((await call("PATCH", `/offers/${offerId}`, { payoutValue: -1 })).status).toBe(400);
    expect((await call("PATCH", `/offers/${offerId}`, { payoutValue: 0 })).status).toBe(400); // a 0% offer pays nothing: refuse it
    const ok = await call("PATCH", `/offers/${offerId}`, { payoutValue: 0.25, windowDays: 45 });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ payoutValue: 0.25, windowDays: 45, payoutType: "percentage" });
    expect((await call("PATCH", `/offers/${offerId}`, { payoutValue: 0.2, status: "paused" })).data.status).toBe("paused");
    expect((await call("PATCH", `/offers/${offerId}`, { status: "active" })).status).toBe(200);
  });

  it("rejects tiers, bonuses, overrides and rules that are not well-formed money configuration", async () => {
    const bad: Record<string, unknown>[] = [
      { tiers: [{ minVolumeCents: 0, rate: 15 }] },
      { tiers: [{ minVolumeCents: -1, rate: 0.2 }] },
      { tiers: [{ minVolumeCents: 10.5, rate: 0.2 }] },
      { tiers: [{ rate: 0.2 }] },
      { tiers: "none" },
      { bonuses: [{ triggerType: "first_sale", threshold: 1, amountCents: -500 }] },
      { bonuses: [{ triggerType: "first_sale", threshold: 1, amountCents: 99.5 }] },
      { bonuses: [{ triggerType: "whenever", threshold: 1, amountCents: 500 }] },
      { bonuses: [{ id: "b", triggerType: "first_sale", threshold: 1, amountCents: 500 }, { id: "b", triggerType: "conversion_count", threshold: 5, amountCents: 500 }] },
      { overridePolicy: { structure: "percentage", value: 10, trigger: "per_sale" } },
      { overridePolicy: { structure: "flat", value: 2.5, trigger: "per_sale" } },
      { overridePolicy: { structure: "flat", value: 250, trigger: "per_sale", maxDepth: 5 } },
      { overridePolicy: "yes" },
      { rules: [{ kind: "max_commission_cents", value: -1 }] },
      { rules: [{ kind: "category_rate", category: "widgets", rate: 3 }] },
      { rules: [{ kind: "time_boost", rate: 5, startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-02-01T00:00:00Z" }] },
      { rules: [{ kind: "time_boost", rate: 0.4, startsAt: "2026-02-01T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" }] },
      { rules: [{ kind: "commissionable_basis", basis: "whatever" }] },
      { rules: [{ kind: "pay_me_double" }] },
      { rules: [{ kind: "geo_block", countries: ["United States"] }] },
      { currency: "DOLLARS" },
    ];
    for (const patch of bad) {
      expect((await call("PATCH", `/offers/${offerId}`, patch)).status, `PATCH ${JSON.stringify(patch)}`).toBe(400);
      expect((await call("POST", `/programs/${programId}/offers`, { name: "x", payoutType: "percentage", payoutValue: 0.1, ...patch })).status, `POST ${JSON.stringify(patch)}`).toBe(400);
    }
    expect(await saleLedger("m7-2")).toEqual(["commission:2000:approved"]); // nothing of the above was stored
  });

  it("accepts well-formed configuration, assigns the ids, and binds it to the offer", async () => {
    const res = await call("PATCH", `/offers/${offerId}`, {
      tiers: [{ minVolumeCents: 500_000, rate: 0.25 }],
      bonuses: [{ triggerType: "conversion_count", threshold: 10, amountCents: 5_000 }, { id: "keep-me", triggerType: "lifetime_volume", threshold: 1_000_000, amountCents: 10_000 }],
      overridePolicy: { id: "op1", offerId: "someone-elses-offer", structure: "percentage", value: 0.1, trigger: "per_sale" },
      rules: [
        { kind: "commissionable_basis", basis: "net_of_tax_shipping" },
        { kind: "geo_block", countries: ["kp"] },
        { kind: "time_boost", rate: 0.3, startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-02-01T00:00:00Z" },
        { kind: "manual_review_over_cents", value: 5_000_000 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.tiers).toEqual([{ id: expect.stringMatching(/^tier_/), offerId, minVolumeCents: 500_000, rate: 0.25 }]);
    expect(res.data.bonuses.map((b: any) => b.id)).toEqual([expect.stringMatching(/^bonus_/), "keep-me"]);
    expect(res.data.bonuses.every((b: any) => b.offerId === offerId)).toBe(true);
    expect(res.data.overridePolicy).toEqual({ id: "op1", offerId, structure: "percentage", value: 0.1, trigger: "per_sale", maxDepth: 1 });
    expect(res.data.rules[1]).toEqual({ kind: "geo_block", countries: ["KP"] });
    expect((await call("PATCH", `/offers/${offerId}`, { overridePolicy: null, tiers: [], bonuses: [], rules: [] })).data).toMatchObject({ overridePolicy: null, tiers: [], bonuses: [], rules: [] });
  });

  it("an offer created without a currency takes the program's, not USD", async () => {
    const created = await call("POST", `/programs/${programId}/offers`, { name: "eur offer", payoutType: "flat", payoutValue: 500 });
    expect(created.status).toBe(201);
    expect(created.data.currency).toBe("EUR");
    expect((await call("POST", `/programs/${programId}/offers`, { name: "explicit", payoutType: "flat", payoutValue: 500, currency: "gbp" })).data.currency).toBe("GBP");
  });
});

describe("negotiated relationship terms are bounded", () => {
  it("rejects a rate above 100%, a negative rate and a fractional flat amount", async () => {
    for (const commissionTerms of [{ rate: 5 }, { rate: -0.1 }, { rate: 1.01 }, { flatAmountCents: 99.5 }, { flatAmountCents: -1 }, { rate: "high" }]) {
      const res = await call("PATCH", `/affiliates/${relationshipId}`, { commissionTerms });
      expect(res.status, JSON.stringify(commissionTerms)).toBe(400);
    }
    expect(await saleLedger("m7-3")).toEqual(["commission:2000:approved"]); // was commission:50000 with rate 5
  });

  it("accepts a real VIP rate and clearing the terms", async () => {
    const vip = await call("PATCH", `/affiliates/${relationshipId}`, { commissionTerms: { rate: 0.35, note: "VIP" } });
    expect(vip.status).toBe(200);
    expect(vip.data.commissionTerms).toEqual({ rate: 0.35, note: "VIP" });
    expect(await saleLedger("m7-4")).toEqual(["commission:3500:approved"]);
    expect((await call("PATCH", `/affiliates/${relationshipId}`, { commissionTerms: null })).data.commissionTerms).toBeNull();
  });
});
