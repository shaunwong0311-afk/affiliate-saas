import { z } from "zod";
import { newId } from "@affiliate/core";
import { randomBytes } from "node:crypto";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { signJwt, hashPassword, verifyPassword } from "../auth/jwt.js";
import { requirePrincipal } from "../auth/middleware.js";
import { badRequest, unauthorized, conflict } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  merchantName: z.string().min(1),
  niche: z.string().optional(),
});

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

export const authRoutes: RouteModule = (app, ctx) => {
  // ---- Merchant user signup → creates merchant, owner membership, trial -----
  app.post("/auth/signup", async (request, reply) => {
    const body = parseBody(signupSchema, request);
    const existing = await ctx.db.users.findOne((u) => u.email.toLowerCase() === body.email.toLowerCase());
    if (existing) throw conflict("email already registered");

    const now = ctx.clock.now().toISOString();
    const user = await ctx.db.users.insert({
      id: newId("usr"),
      email: body.email,
      name: body.name,
      passwordHash: hashPassword(body.password),
      createdAt: now,
    });

    const merchant = await ctx.db.merchants.insert({
      id: newId("mer"),
      name: body.merchantName,
      status: "trial",
      niche: body.niche ?? null,
      competitors: [],
      billingStatus: "trialing",
      defaultCurrency: "USD",
      postbackSecret: `whsec_${randomBytes(24).toString("hex")}`,
      physicalAddress: null,
      createdAt: now,
    });

    await ctx.db.merchantUsers.insert({
      id: newId("mu"),
      merchantId: merchant.id,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: "owner",
      status: "active",
    });

    await ctx.db.subscriptions.insert({
      id: newId("sub"),
      merchantId: merchant.id,
      plan: "track_export",
      status: "trialing",
      trialEndsAt: new Date(ctx.clock.now().getTime() + 14 * 86_400_000).toISOString(),
      renewsAt: null,
    });

    await writeAudit(ctx, { merchantId: merchant.id, actorId: user.id, action: "merchant.created", subjectType: "merchant", subjectId: merchant.id });

    const token = signJwt({ sub: user.id, kind: "user", email: user.email }, ctx.config.jwtSecret);
    return ok(reply, { token, user: { id: user.id, email: user.email, name: user.name }, merchant }, 201);
  });

  // ---- Login ----------------------------------------------------------------
  app.post("/auth/login", async (request, reply) => {
    const body = parseBody(loginSchema, request);
    const user = await ctx.db.users.findOne((u) => u.email.toLowerCase() === body.email.toLowerCase());
    if (!user || !verifyPassword(body.password, user.passwordHash)) throw unauthorized("invalid credentials");
    const memberships = await ctx.db.merchantUsers.find((m) => m.userId === user.id && m.status === "active");
    const token = signJwt({ sub: user.id, kind: "user", email: user.email }, ctx.config.jwtSecret);
    return ok(reply, {
      token,
      user: { id: user.id, email: user.email, name: user.name },
      merchants: memberships.map((m) => ({ merchantId: m.merchantId, role: m.role })),
    });
  });

  // ---- Affiliate portal token (demo: email-based; prod uses magic link) -----
  app.post("/auth/affiliate/token", async (request, reply) => {
    const body = parseBody(z.object({ email: z.string().email() }), request);
    const affiliate = await ctx.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === body.email.toLowerCase());
    if (!affiliate) throw unauthorized("no affiliate with that email");
    const token = signJwt({ sub: affiliate.id, kind: "affiliate", email: affiliate.primaryEmail }, ctx.config.jwtSecret);
    return ok(reply, { token, affiliate: { id: affiliate.id, name: affiliate.name } });
  });

  // ---- Who am I -------------------------------------------------------------
  app.get("/auth/me", async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind === "user") {
      const user = await ctx.db.users.get(principal.userId!);
      const memberships = await ctx.db.merchantUsers.find((m) => m.userId === principal.userId && m.status === "active");
      return ok(reply, { kind: "user", user, merchants: memberships.map((m) => ({ merchantId: m.merchantId, role: m.role })) });
    }
    if (principal.kind === "affiliate") {
      const affiliate = await ctx.db.affiliates.get(principal.affiliateId!);
      return ok(reply, { kind: "affiliate", affiliate });
    }
    return ok(reply, { kind: "apikey", scopes: principal.scopes });
  });

  void badRequest;
};
