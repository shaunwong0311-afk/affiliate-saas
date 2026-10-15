import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { signUnsubscribeToken } from "@affiliate/core";
import { buildApp, rateRuleFor } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RateLimiter, clientKey, inboxKey, AUTH_LIMIT, PUBLIC_FORM_LIMIT, PUBLIC_FORM_PER_EMAIL_LIMIT, SIGNED_ENDPOINT_LIMIT } from "../src/auth/rate-limit.js";

/**
 * AUDIT-2026-10 S6 + S11 — the limiter keyed on the first X-Forwarded-For value (which the
 * caller controls) and on the raw URL, and its map never evicted. Public join/apply sat
 * behind that same spoofable limit (apply behind none at all).
 */
const json = { "content-type": "application/json" };
/** A login attempt that is rejected at validation (400) — counted by the limiter, but no password hashing. */
const login = (app: FastifyInstance, opts: { url?: string; xff?: string; remoteAddress?: string } = {}) =>
  app.inject({
    method: "POST",
    url: opts.url ?? "/auth/login",
    headers: { ...json, ...(opts.xff ? { "x-forwarded-for": opts.xff } : {}) },
    payload: { email: "not-an-email", password: "x" },
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  });

describe("RateLimiter (unit)", () => {
  it("allows `max` hits per window, then blocks until the window ends", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ now: () => now });
    const rule = { max: 3, windowMs: 60_000 };
    expect([1, 2, 3, 4, 5].map(() => limiter.hit("k", rule).allowed)).toEqual([true, true, true, false, false]);
    expect(limiter.hit("k", rule).retryAfterSeconds).toBe(60);
    now += 59_000;
    expect(limiter.hit("k", rule)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now += 1_000;
    expect(limiter.hit("k", rule).allowed).toBe(true);
    expect(limiter.hit("other", rule).allowed).toBe(true); // keys are independent
  });

  it("evicts expired windows instead of growing forever", () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => now });
    for (let i = 0; i < 5_000; i++) limiter.hit(`client-${i}`, { max: 1, windowMs: 60_000 });
    expect(limiter.size).toBe(5_000);
    now += 61_000; // every window is over; the next request sweeps them
    limiter.hit("fresh", { max: 1, windowMs: 60_000 });
    expect(limiter.size).toBe(1);
  });

  it("never holds more than its size cap, even when nothing has expired", () => {
    const limiter = new RateLimiter({ maxKeys: 100, now: () => 0 });
    for (let i = 0; i < 10_000; i++) limiter.hit(`client-${i}`, { max: 1, windowMs: 60_000 });
    expect(limiter.size).toBe(100);
    // The newest keys are the ones kept: the last client is still being counted.
    expect(limiter.hit("client-9999", { max: 1, windowMs: 60_000 }).allowed).toBe(false);
  });

  it("identifies a client by IPv4 address or IPv6 /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
    // One subscriber's /64 is one client, however many addresses it rotates through.
    expect(clientKey("2001:db8:abcd:12:1::1")).toBe(clientKey("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"));
    expect(clientKey("2001:db8:abcd:12::1")).not.toBe(clientKey("2001:db8:abcd:13::1"));
    expect(clientKey("fe80::1%eth0")).toBe(clientKey("fe80::2"));
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    // Not an address at all (only reachable through a caller-written header): one shared
    // bucket — it cannot mint buckets or stuff the table with arbitrary strings.
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
    expect(clientKey("totally-made-up")).toBe("unknown");
    expect(clientKey("x".repeat(10_000))).toBe("unknown");
  });
});

