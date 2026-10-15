import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac, scryptSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// Count scrypt runs without changing them: the only reliable way to assert "the same work
// is done for an unknown user" (wall-clock timing would be flaky on a shared box).
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) };
});

/**
 * AUDIT-2026-10 S9 — the API-key "pepper" was the hard-coded string "apikey-pepper", and
 * login did no password hashing for an unknown email, so response time revealed which
 * addresses are registered. (Signup's 409 is deliberately unchanged.)
 */
const json = { "content-type": "application/json" };
const A = "1d3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b";
const B = "9e7c5a3f1d0b8e6c4a2f0d9b7e5c3a1f8d6b4e2c0a9f7d5b";

let app: FastifyInstance;
let token: string;
let merchantId: string;

beforeEach(async () => {
  app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/auth/signup", headers: json, payload: { email: "owner@s9.test", password: "correct-horse-battery", name: "Owner", merchantName: "S9 Co" } });
  const data = JSON.parse(res.body).data;
  token = data.token;
  merchantId = data.merchant.id;
});

const login = (email: string, password: string) => app.inject({ method: "POST", url: "/auth/login", headers: json, payload: { email, password } });

async function scryptRunsDuring(fn: () => Promise<unknown>): Promise<number> {
  const before = vi.mocked(scryptSync).mock.calls.length;
  await fn();
  return vi.mocked(scryptSync).mock.calls.length - before;
}

describe("login does the same work for unknown users (S9)", () => {
  it("an unknown email costs one scrypt run — exactly like a wrong password for a real account", async () => {
    let status = 0;
    expect(await scryptRunsDuring(async () => void (status = (await login("owner@s9.test", "wrong-password")).statusCode))).toBe(1);
    expect(status).toBe(401);

    expect(await scryptRunsDuring(async () => void (status = (await login("nobody@s9.test", "wrong-password")).statusCode))).toBe(1);
    expect(status).toBe(401);
  });

  it("an invited user who has not set a password yet is indistinguishable too", async () => {
    await app.inject({ method: "POST", url: `/merchants/${merchantId}/users`, headers: { ...json, authorization: `Bearer ${token}` }, payload: { email: "invitee@s9.test", name: "Invitee", role: "viewer" } });
    let res: Awaited<ReturnType<typeof login>> | undefined;
    expect(await scryptRunsDuring(async () => void (res = await login("invitee@s9.test", "anything-at-all")))).toBe(1);
    expect(res!.statusCode).toBe(401);
    expect(JSON.parse(res!.body).error.message).toBe("invalid credentials");
  });

  it("the right password still signs in, and the wrong one never does", async () => {
    expect((await login("owner@s9.test", "correct-horse-battery")).statusCode).toBe(200);
    expect((await login("OWNER@s9.test", "correct-horse-battery")).statusCode).toBe(200);
    expect((await login("owner@s9.test", "")).statusCode).toBe(401);
  });

  it("signup still answers 409 for a registered email (unchanged by design)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/signup", headers: json, payload: { email: "owner@s9.test", password: "another-password", name: "X", merchantName: "Y" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("API-key hashes are keyed from configuration (S9)", () => {
  async function createKey(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/developer/api-keys", headers: { ...json, authorization: `Bearer ${token}`, "x-merchant-id": merchantId }, payload: { name: "ci", scopes: ["read"] } });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).data.key as string;
  }
  const useKey = (instance: FastifyInstance, key: string) => instance.inject({ method: "GET", url: "/programs", headers: { authorization: `Bearer ${key}` } });

  it("stores an HMAC under the configured pepper — not under the old constant", async () => {
    const key = await createKey();
    const stored = (await app.appContext.db.apiKeys.findOne(() => true))!.hashedKey;
    expect(stored).toBe(createHmac("sha256", app.appContext.config.apiKeyPepper).update(key).digest("hex"));
    expect(stored).not.toBe(createHmac("sha256", "apikey-pepper").update(key).digest("hex"));
    expect((await useKey(app, key)).statusCode).toBe(200);
  });

  it("a key only verifies on an instance configured with the same pepper", async () => {
    const key = await createKey();
    const { db, config } = app.appContext;
    const samePepper = await buildApp({ db, config });
    const otherPepper = await buildApp({ db, config: { ...config, apiKeyPepper: "an-entirely-different-pepper-value-0123456789" } });
    expect((await useKey(samePepper, key)).statusCode).toBe(200);
    expect((await useKey(otherPepper, key)).statusCode).toBe(401);
  });

  it("the pepper comes from API_KEY_PEPPER, else is derived from JWT_SECRET (and is not the JWT secret itself)", () => {
    const fromA = loadConfig({ JWT_SECRET: A }).apiKeyPepper;
    const fromB = loadConfig({ JWT_SECRET: B }).apiKeyPepper;
    expect(fromA).not.toBe(fromB);
    expect(fromA).not.toBe(A);
    expect(loadConfig({ JWT_SECRET: A }).apiKeyPepper).toBe(fromA); // stable across restarts
    expect(loadConfig({ JWT_SECRET: A, API_KEY_PEPPER: B }).apiKeyPepper).toBe(B);
    expect(loadConfig({ JWT_SECRET: A, API_KEY_PEPPER: "" }).apiKeyPepper).toBe(fromA); // empty = unset
  });
});
