import { z } from "zod";
import { newId } from "@affiliate/core";
import { randomBytes } from "node:crypto";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { signJwt, verifyJwt, hashPassword, verifyPassword } from "../auth/jwt.js";
import { requirePrincipal } from "../auth/middleware.js";
import { badRequest, unauthorized, conflict } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import { publicUser } from "../sanitize.js";

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

  // ---- Accept a team invite (password-less invitee sets a password) ---------
  app.post("/auth/accept-invite", async (request, reply) => {
    const body = parseBody(loginSchema.extend({ password: z.string().min(8) }), request);
    const user = await ctx.db.users.findOne((u) => u.email.toLowerCase() === body.email.toLowerCase());
    if (!user) throw unauthorized("no pending invite for that email");
    if (user.passwordHash !== "") throw conflict("account already active — use sign in");
    await ctx.db.users.update(user.id, { passwordHash: hashPassword(body.password) });
    // Activate any invited memberships.
    const invited = await ctx.db.merchantUsers.find((m) => m.userId === user.id && m.status === "invited");
    for (const m of invited) await ctx.db.merchantUsers.update(m.id, { status: "active" });
    const token = signJwt({ sub: user.id, kind: "user", email: user.email }, ctx.config.jwtSecret);
    return ok(reply, { token, user: publicUser({ ...user, passwordHash: "" }), merchants: invited.map((m) => ({ merchantId: m.merchantId, role: m.role })) });
  });

  // ---- Affiliate portal login: MAGIC LINK (not email-only) ------------------
  // Knowing an affiliate's email must NOT grant a session. We email a short-lived,
  // single-purpose link to the affiliate's own inbox; only someone who controls
  // that inbox can complete login. Always returns 200 (no account enumeration).
  app.post("/auth/affiliate/request-link", async (request, reply) => {
    const body = parseBody(z.object({ email: z.string().email() }), request);
    const affiliate = await ctx.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === body.email.toLowerCase());
    if (affiliate) {
      // 15-minute, magic-only token — rejected by the session resolver.
      const magic = signJwt({ sub: affiliate.id, kind: "affiliate_magic", email: affiliate.primaryEmail }, ctx.config.jwtSecret, 900);
      const link = `${ctx.config.corsOrigins[0] ?? "http://localhost:5173"}/#/portal/verify?token=${magic}`;
      await ctx.transactionalMailer.send({
        from: "no-reply@vantage.dev",
        to: affiliate.primaryEmail,
        subject: "Your Vantage sign-in link",
        text: `Sign in to your affiliate portal: ${link}\n\nThis link expires in 15 minutes.`,
      });
      // Dev only: return the token so the demo can complete login without a real
      // inbox. Never exposed in production.
      if (ctx.config.exposeMagicLink) {
        return ok(reply, { sent: true, devToken: magic });
      }
    }
    return ok(reply, { sent: true });
  });

  // Exchange a magic-link token for a real portal session token.
  app.post("/auth/affiliate/verify", async (request, reply) => {
    const body = parseBody(z.object({ token: z.string() }), request);
    const claims = verifyJwt(body.token, ctx.config.jwtSecret);
    if (!claims || claims.kind !== "affiliate_magic") throw unauthorized("invalid or expired link");
    const affiliate = await ctx.db.affiliates.get(claims.sub);
    if (!affiliate) throw unauthorized("invalid link");
    const token = signJwt({ sub: affiliate.id, kind: "affiliate", email: affiliate.primaryEmail }, ctx.config.jwtSecret);
    return ok(reply, { token, affiliate: { id: affiliate.id, name: affiliate.name } });
  });

  // ---- Who am I -------------------------------------------------------------
  app.get("/auth/me", async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind === "user") {
      const user = await ctx.db.users.get(principal.userId!);
      const memberships = await ctx.db.merchantUsers.find((m) => m.userId === principal.userId && m.status === "active");
      // Never return passwordHash.
      return ok(reply, { kind: "user", user: user ? publicUser(user) : null, merchants: memberships.map((m) => ({ merchantId: m.merchantId, role: m.role })) });
    }
    if (principal.kind === "affiliate") {
      const affiliate = await ctx.db.affiliates.get(principal.affiliateId!);
      return ok(reply, { kind: "affiliate", affiliate });
    }
    return ok(reply, { kind: "apikey", scopes: principal.scopes });
  });

  void badRequest;
};
