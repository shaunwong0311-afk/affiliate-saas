import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { ConsoleTransactionalMailer } from "@affiliate/integrations";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * AUDIT-2026-10 S7 + S12 — 5xx responses returned raw internal error messages, nothing was
 * logged (`Fastify({ logger: false })`), and a data-layer "row not found" surfaced as a 500.
 */
const JWT = "8c1e3a5f7b9d0c2e4a6f8b1d3c5e7a9f0b2d4c6e8a1f3b5d";
const INTERNAL = 'connect ECONNREFUSED 10.0.3.7:5432 — relation "kv_users" (dsn postgres://vantage@db-internal)';

const json = { "content-type": "application/json" };

/** A production app whose log lines are captured instead of written to stdout. */
async function productionApp(db: Database, env: Record<string, string> = {}): Promise<{ app: FastifyInstance; logs: () => Array<Record<string, any>> }> {
  const lines: string[] = [];
  const app = await buildApp(
    { db, config: loadConfig({ NODE_ENV: "production", JWT_SECRET: JWT, ...env }), transactionalMailer: new ConsoleTransactionalMailer() },
    { logStream: { write: (line: string) => void lines.push(line) } },
  );
  return { app, logs: () => lines.map((l) => JSON.parse(l) as Record<string, any>) };
}

/** A database whose user lookup fails the way a broken connection would. */
function brokenDb(): Database {
  const db = createMemoryDatabase();
  db.users.findOne = async () => {
    throw new Error(INTERNAL);
  };
  return db;
}

const loginRequest = { method: "POST" as const, url: "/auth/login", headers: json, payload: { email: "a@b.co", password: "whatever-password" } };

describe("5xx responses (S7)", () => {
  it("production: the client gets a generic message; the real error goes to the log", async () => {
    const { app, logs } = await productionApp(brokenDb());
    const res = await app.inject(loginRequest);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "internal error", code: "internal_error" } });
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("kv_users");

    const errorLine = logs().find((l) => l.level >= 50);
    expect(errorLine).toBeDefined();
    expect(errorLine!.err.message).toBe(INTERNAL);
    expect(errorLine!.err.stack).toContain("Error");
  });

  it("outside production the message is passed through (local debugging)", async () => {
    const app = await buildApp({ db: brokenDb() });
    const res = await app.inject(loginRequest);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.message).toBe(INTERNAL);
  });

  it("deliberate HTTP errors keep their message in production (4xx, and an Error carrying a 4xx statusCode)", async () => {
    const db = createMemoryDatabase();
    const { app } = await productionApp(db, { LOG_LEVEL: "silent" });
    const bad = await app.inject({ ...loginRequest, payload: { email: "nobody@example.com", password: "wrong-password" } });
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.body).error).toEqual({ message: "invalid credentials", code: "unauthorized" });

    // e.g. EntitlementExceededError (statusCode 402) thrown from a service.
    db.users.findOne = async () => {
      throw Object.assign(new Error('entitlement "recruitment_credits" exceeded (limit 10)'), { statusCode: 402 });
    };
    const quota = await app.inject(loginRequest);
    expect(quota.statusCode).toBe(402);
    expect(JSON.parse(quota.body).error.message).toContain("exceeded");
  });

  it("a body that is not JSON is the client's error (400), not a 500", async () => {
    const { app, logs } = await productionApp(createMemoryDatabase());
    const res = await app.inject({ method: "POST", url: "/auth/login", headers: json, payload: '{"email": "a@b.co", ' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "invalid JSON body", code: "bad_request" } });
    expect(logs().some((l) => l.level >= 50)).toBe(false);
  });
});

describe("data-layer not-found maps to 404 (S7)", () => {
  async function signedUp(app: FastifyInstance) {
    const res = await app.inject({ method: "POST", url: "/auth/signup", headers: json, payload: { email: "o@nf.test", password: "supersecret", name: "O", merchantName: "NF" } });
    const data = JSON.parse(res.body).data;
    return { authorization: `Bearer ${data.token as string}`, "x-merchant-id": data.merchant.id as string, merchantId: data.merchant.id as string };
  }

  it("repo.require() on a missing row (in-memory NotFoundError) → 404 without the internal id", async () => {
    const db = createMemoryDatabase();
    const { app } = await productionApp(db, { LOG_LEVEL: "silent" });
    const { merchantId, ...headers } = await signedUp(app);
    await db.merchants.delete(merchantId); // membership remains, the row a handler require()s is gone

    const res = await app.inject({ method: "GET", url: "/recruitment/icp", headers });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "not found", code: "not_found" } });
    expect(res.body).not.toContain(merchantId);
  });

  it("the Postgres adapter's plain `row not found: <id>` error → 404 as well", async () => {
    const db = createMemoryDatabase();
    const app = await buildApp({ db });
    const { merchantId, ...headers } = await signedUp(app);
    db.merchants.require = async (id: string) => {
      throw new Error(`row not found: ${id}`); // packages/db/src/postgres.ts PgRepo.require
    };
    const res = await app.inject({ method: "GET", url: "/recruitment/icp", headers });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(merchantId);
  });
});

describe("request logging (S12)", () => {
  it("is on in production and off by default elsewhere; LOG_LEVEL overrides both", () => {
    expect(loadConfig({ NODE_ENV: "production", JWT_SECRET: JWT }).logLevel).toBe("info");
    expect(loadConfig({ NODE_ENV: "production", JWT_SECRET: JWT, LOG_LEVEL: "warn" }).logLevel).toBe("warn");
    expect(loadConfig({}).logLevel).toBeNull();
    expect(loadConfig({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("logs each request with method, path, status and client address — and never the query string", async () => {
    const { app, logs } = await productionApp(createMemoryDatabase());
    await app.inject({ method: "GET", url: "/track/unsubscribe?m=m1&e=reader%40example.com&t=deadbeefdeadbeef", remoteAddress: "203.0.113.9" });

    const incoming = logs().find((l) => l.msg === "incoming request");
    expect(incoming!.req).toEqual({ method: "GET", url: "/track/unsubscribe", remoteAddress: "203.0.113.9" });
    const completed = logs().find((l) => l.msg === "request completed");
    expect(completed!.res.statusCode).toBe(400);
    const everything = JSON.stringify(logs());
    expect(everything).not.toContain("reader");
    expect(everything).not.toContain("deadbeef");
  });

  it("an unknown route gets the uniform 404 — and its query string is not logged either", async () => {
    const { app, logs } = await productionApp(createMemoryDatabase());
    // A near-miss of the unsubscribe path (trailing slash): no route matches.
    const res = await app.inject({ method: "GET", url: "/track/unsubscribe/?m=m1&e=reader%40example.com&t=deadbeefdeadbeef" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "not found", code: "not_found" } });
    const everything = JSON.stringify(logs());
    expect(everything).toContain("/track/unsubscribe/");
    expect(everything).not.toContain("reader");
    expect(everything).not.toContain("deadbeef");
  });

  it("keeps the container health check out of the log", async () => {
    const { app, logs } = await productionApp(createMemoryDatabase());
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(logs()).toEqual([]);
    // …while any other request on the same app is logged (the silence above is per-route).
    await app.inject({ method: "GET", url: "/" });
    expect(logs().map((l) => l.msg)).toEqual(["incoming request", "request completed"]);
  });
});
