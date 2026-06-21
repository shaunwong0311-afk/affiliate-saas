import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * Regression for the double-pay defect: two batches must not both pay the same
 * balance, and a batch must not be approvable twice.
 */
let app: FastifyInstance;
let token: string;
let merchantId: string;

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-merchant-id": merchantId };
  const res = await app.inject({ method: method as any, url, headers, payload: body as any });
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body).data ?? JSON.parse(res.body) : {} };
}

beforeAll(async () => {
  app = await buildApp();
  const s = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email: "p@demo.test", password: "supersecret", name: "P", merchantName: "Payco" } });
  const sd = JSON.parse(s.body).data;
  token = sd.token;
  merchantId = sd.merchant.id;

  const prog = (await call("POST", "/programs", { name: "P", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 0 })).data;
  const offer = (await call("POST", `/programs/${prog.id}/offers`, { name: "20%", payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null })).data;
  const aff = (await call("POST", "/affiliates", { email: "seller@demo.test", name: "Seller", role: "seller", programId: prog.id })).data;
  const affiliateId = aff.affiliateId ?? aff.affiliate?.id;
  await call("POST", `/affiliates/${affiliateId}/tax-document`, { formType: "W-9" });
  await call("POST", `/affiliates/${affiliateId}/payout-account`, { rail: "mock", accountRef: "acct_seller", currency: "USD" });

  // One $100 sale → $20 commission, immediately available (holdDays 0, auto-approve).
  const click = (await call("POST", "/track/click", { code: `${affiliateId}.${offer.id}` })).data;
  await call("POST", "/track/test-postback", { txnId: "o1", amountCents: 10_000, currency: "USD", clickId: click.clickId });
});

describe("payout double-spend protection", () => {
  it("reserves the balance so a second batch is empty, and pays exactly once", async () => {
    const payableBefore = await call("GET", "/payouts/payable?minPayoutCents=1");
    const line = payableBefore.data.find((l: any) => l.eligible);
    expect(line.availableCents).toBe(2000);

    // First batch claims the balance.
    const batch1 = await call("POST", "/payouts/batches", { currency: "USD", minPayoutCents: 1 });
    expect(batch1.data.payouts.length).toBe(1);

    // The balance is now reserved — a second batch finds nothing payable.
    const payableAfter = await call("GET", "/payouts/payable?minPayoutCents=1");
    expect(payableAfter.data.filter((l: any) => l.eligible && l.availableCents > 0).length).toBe(0);
    const batch2 = await call("POST", "/payouts/batches", { currency: "USD", minPayoutCents: 1 });
    expect(batch2.data.payouts.length).toBe(0);

    // Disburse batch 1.
    const disb = await call("POST", `/payouts/batches/${batch1.data.batch.id}/approve`, {});
    expect(disb.status).toBe(200);
    expect(disb.data.every((p: any) => p.status === "paid")).toBe(true);

    // Approving the same batch again is rejected (idempotency guard).
    const again = await call("POST", `/payouts/batches/${batch1.data.batch.id}/approve`, {});
    expect(again.status).toBe(409);

    // Exactly $20 paid in total across all payouts — never $40.
    const allPayouts = await call("GET", "/payouts?status=paid");
    const totalPaid = allPayouts.data.reduce((s: number, p: any) => s + p.amountCents, 0);
    expect(totalPaid).toBe(2000);
  });
});
