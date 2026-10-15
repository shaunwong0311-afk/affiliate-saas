import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "@affiliate/db";
import type { SecretStore, TransactionalEmail, TransactionalMailer, TransactionalResult } from "@affiliate/integrations";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signJwt } from "../src/auth/jwt.js";
import { sendActivationEmail } from "../src/services/activation-email.js";

/**
 * AUDIT-2026-10 S8 / contract 4 — affiliate magic links are SINGLE-USE. They used to be
 * plain 15-minute (sign-in) and 7-day (activation email) JWTs that could be exchanged for a
 * session any number of times by anyone who saw the link.
 */
class RecordingMailer implements TransactionalMailer {
  readonly provider = "recording";
  readonly sent: TransactionalEmail[] = [];
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    this.sent.push(email);
    return { id: `r${this.sent.length}`, status: "sent" };
  }
}

const EMAIL = "hi@trailgeek.com";
const json = { "content-type": "application/json" };

let app: FastifyInstance;
let db: Database;
let mailer: RecordingMailer;

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await db.merchants.insert({ id: "m1", name: "Lumen Skincare", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Main St", createdAt: now });
  await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
  await db.offers.insert({ id: "off1", merchantId: "m1", programId: "prog1", engine: "affiliate", name: "Default Offer", payoutType: "percentage", payoutValue: 0.15, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
  await db.affiliates.insert({ id: "aff1", name: "Trail Geek", primaryEmail: EMAIL, country: "US", audienceProfile: null, status: "active", createdAt: now });
  await db.relationships.insert({ id: "rel1", affiliateId: "aff1", merchantId: "m1", programId: "prog1", status: "active", joinedAt: now, role: "seller", commissionTerms: null, source: "recruitment", ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null });
}

const requestLink = (email = EMAIL) => app.inject({ method: "POST", url: "/auth/affiliate/request-link", headers: json, payload: { email } });
const verify = (token: string) => app.inject({ method: "POST", url: "/auth/affiliate/verify", headers: json, payload: { token } });
const devToken = async () => JSON.parse((await requestLink()).body).data.devToken as string;
/** The token inside the `{app}/#/portal/verify?token=…` link of the most recent email. */
const emailedToken = () => /\/#\/portal\/verify\?token=([A-Za-z0-9._-]+)/.exec(mailer.sent.at(-1)!.text ?? "")![1]!;

beforeEach(async () => {
  mailer = new RecordingMailer();
  app = await buildApp({ transactionalMailer: mailer });
  db = app.appContext.db;
  await seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sign-in magic link is single-use (S8)", () => {
  it("the emailed link signs in once; the same link is then refused", async () => {
    await requestLink();
    const token = emailedToken();

    const first = await verify(token);
    expect(first.statusCode).toBe(200);
    const session = JSON.parse(first.body).data.token as string;
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${session}` } });
    expect(JSON.parse(me.body).data.kind).toBe("affiliate");

    const replay = await verify(token);
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error).toEqual({ message: "invalid or expired link", code: "unauthorized" });
    // The session issued by the first use keeps working.
    expect((await app.inject({ method: "GET", url: "/portal/stats", headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(200);
  });

  it("two links requested back to back both work — once each", async () => {
    const older = await devToken();
    const newer = await devToken();
    expect((await verify(newer)).statusCode).toBe(200);
    expect((await verify(older)).statusCode).toBe(200);
    expect((await verify(newer)).statusCode).toBe(401);
    expect((await verify(older)).statusCode).toBe(401);
  });

  it("expires after 15 minutes", async () => {
    const token = await devToken();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect((await verify(token)).statusCode).toBe(401);
  });

  it("a validly signed magic token that was never issued by the mint (no nonce on record) is refused", async () => {
    const secret = app.appContext.config.jwtSecret;
    // What the pre-fix code minted: no nonce at all.
    expect((await verify(signJwt({ sub: "aff1", kind: "affiliate_magic", email: EMAIL }, secret, 900))).statusCode).toBe(401);
    // A nonce the server has no record of.
    expect((await verify(signJwt({ sub: "aff1", kind: "affiliate_magic", email: EMAIL, jti: "made-up-nonce" }, secret, 900))).statusCode).toBe(401);
  });

  it("stops working when the affiliate's address has changed since the link was sent", async () => {
    const token = await devToken();
    await db.affiliates.update("aff1", { primaryEmail: "new-owner@example.com" });
    expect((await verify(token)).statusCode).toBe(401);
  });

  it("at most 5 unused sign-in links per affiliate: further requests mint and mail nothing (and still answer 200)", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) tokens.push(await devToken());
    expect(mailer.sent).toHaveLength(5);

    const sixth = await requestLink();
    expect(sixth.statusCode).toBe(200);
    expect(JSON.parse(sixth.body).data).toEqual({ sent: true }); // same answer, no token
    expect(mailer.sent).toHaveLength(5); // nothing mailed

    // Links already delivered are untouched, and using one frees a slot.
    expect((await verify(tokens[0]!)).statusCode).toBe(200);
    expect(JSON.parse((await requestLink()).body).data.devToken).toBeTruthy();
    expect(mailer.sent).toHaveLength(6);
  });

  it("unknown addresses get the same answer and no mail (no enumeration)", async () => {
    const res = await requestLink("stranger@example.com");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(0);
  });

  it("keeps its bookkeeping off the affiliate row (which merchant-facing routes return verbatim)", async () => {
    const before = await db.affiliates.get("aff1");
    await devToken();
    expect(await db.affiliates.get("aff1")).toEqual(before);
  });

  it("production never returns the token in the response", async () => {
    app = await buildApp({ transactionalMailer: mailer, config: loadConfig({ NODE_ENV: "production", JWT_SECRET: "6b0d2f4a8c1e3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1b3d5f", LOG_LEVEL: "silent" }) });
    db = app.appContext.db;
    await seed();
    const res = await requestLink();
    expect(JSON.parse(res.body).data).toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(1);
    expect((await verify(emailedToken())).statusCode).toBe(200);
    expect((await verify(emailedToken())).statusCode).toBe(401);
  });
});

describe("single-use holds when requests overlap (S8)", () => {
  /** A secret store with real asynchronous gaps between read and write — like a database round-trip. */
  class SlowSecretStore implements SecretStore {
    private readonly rows = new Map<string, string>();
    private readonly gap = () => new Promise<void>((resolve) => setImmediate(resolve));
    async put(ref: string, value: string): Promise<void> {
      await this.gap();
      this.rows.set(ref, value);
    }
    async get(ref: string): Promise<string | null> {
      await this.gap();
      return this.rows.get(ref) ?? null;
    }
    async delete(ref: string): Promise<void> {
      await this.gap();
      this.rows.delete(ref);
    }
  }

  beforeEach(async () => {
    app = await buildApp({ transactionalMailer: mailer, secrets: new SlowSecretStore() });
    db = app.appContext.db;
    await seed();
  });

  it("ten simultaneous redemptions of one token produce exactly one session", async () => {
    const token = await devToken();
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => verify(token)))).map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(9);
  });

  it("links requested at the same moment do not overwrite each other", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => requestLink()));
    const tokens = responses.map((r) => JSON.parse(r.body).data.devToken as string);
    expect(new Set(tokens).size).toBe(4);
    for (const token of tokens) expect((await verify(token)).statusCode).toBe(200);
  });
});

describe("activation-email magic link is single-use too (S8)", () => {
  it("the welcome email's link signs in once, then is refused", async () => {
    expect((await sendActivationEmail(app.appContext, "rel1")).sent).toBe(true);
    const token = emailedToken();
    expect(mailer.sent.at(-1)!.text).toContain(`/#/portal/verify?token=${token}`); // link shape is unchanged (contract 4)

    expect((await verify(token)).statusCode).toBe(200);
    expect((await verify(token)).statusCode).toBe(401);
  });

  it("one merchant re-sending welcome links cannot push out another merchant's unused link", async () => {
    const { mintActivationMagicLink } = await import("../src/auth/magic-link.js");
    const affiliate = (await db.affiliates.get("aff1"))!;
    const ttl = 7 * 24 * 3600;
    const fromMerchantA = await mintActivationMagicLink(app.appContext, affiliate, ttl, "merchant-a");
    // Merchant B mints welcome links for the same affiliate again and again.
    const fromMerchantB: string[] = [];
    for (let i = 0; i < 12; i++) fromMerchantB.push((await mintActivationMagicLink(app.appContext, affiliate, ttl, "merchant-b")).token);

    expect((await verify(fromMerchantA.token)).statusCode).toBe(200); // untouched by B's volume
    // B only ever displaced its own older links.
    expect((await verify(fromMerchantB[0]!)).statusCode).toBe(401);
    expect((await verify(fromMerchantB.at(-1)!)).statusCode).toBe(200);
  });

  it("a welcome link and a later sign-in link do not cancel each other", async () => {
    await sendActivationEmail(app.appContext, "rel1");
    const welcome = emailedToken();
    const signIn = await devToken();
    expect((await verify(signIn)).statusCode).toBe(200);
    expect((await verify(welcome)).statusCode).toBe(200);
    expect((await verify(welcome)).statusCode).toBe(401);
  });
});
