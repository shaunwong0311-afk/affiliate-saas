import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/** Regression tests for the security/correctness review findings. */
let app: FastifyInstance;
let token: string;
let merchantId: string;
let postbackSecret: string;

async function call(method: string, url: string, body?: unknown, opts: { token?: string; rawBody?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  const auth = opts.token ?? token;
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (merchantId) headers["x-merchant-id"] = merchantId;
  const payload = opts.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
  const res = await app.inject({ method: method as any, url, headers, payload });
  return { status: res.statusCode, raw: res.body, data: res.body ? JSON.parse(res.body).data ?? JSON.parse(res.body) : {} };
}

beforeAll(async () => {
  app = await buildApp();
  const s = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email: "sec@demo.test", password: "supersecret", name: "Sec", merchantName: "SecCo" } });
  const sd = JSON.parse(s.body).data;
  token = sd.token;
  merchantId = sd.merchant.id;
  postbackSecret = (await call("GET", `/merchants/${merchantId}/postback-secret`)).data.postbackSecret;
});

describe("secret responses", () => {
  it("does not return postbackSecret in the general merchant read", async () => {
    const m = await call("GET", `/merchants/${merchantId}`);
    expect(m.data.postbackSecret).toBeUndefined();
    expect(m.data.id).toBe(merchantId);
  });
  it("does not return passwordHash from /auth/me", async () => {
    const me = await call("GET", "/auth/me");
    expect(me.data.user.passwordHash).toBeUndefined();
  });
});

describe("affiliate magic-link (not email-only)", () => {
  it("the old email-only token route is gone", async () => {
    const r = await call("POST", "/auth/affiliate/token", { email: "x@y.com" });
    expect(r.status).toBe(404);
  });
  it("issues a session only after verifying a magic token, and the magic token is not itself a session", async () => {
    const prog = (await call("POST", "/programs", { name: "P", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 0 })).data;
    await call("POST", "/affiliates", { email: "creator@demo.test", name: "Creator", role: "seller", programId: prog.id });

    const link = await call("POST", "/auth/affiliate/request-link", { email: "creator@demo.test" });
    expect(link.data.devToken).toBeTruthy();

    // The magic token must NOT work as a session bearer.
    const meWithMagic = await call("GET", "/auth/me", undefined, { token: link.data.devToken });
    expect(meWithMagic.status).toBe(401);

    // Exchanging it yields a real portal session.
    const verified = await call("POST", "/auth/affiliate/verify", { token: link.data.devToken });
    expect(verified.data.token).toBeTruthy();
    const me = await call("GET", "/auth/me", undefined, { token: verified.data.token });
    expect(me.data.kind).toBe("affiliate");
  });
});

describe("attribution stores the offer", () => {
  it("a conversion records the offerId that priced it", async () => {
    const prog = (await call("POST", "/programs", { name: "AttrProg", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 0 })).data;
    const offer = (await call("POST", `/programs/${prog.id}/offers`, { name: "o", payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null })).data;
    const aff = (await call("POST", "/affiliates", { email: "attr@demo.test", name: "Attr", role: "seller", programId: prog.id })).data;
    const affiliateId = aff.affiliateId ?? aff.affiliate?.id;
    const click = (await call("POST", "/track/click", { code: `${affiliateId}.${offer.id}` })).data;
    const conv = (await call("POST", "/track/test-postback", { txnId: "attr1", amountCents: 5000, currency: "USD", clickId: click.clickId })).data;
    const detail = await call("GET", `/conversions/${conv.result.conversionId}`);
    expect(detail.data.offerId).toBe(offer.id);
  });
});

describe("offer validation", () => {
  it("rejects a percentage payoutValue > 1", async () => {
    const prog = (await call("POST", "/programs", { name: "VP", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 0 })).data;
    const bad = await call("POST", `/programs/${prog.id}/offers`, { name: "bad", payoutType: "percentage", payoutValue: 20, currency: "USD", windowDays: 30 });
    expect(bad.status).toBe(400);
  });
});

describe("signed reply webhook", () => {
  it("rejects an unsigned reply and accepts a correctly signed one", async () => {
    await call("POST", "/recruitment/automation/start", {});
    await call("POST", "/recruitment/source", { limit: 8 });
    const prospects = (await call("GET", "/recruitment/prospects?limit=100")).data.items as Array<{ id: string; email: string | null }>;
    const withEmail = prospects.find((p) => p.email);
    expect(withEmail).toBeTruthy();

    const payload = JSON.stringify({ from: withEmail!.email, subject: "re", text: "Sounds interesting, tell me more about the commission." });

    // Unsigned → 401.
    const unsigned = await call("POST", `/recruitment/reply-webhook/${merchantId}`, undefined, { token: "", rawBody: payload });
    expect(unsigned.status).toBe(401);

    // Correctly signed → accepted.
    const sig = createHmac("sha256", postbackSecret).update(payload, "utf8").digest("hex");
    const signed = await call("POST", `/recruitment/reply-webhook/${merchantId}`, undefined, { token: "", rawBody: payload, headers: { "x-vantage-signature": sig } });
    expect(signed.status).toBe(200);
    expect(signed.data.matched).toBe(true);
  });
});

describe("webhook SSRF guard", () => {
  it("rejects an internal webhook target", async () => {
    const r = await call("POST", "/developer/webhooks", { url: "http://169.254.169.254/latest/meta-data", events: ["conversion.created"] });
    expect(r.status).toBe(400);
  });
});
