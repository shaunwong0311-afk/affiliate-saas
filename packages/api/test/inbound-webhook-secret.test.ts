import { describe, it, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ConsoleTransactionalMailer } from "@affiliate/integrations";
import type { Mailbox, Prospect } from "@affiliate/db";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * AUDIT-2026-10 S3 — POST /webhooks/inbound is public and a forged inbound "STOP" suppresses
 * a contacted prospect. Its shared-secret guard used to be skipped whenever
 * INBOUND_WEBHOOK_SECRET was unset (production included), compared with `!==`, and accepted
 * the secret in the query string.
 */
const JWT = "5e1f0c9a7b3d4e2f8a6c1b0d9e7f3a5c2b4d6e8f0a1c3e5b";
const WEBHOOK_SECRET = "b7d1f3a59c2e4f60a8b1c3d5e7f9a0b2c4d6e8f1a3b5c7d9";

let app: FastifyInstance;

async function boot(env: Record<string, string>): Promise<void> {
  // The pre-fix route read process.env directly; the fixed one reads the loaded config. Set
  // both so the test exercises the same deployment either way.
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  app = await buildApp({ config: loadConfig({ JWT_SECRET: JWT, LOG_LEVEL: "silent", ...env }), transactionalMailer: new ConsoleTransactionalMailer() });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A merchant with a connected mailbox and one prospect it has already emailed. */
async function seedContactedProspect(): Promise<{ prospectId: string; payload: Record<string, string> }> {
  const { db } = app.appContext;
  const now = new Date().toISOString();
  await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: now });
  const mailbox: Mailbox = { id: "mb1", merchantId: "m1", provider: "smtp", email: "team@lumen.test", status: "connected", dailyCap: 30, warmupStatus: "ready", credentialsRef: "ref" };
  await db.mailboxes.insert(mailbox);
  const prospect = { id: "p1", merchantId: "m1", source: "serp", identity: "Creator", siteUrl: null, channelUrl: null, email: "creator@site.test", state: "contacted", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: now, updatedAt: now } as Prospect;
  await db.prospects.insert(prospect);
  return { prospectId: "p1", payload: { to: "team@lumen.test", from: "creator@site.test", subject: "Re: partnership", text: "STOP", messageId: "<forged-1@attacker.test>" } };
}

function post(payload: unknown, opts: { header?: string; query?: string } = {}) {
  return app.inject({
    method: "POST",
    url: `/webhooks/inbound${opts.query ? `?secret=${encodeURIComponent(opts.query)}` : ""}`,
    headers: { "content-type": "application/json", ...(opts.header !== undefined ? { "x-webhook-secret": opts.header } : {}) },
    payload: payload as never,
  });
}

describe("POST /webhooks/inbound shared secret (S3)", () => {
  it("production with NO secret configured: the route is closed — a forged STOP suppresses nobody", async () => {
    await boot({ NODE_ENV: "production" });
    const { prospectId, payload } = await seedContactedProspect();

    const res = await post(payload);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("webhook_not_configured");

    const { db } = app.appContext;
    expect((await db.prospects.require(prospectId)).state).toBe("contacted");
    expect(await db.suppressions.count(() => true)).toBe(0);
    expect(await db.replies.count(() => true)).toBe(0);
  });

  it("production with an EMPTY secret env var is the same as unset — closed, not open", async () => {
    await boot({ NODE_ENV: "production", INBOUND_WEBHOOK_SECRET: "" });
    const { prospectId, payload } = await seedContactedProspect();
    expect((await post(payload, { header: "" })).statusCode).toBe(503);
    expect((await app.appContext.db.prospects.require(prospectId)).state).toBe("contacted");
  });

  it("with a secret: missing or wrong header is 401, and the query string is not a credential", async () => {
    await boot({ NODE_ENV: "production", INBOUND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { prospectId, payload } = await seedContactedProspect();

    expect((await post(payload)).statusCode).toBe(401);
    expect((await post(payload, { header: "wrong" })).statusCode).toBe(401);
    expect((await post(payload, { header: WEBHOOK_SECRET.slice(0, -1) })).statusCode).toBe(401);
    // The right secret, but in the URL (where it would sit in every access log): refused.
    expect((await post(payload, { query: WEBHOOK_SECRET })).statusCode).toBe(401);

    expect((await app.appContext.db.prospects.require(prospectId)).state).toBe("contacted");
    expect(await app.appContext.db.suppressions.count(() => true)).toBe(0);
  });

  it("with a secret: the right header is accepted and the reply is routed", async () => {
    await boot({ NODE_ENV: "production", INBOUND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { payload } = await seedContactedProspect();

    const res = await post(payload, { header: WEBHOOK_SECRET });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.matched).toBe(true);
    expect(await app.appContext.db.replies.count(() => true)).toBe(1);
  });

  it("outside production the guard is skipped only when no secret is configured (dev convenience)", async () => {
    await boot({});
    const res = await post({ to: "nobody@nowhere.test", from: "x@y.test", text: "hello" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.matched).toBe(false);
  });

  it("outside production a configured secret is still enforced", async () => {
    await boot({ INBOUND_WEBHOOK_SECRET: WEBHOOK_SECRET });
    expect((await post({ to: "a@b.test", from: "x@y.test", text: "hello" })).statusCode).toBe(401);
    expect((await post({ to: "a@b.test", from: "x@y.test", text: "hello" }, { header: WEBHOOK_SECRET })).statusCode).toBe(200);
  });
});
