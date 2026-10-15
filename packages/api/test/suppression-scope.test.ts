import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { signUnsubscribeToken } from "@affiliate/core";
import type { Prospect, Suppression } from "@affiliate/db";
import { isSuppressed, suppress } from "@affiliate/recruitment";
import { buildApp } from "../src/app.js";

/**
 * AUDIT-2026-10 S2 — a tenant must not be able to suppress an address (or a whole domain,
 * e.g. gmail.com) for EVERY tenant. Every signed-up account is an admin of its own merchant,
 * so the old "admin may create a global row" rule let anyone do exactly that, and the row
 * (merchantId null) showed up in nobody's list. Now: the API creates merchant-scope rows
 * only; platform-wide rows come from the system paths (signed unsubscribe link, STOP reply);
 * and a merchant's list shows everything that blocks its own sends.
 */
const SECRET = "dev-insecure-secret-change-me";

let app: FastifyInstance;
let a: { token: string; merchantId: string };
let b: { token: string; merchantId: string };

async function call(method: string, url: string, who: { token: string; merchantId: string }, body?: unknown) {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { "content-type": "application/json", authorization: `Bearer ${who.token}`, "x-merchant-id": who.merchantId },
    payload: body as never,
  });
  const json = res.body ? JSON.parse(res.body) : {};
  return { status: res.statusCode, data: json.data ?? json };
}

async function signup(email: string, merchantName: string) {
  const res = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: { email, password: "supersecret", name: email, merchantName } });
  const data = JSON.parse(res.body).data;
  return { token: data.token as string, merchantId: data.merchant.id as string };
}

function prospect(merchantId: string, email: string): Prospect {
  const now = new Date().toISOString();
  return { id: `prosp_${merchantId}_${email}`, merchantId, source: "serp", identity: "Creator", siteUrl: null, channelUrl: null, email, state: "scored", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: now, updatedAt: now } as Prospect;
}

