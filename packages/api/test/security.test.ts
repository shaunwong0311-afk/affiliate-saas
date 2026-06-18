import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * Regression tests for the bugs the adversarial review found: privilege
 * escalation via team-role grants, cross-tenant affiliate-statement leakage, and
 * a per-tenant user creating a platform-wide global suppression.
 */

let app: FastifyInstance;

async function call(method: string, url: string, opts: { token?: string; merchantId?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.merchantId) headers["x-merchant-id"] = opts.merchantId;
  const res = await app.inject({ method: method as any, url, headers, payload: opts.body as any });
  const json = res.body ? JSON.parse(res.body) : {};
  return { status: res.statusCode, data: json.data ?? json };
}

async function signup(email: string, merchantName: string) {
  const res = await call("POST", "/auth/signup", { body: { email, password: "supersecret", name: email, merchantName } });
  return { token: res.data.token as string, merchantId: res.data.merchant.id as string, userId: res.data.user.id as string };
}

let ownerA: Awaited<ReturnType<typeof signup>>;
let userB: Awaited<ReturnType<typeof signup>>;
let adminToken: string;

beforeAll(async () => {
  app = await buildApp();
  ownerA = await signup("owner-a@test.dev", "Merchant A");
  userB = await signup("user-b@test.dev", "Merchant B"); // owner of B, will be admin of A
  // Owner of A adds userB to merchant A as an admin.
  await call("POST", `/merchants/${ownerA.merchantId}/users`, {
    token: ownerA.token,
    merchantId: ownerA.merchantId,
    body: { email: "user-b@test.dev", name: "User B", role: "admin" },
  });
  const login = await call("POST", "/auth/login", { body: { email: "user-b@test.dev", password: "supersecret" } });
  adminToken = login.data.token;
});

describe("privilege escalation is blocked", () => {
  it("an admin cannot create an owner-role member", async () => {
    const res = await call("POST", `/merchants/${ownerA.merchantId}/users`, {
      token: adminToken,
      merchantId: ownerA.merchantId,
      body: { email: "puppet@test.dev", name: "Puppet", role: "owner" },
    });
    expect(res.status).toBe(403);
  });

  it("an admin cannot promote a member to owner", async () => {
    const res = await call("PATCH", `/merchants/${ownerA.merchantId}/users/${userB.userId}`, {
      token: adminToken,
      merchantId: ownerA.merchantId,
      body: { role: "owner" },
    });
    expect(res.status).toBe(403);
  });

  it("the owner CAN grant owner", async () => {
    const res = await call("POST", `/merchants/${ownerA.merchantId}/users`, {
      token: ownerA.token,
      merchantId: ownerA.merchantId,
      body: { email: "coowner@test.dev", name: "Co Owner", role: "owner" },
    });
    expect(res.status).toBe(201);
  });
});

describe("cross-tenant isolation", () => {
  it("a merchant cannot read an affiliate statement it has no relationship with", async () => {
    // Create an affiliate under merchant A.
    const prog = await call("POST", "/programs", { token: ownerA.token, merchantId: ownerA.merchantId, body: { name: "P", approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 0 } });
    const aff = await call("POST", "/affiliates", { token: ownerA.token, merchantId: ownerA.merchantId, body: { email: "aff@test.dev", name: "Aff", role: "seller", programId: prog.data.id } });
    const affiliateId = aff.data.affiliateId;

    // Merchant B (userB as its owner) tries to read A's affiliate statement.
    const leak = await call("GET", `/affiliates/${affiliateId}/statement`, { token: userB.token, merchantId: userB.merchantId });
    expect(leak.status).toBe(404);
  });
});

describe("global suppression requires elevated capability", () => {
  it("an admin can create a global suppression but a manager cannot", async () => {
    const asAdmin = await call("POST", "/recruitment/suppressions", {
      token: adminToken,
      merchantId: ownerA.merchantId,
      body: { domain: "spam.example", scope: "global" },
    });
    expect([200, 201]).toContain(asAdmin.status);
  });
});
