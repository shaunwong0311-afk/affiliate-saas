import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * Payout details recorded by a MERCHANT are that merchant's alone (AUDIT-2026-10, security
 * stream follow-up). An affiliate is a global identity shared across tenants: before this,
 * merchant B could attach a payout account and a tax form to a shared affiliate and merchant
 * A's payable list would pick them up — B deciding where A's money goes.
 */
let app: FastifyInstance;
const tenants: Record<string, { token: string; merchantId: string; programId: string }> = {};
let affiliateId: string;

async function call(who: string, method: string, url: string, body?: unknown) {
  const t = tenants[who]!;
  const headers = { "content-type": "application/json", authorization: `Bearer ${t.token}`, "x-merchant-id": t.merchantId };
  const res = await app.inject({ method: method as any, url, headers, payload: body as any });
  const json = res.body ? JSON.parse(res.body) : {};
  return { status: res.statusCode, data: json.data ?? json };
}

async function payableFor(who: string) {
  const lines = (await call(who, "GET", "/payouts/payable?minPayoutCents=0")).data as Array<Record<string, unknown>>;
  return lines.find((l) => l.affiliateId === affiliateId)!;
}

beforeAll(async () => {
  app = await buildApp();
  for (const who of ["A", "B"]) {
    const s = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email: `owner-${who}@demo.test`, password: "supersecret", name: who, merchantName: `Merchant ${who}` } });
    const sd = JSON.parse(s.body).data;
    tenants[who] = { token: sd.token, merchantId: sd.merchant.id, programId: "" };
    tenants[who]!.programId = (await call(who, "POST", "/programs", { name: "P", approvalMode: "auto", holdDays: 0 })).data.id;
    // The SAME creator works with both merchants — one global affiliate, two relationships.
    const aff = (await call(who, "POST", "/affiliates", { email: "shared@creator.test", name: "Shared Creator", role: "seller", programId: tenants[who]!.programId })).data;
    affiliateId = aff.affiliateId;
    // An approved, available commission owed by this merchant.
    await app.appContext.db.ledger.insert({
      id: `le_${who}`, merchantId: tenants[who]!.merchantId, affiliateId, conversionId: null, type: "commission", amountCents: 5000,
      currency: "USD", status: "approved", availableAt: null, ts: new Date().toISOString(), reversesEntryId: null, metadata: {},
    });
  }
});

describe("merchant-recorded payout details stay with that merchant", () => {
  it("both merchants reach the same global affiliate", async () => {
    const a = (await call("A", "GET", "/affiliates")).data.items.map((r: { affiliateId: string }) => r.affiliateId);
    const b = (await call("B", "GET", "/affiliates")).data.items.map((r: { affiliateId: string }) => r.affiliateId);
    expect(a).toContain(affiliateId);
    expect(b).toContain(affiliateId);
  });

  it("an account and tax form recorded by merchant B are not used for merchant A's payouts", async () => {
    expect((await call("B", "POST", `/affiliates/${affiliateId}/payout-account`, { rail: "paypal", accountRef: "attacker@evil.test", currency: "USD" })).status).toBe(201);
    expect((await call("B", "POST", `/affiliates/${affiliateId}/tax-document`, { formType: "W-9" })).status).toBe(201);

    const forB = await payableFor("B");
    expect(forB.payoutAccountRef).toBe("attacker@evil.test");
    expect(forB.taxOnFile).toBe(true);
    expect(forB.eligible).toBe(true);

    const forA = await payableFor("A");
    expect(forA.payoutAccountRef).toBeNull();
    expect(forA.taxOnFile).toBe(false);
    expect(forA.eligible).toBe(false);

    // And A cannot be made to pay it: a batch for A skips the affiliate.
    const batch = (await call("A", "POST", "/payouts/batches", { currency: "USD", minPayoutCents: 0 })).data;
    expect(batch.payouts).toHaveLength(0);
  });

  it("details the affiliate set themselves apply to every merchant, and win over a merchant-recorded account", async () => {
    const { db } = app.appContext;
    await db.payoutAccounts.insert({ id: "pa_own", affiliateId, rail: "paypal", accountRef: "shared@creator.test", status: "active", currency: "USD" });
    await db.taxDocuments.insert({ id: "tax_own", affiliateId, rail: null, formType: "W-9", status: "on_file", collectedAt: new Date().toISOString() });

    const forA = await payableFor("A");
    expect(forA.payoutAccountRef).toBe("shared@creator.test");
    expect(forA.eligible).toBe(true);
    expect((await payableFor("B")).payoutAccountRef).toBe("shared@creator.test");
  });
});