describe("the limiter keys on the real client address (S6)", () => {
  it("a spoofed X-Forwarded-For does not buy a fresh bucket when no proxy is trusted", async () => {
    const app = await buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT.max + 3; i++) statuses.push((await login(app, { xff: `198.51.100.${i}` })).statusCode);
    expect(statuses.slice(0, AUTH_LIMIT.max).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(AUTH_LIMIT.max)).toEqual([429, 429, 429]);
  });

  it("answers 429 with Retry-After and the uniform error envelope", async () => {
    const app = await buildApp();
    for (let i = 0; i < AUTH_LIMIT.max; i++) await login(app);
    const res = await login(app);
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "too many requests", code: "rate_limited" } });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("percent-encoding the path does not escape the bucket (it is the matched route, not the URL)", async () => {
    const app = await buildApp();
    for (let i = 0; i < AUTH_LIMIT.max; i++) await login(app);
    for (const url of ["/%61uth/login", "/auth/%6Cogin", "/auth/login?x=1"]) {
      expect((await login(app, { url })).statusCode, url).toBe(429);
    }
  });

  it("TRUST_PROXY: clients behind a trusted proxy are told apart; an untrusted peer's header is ignored", async () => {
    const app = await buildApp({ config: loadConfig({ TRUST_PROXY: "10.0.0.1" }) });
    // Through the trusted proxy: each forwarded client has its own bucket.
    for (let i = 0; i < AUTH_LIMIT.max; i++) await login(app, { remoteAddress: "10.0.0.1", xff: "203.0.113.1" });
    expect((await login(app, { remoteAddress: "10.0.0.1", xff: "203.0.113.1" })).statusCode).toBe(429);
    expect((await login(app, { remoteAddress: "10.0.0.1", xff: "203.0.113.2" })).statusCode).toBe(400);
    // Straight from somewhere else: whatever it claims, it is one client.
    const direct: number[] = [];
    for (let i = 0; i < AUTH_LIMIT.max + 1; i++) direct.push((await login(app, { remoteAddress: "198.51.100.9", xff: `203.0.113.${100 + i}` })).statusCode);
    expect(direct[AUTH_LIMIT.max]).toBe(429);
  });

  it("reads TRUST_PROXY: unset/false → none, true → all, a number → hops, otherwise an address list", () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: "10.0.0.0/8, loopback" }).trustProxy).toBe("10.0.0.0/8, loopback");
  });

  it("an authenticated read under /auth is not a guessing surface and is not throttled", async () => {
    const app = await buildApp();
    const signup = await app.inject({ method: "POST", url: "/auth/signup", headers: json, payload: { email: "me@limit.test", password: "supersecret", name: "Me", merchantName: "Co" } });
    const token = JSON.parse(signup.body).data.token as string;
    for (let i = 0; i < AUTH_LIMIT.max + 5; i++) {
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    }
  });

  it("HMAC-protected endpoints get a flood guard, not the brute-force limit (one provider address, many users)", async () => {
    const app = await buildApp();
    // 40 different recipients click one-click unsubscribe; the mailbox provider relays them all
    // from the same egress address.
    for (let i = 0; i < 40; i++) {
      const email = `reader${i}@example.com`;
      const token = signUnsubscribeToken("m1", email, "dev-insecure-secret-change-me");
      const res = await app.inject({
        method: "POST",
        url: `/track/unsubscribe?m=m1&e=${encodeURIComponent(email)}&t=${token}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "List-Unsubscribe=One-Click",
        remoteAddress: "209.85.220.41",
      });
      expect(res.statusCode, email).toBe(200);
    }
    expect(await app.appContext.db.suppressions.count(() => true)).toBe(40);
  });

  it("every rule in the table matches a route that exists", async () => {
    const app = await buildApp();
    await app.ready();
    const expected: Array<[string, string, unknown]> = [
      ["POST", "/auth/login", AUTH_LIMIT],
      ["POST", "/auth/signup", AUTH_LIMIT],
      ["POST", "/auth/affiliate/request-link", AUTH_LIMIT],
      ["POST", "/auth/affiliate/verify", AUTH_LIMIT],
      ["POST", "/join/:merchantId", PUBLIC_FORM_LIMIT],
      ["POST", "/programs/:programId/apply", PUBLIC_FORM_LIMIT],
      ["POST", "/track/postback/:merchantId", SIGNED_ENDPOINT_LIMIT],
      ["POST", "/recruitment/reply-webhook/:merchantId", SIGNED_ENDPOINT_LIMIT],
      ["POST", "/webhooks/inbound", SIGNED_ENDPOINT_LIMIT],
      ["POST", "/track/unsubscribe", SIGNED_ENDPOINT_LIMIT],
      ["GET", "/track/unsubscribe", SIGNED_ENDPOINT_LIMIT],
    ];
    for (const [method, url, rule] of expected) {
      expect(app.hasRoute({ method: method as "GET", url }), `${method} ${url} is registered`).toBe(true);
      expect(rateRuleFor(method, url), `${method} ${url}`).toBe(rule);
    }
    expect(rateRuleFor("GET", "/auth/me")).toBeNull();
    expect(rateRuleFor("GET", "/programs")).toBeNull();
  });
});

describe("public join / apply are tightly limited (S11)", () => {
  it("per client across ALL merchants and programs — varying the path does not help", async () => {
    const app = await buildApp();
    const join: number[] = [];
    for (let i = 0; i < PUBLIC_FORM_LIMIT.max + 2; i++) {
      join.push((await app.inject({ method: "POST", url: `/join/mer_${i}`, headers: json, payload: { email: `a${i}@example.com`, name: "A" } })).statusCode);
    }
    expect(join.slice(0, PUBLIC_FORM_LIMIT.max).every((s) => s === 404)).toBe(true); // unknown merchants, but counted
    expect(join.slice(PUBLIC_FORM_LIMIT.max)).toEqual([429, 429]);

    const apply: number[] = [];
    for (let i = 0; i < PUBLIC_FORM_LIMIT.max + 2; i++) {
      apply.push((await app.inject({ method: "POST", url: `/programs/prog_${i}/apply`, headers: json, payload: { email: `b${i}@example.com`, name: "B" } })).statusCode);
    }
    expect(apply.slice(0, PUBLIC_FORM_LIMIT.max).every((s) => s === 404)).toBe(true);
    expect(apply.slice(PUBLIC_FORM_LIMIT.max)).toEqual([429, 429]);
    expect(PUBLIC_FORM_LIMIT.max).toBeLessThan(AUTH_LIMIT.max);
  });

  it("per submitted email address — even when every request comes from a different client", async () => {
    const app = await buildApp();
    const { db } = app.appContext;
    const now = new Date().toISOString();
    await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Main St", createdAt: now });
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });

    for (const [name, url] of [["join", "/join/m1"], ["apply", "/programs/prog1/apply"]] as const) {
      const email = `victim-${name}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_FORM_PER_EMAIL_LIMIT.max + 1; i++) {
        statuses.push((await app.inject({ method: "POST", url, headers: json, payload: { email, name: "Victim" }, remoteAddress: `192.0.2.${10 + i}` })).statusCode);
      }
      // The first submission is accepted; repeats for the same address are either accepted again (join is
      // idempotent) or refused as a duplicate application (409) — never rate-limited before the cap.
      expect(statuses[0], name).toBe(201);
      expect(statuses.slice(0, PUBLIC_FORM_PER_EMAIL_LIMIT.max).every((s) => s === 201 || s === 409), `${name}: ${statuses.join(",")}`).toBe(true);
      expect(statuses[PUBLIC_FORM_PER_EMAIL_LIMIT.max], name).toBe(429);
      // A different address from the same clients is unaffected.
      expect((await app.inject({ method: "POST", url, headers: json, payload: { email: `someone-else-${name}@example.com`, name: "Else" }, remoteAddress: "192.0.2.10" })).statusCode).toBe(201);
    }
  });

  it("the allowance belongs to the inbox: +tags and Gmail dots do not get a fresh one", async () => {
    expect(inboxKey("Victim+promo@Example.com")).toBe("victim@example.com");
    expect(inboxKey("v.i.c.tim+1@googlemail.com")).toBe("victim@gmail.com");
    expect(inboxKey("first.last@example.com")).toBe("first.last@example.com"); // dots only mean nothing at Gmail
    expect(inboxKey("+odd@example.com")).toBe("+odd@example.com");

    const app = await buildApp();
    const { db } = app.appContext;
    const now = new Date().toISOString();
    await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Main St", createdAt: now });
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_FORM_PER_EMAIL_LIMIT.max + 1; i++) {
      statuses.push((await app.inject({ method: "POST", url: "/join/m1", headers: json, payload: { email: `victim+${i}@gmail.com`, name: "Victim" }, remoteAddress: `192.0.2.${40 + i}` })).statusCode);
    }
    expect(statuses.slice(0, PUBLIC_FORM_PER_EMAIL_LIMIT.max).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("posting an address at merchants that do not exist does not use up its allowance", async () => {
    const app = await buildApp();
    const { db } = app.appContext;
    const now = new Date().toISOString();
    await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Main St", createdAt: now });
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
    const email = "wanted-creator@example.com";
    for (let i = 0; i < PUBLIC_FORM_PER_EMAIL_LIMIT.max + 2; i++) {
      const res = await app.inject({ method: "POST", url: `/join/no-such-merchant-${i}`, headers: json, payload: { email, name: "X" }, remoteAddress: `192.0.2.${70 + i}` });
      expect(res.statusCode).toBe(404);
    }
    // The creator themselves can still apply.
    expect((await app.inject({ method: "POST", url: "/join/m1", headers: json, payload: { email, name: "Creator" }, remoteAddress: "192.0.2.99" })).statusCode).toBe(201);
  });
});
