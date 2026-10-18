import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { createOwner } from "../src/admin/create-owner.js";

/**
 * A single-business install (Perfect Design): public merchant signup is closed in production
 * by default, and the first merchant is created with `npm run create-owner`, whose owner
 * accepts a single-use invite link to set their password.
 */
const prodEnv = () => ({ NODE_ENV: "production", JWT_SECRET: randomBytes(32).toString("hex") });
const json = { "content-type": "application/json" };
const signupBody = { email: "stranger@example.com", password: "a-long-password", name: "Stranger", merchantName: "Not Ours" };

describe("public signup on a production install", () => {
  it("is closed by default: 403 signup_closed, and /auth/config says so", async () => {
    const app = await buildApp({ config: loadConfig(prodEnv()) });
    const res = await app.inject({ method: "POST", url: "/auth/signup", headers: json, payload: signupBody });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("signup_closed");
    expect(await app.appContext.db.merchants.count()).toBe(0);
    const cfg = await app.inject({ method: "GET", url: "/auth/config" });
    expect(JSON.parse(cfg.body).data).toEqual({ signupOpen: false });
  });

  it("opens with ALLOW_SIGNUP=true (an open SaaS), and stays open in development", async () => {
    const open = await buildApp({ config: loadConfig({ ...prodEnv(), ALLOW_SIGNUP: "true" }) });
    expect((await open.inject({ method: "POST", url: "/auth/signup", headers: json, payload: signupBody })).statusCode).toBe(201);
    const dev = await buildApp({ config: loadConfig({}) });
    expect(JSON.parse((await dev.inject({ method: "GET", url: "/auth/config" })).body).data).toEqual({ signupOpen: true });
  });
});

describe("create-owner", () => {
  it("creates the merchant and an invited owner; the single-use link sets the password once", async () => {
    const config = loadConfig({ ...prodEnv(), CORS_ORIGINS: "https://partners.perfectdesign.my" });
    const app = await buildApp({ config });
    const ctx = app.appContext;

    const out = await createOwner(ctx, { merchant: "Perfect Design", email: "Owner@PerfectDesign.my", currency: "myr", niche: "websites and web systems", address: "Kuala Lumpur, Malaysia" });

    const merchant = await ctx.db.merchants.require(out.merchantId);
    expect(merchant).toMatchObject({ name: "Perfect Design", defaultCurrency: "MYR", physicalAddress: "Kuala Lumpur, Malaysia" });
    const user = await ctx.db.users.require(out.userId);
    expect(user.email).toBe("owner@perfectdesign.my");
    expect(user.passwordHash).toBe(""); // nobody can sign in until the invite is accepted
    expect(out.inviteUrl).toMatch(/^https:\/\/partners\.perfectdesign\.my\/#\/accept-invite\?token=/);

    const token = new URL(out.inviteUrl.replace("#/", "")).searchParams.get("token")!;
    const accept = (password?: string) => app.inject({ method: "POST", url: "/auth/accept-invite", headers: json, payload: password ? { token, password } : { token } });
    expect((await accept()).statusCode).toBe(400); // a new account must choose a password
    const ok = await accept("owner-chosen-password");
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).data.merchants).toEqual([{ merchantId: out.merchantId, role: "owner" }]);
    expect((await accept("someone-else-password")).statusCode).toBe(401); // single use

    const login = await app.inject({ method: "POST", url: "/auth/login", headers: json, payload: { email: "owner@perfectdesign.my", password: "owner-chosen-password" } });
    expect(login.statusCode).toBe(200);
  });

  it("refuses an address that already has an account, and bad input", async () => {
    const ctx = createContext({ config: loadConfig(prodEnv()) });
    await createOwner(ctx, { merchant: "Perfect Design", email: "owner@perfectdesign.my" });
    await expect(createOwner(ctx, { merchant: "Again", email: "OWNER@perfectdesign.my" })).rejects.toThrow(/already exists/);
    await expect(createOwner(ctx, { merchant: "X", email: "not-an-email" })).rejects.toThrow(/not an email/);
    await expect(createOwner(ctx, { merchant: "X", email: "a@b.co", currency: "ringgit" })).rejects.toThrow(/3-letter/);
  });
});