function clickUnsubscribe(merchantId: string, email: string) {
  const token = signUnsubscribeToken(merchantId, email, SECRET);
  return app.inject({
    method: "POST",
    url: `/track/unsubscribe?m=${merchantId}&e=${encodeURIComponent(email)}&t=${token}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "List-Unsubscribe=One-Click",
  });
}

beforeEach(async () => {
  app = await buildApp();
  a = await signup("owner-a@scope.test", "Merchant A");
  b = await signup("owner-b@scope.test", "Merchant B");
});

describe("tenants cannot create platform-wide suppressions (S2)", () => {
  it("refuses scope=global for an address and for a whole domain — even for the merchant's owner", async () => {
    for (const body of [{ domain: "gmail.com", scope: "global" }, { email: "rival@example.com", scope: "global" }]) {
      const res = await call("POST", "/recruitment/suppressions", a, body);
      expect(res.status).toBe(403);
    }
    expect(await app.appContext.db.suppressions.count(() => true)).toBe(0);
    // …and merchant B can still email gmail.com addresses.
    expect(await isSuppressed(app.appContext, b.merchantId, "someone@gmail.com")).toBe(false);
  });

  it("creates a merchant-scope row that binds only its own merchant", async () => {
    const res = await call("POST", "/recruitment/suppressions", a, { domain: "Spam.Example" });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ scope: "merchant", origin: "merchant", merchantId: a.merchantId, reason: "manual" });
    expect(await isSuppressed(app.appContext, a.merchantId, "x@spam.example")).toBe(true);
    expect(await isSuppressed(app.appContext, b.merchantId, "x@spam.example")).toBe(false);
  });

  it("rejects a suppression that names neither an email nor a domain", async () => {
    expect((await call("POST", "/recruitment/suppressions", a, {})).status).toBe(400);
    expect((await call("POST", "/recruitment/suppressions", a, { email: "  " })).status).toBe(400);
  });

  it("a global row a tenant created before the fix no longer applies to anyone else", async () => {
    // Exactly what the old route wrote for `{ domain: "gmail.com", scope: "global" }`.
    const legacy: Suppression = { id: "supp_legacy", merchantId: null, email: null, domain: "gmail.com", reason: "manual", scope: "global", ts: new Date().toISOString() };
    await app.appContext.db.suppressions.insert(legacy);
    expect(await isSuppressed(app.appContext, a.merchantId, "someone@gmail.com")).toBe(false);
    expect(await isSuppressed(app.appContext, b.merchantId, "someone@gmail.com")).toBe(false);
  });

  it("the system paths still suppress for everyone: signed unsubscribe link and STOP reply", async () => {
    expect((await clickUnsubscribe(a.merchantId, "link@example.com")).statusCode).toBe(200);
    // A STOP reply from someone merchant A really emailed (the reply router records it through suppress()).
    const contacted = { ...prospect(a.merchantId, "stop@example.com"), state: "contacted" } as Prospect;
    await app.appContext.db.prospects.insert(contacted);
    await app.appContext.db.outreachMessages.insert({ id: "om_stop", prospectId: contacted.id, campaignId: "c1", step: 1, variant: null, subject: "s", body: "b", sentAt: new Date().toISOString(), status: "sent" });
    const routed = await call("POST", `/recruitment/prospects/${encodeURIComponent(contacted.id)}/reply`, a, { raw: "STOP" });
    expect(routed.status).toBe(200);
    for (const email of ["link@example.com", "stop@example.com"]) {
      expect(await isSuppressed(app.appContext, a.merchantId, email), email).toBe(true);
      expect(await isSuppressed(app.appContext, b.merchantId, email), email).toBe(true);
    }
  });

  it("importing addresses and pasting an 'unsubscribe' reply for each does NOT silence them for other merchants", async () => {
    // The whole attack needs no email at all: a bulk import, then one pasted reply per address.
    const victims = ["creator-one@niche.test", "creator-two@niche.test"];
    const imported = await call("POST", "/recruitment/prospects/import", b, { rows: victims.map((email, i) => ({ name: `Creator ${i}`, email })) });
    expect(imported.status).toBe(201);
    for (const email of victims) {
      const row = await app.appContext.db.prospects.findOne((p) => p.merchantId === b.merchantId && p.email === email);
      expect(row, email).not.toBeNull();
      expect((await call("POST", `/recruitment/prospects/${row!.id}/reply`, b, { raw: "unsubscribe" })).status).toBe(200);
    }
    for (const email of victims) {
      expect(await isSuppressed(app.appContext, a.merchantId, email), email).toBe(false); // merchant A can still reach them
      expect(await isSuppressed(app.appContext, b.merchantId, email), email).toBe(true); // B opted itself out, nothing more
    }
    expect(await app.appContext.db.suppressions.count((s) => s.scope === "global")).toBe(0);
    // …and merchant A's list is not polluted by B's rows.
    expect((await call("GET", "/recruitment/suppressions", a)).data).toEqual([]);
  });

  it("suppress() refuses a platform-wide request that names no merchant", async () => {
    await expect(suppress(app.appContext, { merchantId: null, email: "x@example.com", reason: "unsubscribe", scope: "global" })).rejects.toThrow();
  });
});

describe("the suppression list shows a merchant what affects it (S2)", () => {
  it("lists its own rows, plus platform-wide rows that hit ITS prospects — and nothing else", async () => {
    await app.appContext.db.prospects.insert(prospect(b.merchantId, "shared@creator.com"));
    await call("POST", "/recruitment/suppressions", b, { email: "manual@b-only.com" });
    // Two people unsubscribe from merchant A's mail: one is also B's prospect, one is not.
    await clickUnsubscribe(a.merchantId, "shared@creator.com");
    await clickUnsubscribe(a.merchantId, "stranger@elsewhere.com");

    const listB = (await call("GET", "/recruitment/suppressions", b)).data as Suppression[];
    const byEmail = Object.fromEntries(listB.map((s) => [s.email, s]));
    expect(Object.keys(byEmail).sort()).toEqual(["manual@b-only.com", "shared@creator.com"]);
    // B is blocked from emailing shared@creator.com and can now see why…
    expect(await isSuppressed(app.appContext, b.merchantId, "shared@creator.com")).toBe(true);
    expect(byEmail["shared@creator.com"]).toMatchObject({ scope: "global", reason: "unsubscribe" });
    // …without learning which merchant the person unsubscribed from,
    expect(byEmail["shared@creator.com"]!.merchantId).toBeNull();
    // and without being able to enumerate A's other unsubscribers.
    expect(JSON.stringify(listB)).not.toContain("stranger@elsewhere.com");
    expect(JSON.stringify(listB)).not.toContain(a.merchantId);

    // The originating merchant sees both of its own, attributed to itself.
    const listA = (await call("GET", "/recruitment/suppressions", a)).data as Suppression[];
    expect(listA.map((s) => s.email).sort()).toEqual(["shared@creator.com", "stranger@elsewhere.com"]);
    expect(listA.every((s) => s.merchantId === a.merchantId)).toBe(true);
  });
});
