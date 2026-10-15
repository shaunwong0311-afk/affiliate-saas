import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * The manual-payout contract over HTTP (AUDIT-2026-10 "Contracts shared between fix
 * streams", item 1): `awaiting_payment`, the export route, mark-paid / mark-failed, and
 * the cancel route for a draft (M13). Money never passes through the platform.
 */
let app: FastifyInstance;
let token: string;
let viewerToken: string;
let merchantId: string;
let programId: string;
let offerId: string;
const affiliates: Record<string, string> = {};

async function call(method: string, url: string, body?: unknown, opts: { token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${opts.token ?? token}`, "x-merchant-id": merchantId };
  const res = await app.inject({ method: method as any, url, headers, payload: body as any });
  const isJson = String(res.headers["content-type"] ?? "").includes("application/json");
  const json = isJson && res.body ? JSON.parse(res.body) : {};
  return { status: res.statusCode, data: json.data ?? json, error: json.error?.message as string | undefined, text: res.body, headers: res.headers };
}

async function sell(name: string, txnId: string, amountCents: number) {
  const click = (await call("POST", "/track/click", { code: `${affiliates[name]}.${offerId}` })).data;
  await call("POST", "/track/test-postback", { txnId, amountCents, currency: "USD", clickId: click.clickId });
}

beforeAll(async () => {
  app = await buildApp();
  const s = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email: "payouts@demo.test", password: "supersecret", name: "P", merchantName: "PayoutCo" } });
  const sd = JSON.parse(s.body).data;
  token = sd.token;
  merchantId = sd.merchant.id;

  const prog = (await call("POST", "/programs", { name: "P", approvalMode: "auto", holdDays: 0 })).data;
  programId = prog.id;
  offerId = (await call("POST", `/programs/${prog.id}/offers`, { name: "20%", payoutType: "percentage", payoutValue: 0.2 })).data.id;
  for (const [name, method, accountRef] of [
    ["pat", "paypal", "pat-pay@demo.test"],
    ["wes", "wise", "wes-wise@demo.test"],
    ["mo", "mock", "acct_mo"],
  ] as const) {
    const aff = (await call("POST", "/affiliates", { email: `${name}@demo.test`, name: `${name} seller`, role: "seller", programId: prog.id })).data;
    affiliates[name] = aff.affiliateId;
    await call("POST", `/affiliates/${aff.affiliateId}/tax-document`, { formType: "W-9" });
    await call("POST", `/affiliates/${aff.affiliateId}/payout-account`, { rail: method, accountRef, currency: "USD" });
  }

  // A read-only team member, to check the role gates.
  // Invites are accepted with the single-use token (returned outside production), not a bare email.
  const invited = (await call("POST", `/merchants/${merchantId}/users`, { email: "viewer@demo.test", name: "V", role: "viewer" })).data;
  const accepted = await app.inject({ method: "POST", url: "/auth/accept-invite", headers: { "content-type": "application/json" }, payload: { token: invited.devInviteToken, password: "supersecret" } });
  viewerToken = JSON.parse(accepted.body).data.token;

  await sell("pat", "o-pat", 10_000);
  await sell("wes", "o-wes", 20_000);
  await sell("mo", "o-mo", 30_000);
});

describe("manual payout flow over HTTP", () => {
  let batchId: string;
  const payoutOf = (list: any[], name: string) => list.find((p) => p.affiliateId === affiliates[name]);

  it("creates a draft batch with totals, and reports the reserved money in balances", async () => {
    const created = await call("POST", "/payouts/batches", { currency: "USD", minPayoutCents: 1 });
    expect(created.status).toBe(201);
    batchId = created.data.batch.id;
    expect(created.data.batch).toMatchObject({ status: "draft", payoutCount: 3, totalCents: 12_000, approvedAt: null });
    expect(created.data.batch.createdAt).toBeTruthy();
    expect(payoutOf(created.data.payouts, "pat")).toMatchObject({ status: "pending", amountCents: 2_000, rail: "paypal", affiliateName: "pat seller" });

    const balances = (await call("GET", "/ledger/balances")).data;
    const pat = balances.find((b: any) => b.affiliateId === affiliates["pat"]).balances[0];
    expect(pat).toMatchObject({ availableCents: 0, processingCents: 2_000, paidCents: 0 }); // reserved money is visible, not vanished
    const money = (await call("GET", "/reports/money-ops")).data;
    expect(money).toMatchObject({ unpaidLiabilityCents: 12_000, inPayoutsCents: 12_000, payableNowCents: 0 });
  });

  it("a draft cannot be exported, and the export needs the approve capability", async () => {
    expect((await call("GET", `/payouts/batches/${batchId}/export?format=csv`)).status).toBe(409);
    expect((await call("GET", `/payouts/batches/${batchId}/export?format=csv`, undefined, { token: viewerToken })).status).toBe(403);
    expect((await call("GET", `/payouts/batches/${batchId}/export?format=xlsx`)).status).toBe(400);
    expect((await call("GET", `/payouts/batches/batch_nope/export?format=csv`)).status).toBe(404);
  });

  it("approval sends nothing for manual methods: those payouts wait as awaiting_payment", async () => {
    const approved = await call("POST", `/payouts/batches/${batchId}/approve`, {});
    expect(approved.status).toBe(200);
    expect(payoutOf(approved.data, "pat")).toMatchObject({ status: "awaiting_payment", mode: "manual", accountRef: "pat-pay@demo.test" });
    expect(payoutOf(approved.data, "wes")).toMatchObject({ status: "awaiting_payment", mode: "manual" });
    expect(payoutOf(approved.data, "mo")).toMatchObject({ status: "paid", mode: "automated" }); // the dev-only mock rail

    const batch = (await call("GET", `/payouts/batches/${batchId}`)).data;
    expect(batch).toMatchObject({ status: "processing", payoutCount: 3, totalCents: 12_000 });
    expect(batch.approvedAt).toBeTruthy();
    expect((await call("GET", "/payouts?status=awaiting_payment")).data).toHaveLength(2);
    expect((await call("POST", `/payouts/batches/${batchId}/approve`, {})).status).toBe(409);
    expect((await call("POST", `/payouts/batches/${batchId}/cancel`, {})).status).toBe(409);
  });

  it("exports text/csv in the three layouts", async () => {
    const generic = await call("GET", `/payouts/batches/${batchId}/export?format=csv`);
    expect(generic.status).toBe(200);
    expect(String(generic.headers["content-type"])).toMatch(/^text\/csv/);
    expect(String(generic.headers["content-disposition"])).toBe(`attachment; filename="payouts-${batchId}-csv.csv"`);
    expect(generic.headers["x-payouts-included"]).toBe("2");
    const lines = generic.text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("affiliate,email,method,account_reference,amount,currency,payout_id");
    expect(lines.slice(1).map((l) => l.split(",").slice(0, 6).join(","))).toEqual(
      expect.arrayContaining(["pat seller,pat@demo.test,paypal,pat-pay@demo.test,20.00,USD", "wes seller,wes@demo.test,wise,wes-wise@demo.test,40.00,USD"]),
    );

    const paypal = await call("GET", `/payouts/batches/${batchId}/export?format=paypal`);
    expect(paypal.text).toMatch(/^pat-pay@demo\.test,20\.00,USD,[0-9a-f]{30},Affiliate commission payout pay_[0-9a-f-]{36}\r\n$/);
    expect(paypal.headers["x-payouts-omitted"]).toBe("1");

    const wise = await call("GET", `/payouts/batches/${batchId}/export?format=wise`);
    expect(wise.text.split("\r\n")[0]).toBe("name,recipientEmail,paymentReference,receiverType,amountCurrency,amount,sourceCurrency,targetCurrency,IBAN");
    expect(wise.text.split("\r\n")[1]).toMatch(/^wes seller,wes-wise@demo\.test,[0-9a-f]{10},,target,40\.00,USD,USD,$/);

    // The default format is the generic CSV.
    expect((await call("GET", `/payouts/batches/${batchId}/export`)).text).toBe(generic.text);
  });

  it("mark-paid and mark-failed need the approve capability, a valid body, and an awaiting payout", async () => {
    const list = (await call("GET", "/payouts")).data;
    const pat = payoutOf(list, "pat");
    const wes = payoutOf(list, "wes");
    const mo = payoutOf(list, "mo");

    expect((await call("POST", `/payouts/${pat.id}/mark-paid`, {}, { token: viewerToken })).status).toBe(403);
    expect((await call("POST", `/payouts/${pat.id}/mark-failed`, { reason: "x" }, { token: viewerToken })).status).toBe(403);
    expect((await call("POST", `/payouts/${wes.id}/mark-failed`, {})).status).toBe(400); // a reason is required
    expect((await call("POST", `/payouts/${wes.id}/mark-failed`, { reason: "   " })).status).toBe(400);
    expect((await call("POST", `/payouts/${mo.id}/mark-paid`, {})).status).toBe(409); // already paid by the mock
    expect((await call("POST", `/payouts/pay_nope/mark-paid`, {})).status).toBe(404);

    const paid = await call("POST", `/payouts/${pat.id}/mark-paid`, { reference: "PAYPAL-BATCH-7" });
    expect(paid.status).toBe(200);
    expect(paid.data).toMatchObject({ status: "paid", reference: "PAYPAL-BATCH-7", affiliateName: "pat seller" });
    expect((await call("POST", `/payouts/${pat.id}/mark-paid`, {})).status).toBe(409);

    const failed = await call("POST", `/payouts/${wes.id}/mark-failed`, { reason: "recipient account not found" });
    expect(failed.status).toBe(200);
    expect(failed.data).toMatchObject({ status: "failed", failureReason: "recipient account not found" });

    expect((await call("GET", `/payouts/batches/${batchId}`)).data.status).toBe("failed");
    const balances = (await call("GET", "/ledger/balances")).data;
    const balanceOf = (name: string) => balances.find((b: any) => b.affiliateId === affiliates[name]).balances[0];
    expect(balanceOf("pat")).toMatchObject({ paidCents: 2_000, processingCents: 0 });
    expect(balanceOf("wes")).toMatchObject({ paidCents: 0, availableCents: 4_000, processingCents: 0 }); // payable again
    expect((await call("GET", `/payouts/batches/${batchId}/export?format=csv`)).status).toBe(409); // nothing left awaiting payment
  });

  it("a failed manual payout can be retried: it waits for the merchant again, for what is payable now", async () => {
    const wes = payoutOf((await call("GET", "/payouts?status=failed")).data, "wes");
    const retried = await call("POST", `/payouts/${wes.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.data).toMatchObject({ status: "awaiting_payment", amountCents: 4_000, attempt: 2 });
    expect((await call("POST", `/payouts/${wes.id}/mark-paid`, {})).data.status).toBe("paid");
    expect((await call("GET", `/payouts/batches/${batchId}`)).data.status).toBe("paid");
    expect((await call("GET", "/reports/money-ops")).data).toMatchObject({ unpaidLiabilityCents: 0, paidCents: 12_000 });
  });

  it("a draft batch can be cancelled over HTTP, by someone who may approve", async () => {
    await sell("pat", "o-pat-2", 5_000);
    const draft = (await call("POST", "/payouts/batches", { currency: "USD", minPayoutCents: 1 })).data;
    expect(draft.payouts).toHaveLength(1);
    expect((await call("POST", `/payouts/batches/${draft.batch.id}/cancel`, {}, { token: viewerToken })).status).toBe(403);
    const cancelled = await call("POST", `/payouts/batches/${draft.batch.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.data).toMatchObject({ status: "cancelled", payoutCount: 0, totalCents: 0 });
    expect((await call("GET", "/payouts?status=cancelled")).data).toHaveLength(1);
    const line = (await call("GET", "/payouts/payable?minPayoutCents=1")).data.find((l: any) => l.affiliateId === affiliates["pat"]);
    expect(line).toMatchObject({ availableCents: 1_000, eligible: true, processingCents: 0 });
  });

  it("a uniqueness rule the store enforces reaches the client as 409, not 500", async () => {
    // The same affiliate linked to the same program twice: the route has no check of its
    // own, so this is the store's rule (relationships are unique per affiliate + program).
    const again = await call("POST", "/affiliates", { email: "PAT@demo.test", name: "pat again", role: "seller", programId });
    expect(again.status).toBe(409);
    expect(again.error).toMatch(/relationships\(affiliateId, programId\)/);
    // A second code with the same text for this merchant is refused by the route's own check — and by the rule behind it.
    const first = await call("POST", "/codes", { affiliateId: affiliates["pat"], kind: "discount", code: "PAT10" });
    expect(first.status).toBe(201);
    expect((await call("POST", "/codes", { affiliateId: affiliates["wes"], kind: "discount", code: "PAT10" })).status).toBe(409);
  });

  it("an adjustment must be a non-zero whole number of cents for an affiliate of this merchant", async () => {
    const base = { affiliateId: affiliates["pat"], currency: "USD", reason: "correction" };
    expect((await call("POST", "/payouts/adjustments", { ...base, amountCents: 0 })).status).toBe(400);
    expect((await call("POST", "/payouts/adjustments", { ...base, amountCents: 10.5 })).status).toBe(400);
    expect((await call("POST", "/payouts/adjustments", { ...base, amountCents: 100, currency: "US$" })).status).toBe(400);
    expect((await call("POST", "/payouts/adjustments", { ...base, affiliateId: "aff_someone_else", amountCents: 100 })).status).toBe(404);
    expect((await call("POST", "/payouts/adjustments", { ...base, amountCents: -400 })).status).toBe(201);
    const line = (await call("GET", "/payouts/payable?minPayoutCents=1")).data.find((l: any) => l.affiliateId === affiliates["pat"]);
    expect(line.availableCents).toBe(600);
  });
});
