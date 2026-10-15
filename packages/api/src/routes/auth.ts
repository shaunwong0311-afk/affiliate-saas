import { z } from "zod";
import { newId } from "@affiliate/core";
import { randomBytes } from "node:crypto";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { signJwt, hashPassword, verifyPasswordOrDummy } from "../auth/jwt.js";
import { acceptTeamInvite } from "../auth/invite.js";
import { mintSignInMagicLink, redeemMagicLinkToken, SIGN_IN_LINK_TTL_SECONDS } from "../auth/magic-link.js";
import { requirePrincipal } from "../auth/middleware.js";
import { HttpError, badRequest, unauthorized, conflict } from "../errors.js";
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
    // Same scrypt work whether or not the account exists — response time must not reveal
    // which emails are registered.
    const passwordOk = verifyPasswordOrDummy(body.password, user?.passwordHash);
    if (!user || !passwordOk) throw unauthorized("invalid credentials");
    const memberships = await ctx.db.merchantUsers.find((m) => m.userId === user.id && m.status === "active");
    const token = signJwt({ sub: user.id, kind: "user", email: user.email }, ctx.config.jwtSecret);
    return ok(reply, {
      token,
      user: { id: user.id, email: user.email, name: user.name },
      merchants: memberships.map((m) => ({ merchantId: m.merchantId, role: m.role })),
    });
  });

  // ---- Accept a team invite ------------------------------------------------
  // Requires the single-use token from the invitation email (`{app}/#/accept-invite?token=…`,
  // minted when the invite is created — routes/merchants.ts). An email address proves nothing:
  // it used to be all this route asked for, so anyone who knew an invitee's address could set
  // the password of their pending account and take the role granted with it.
  //   new account      → { token, password }        (sets the first password)
  //   existing account → { token } + its own Bearer session
  // A genuine token that still lacks its second half is NOT consumed: the answer says what is
  // missing (400 password_required / 401 sign_in_required) and the caller tries again.
  app.post("/auth/accept-invite", async (request, reply) => {
    const body = parseBody(z.object({ token: z.string().min(1), password: z.string().min(8).optional() }), request);
    const sessionUserId = request.principal?.kind === "user" ? (request.principal.userId ?? null) : null;
    const result = await acceptTeamInvite(ctx, body.token, { password: body.password, sessionUserId });
    if (result.status === "password_required") throw new HttpError(400, "choose a password (at least 8 characters) to accept this invitation", "password_required");
    if (result.status === "sign_in_required") throw new HttpError(401, "sign in to the invited account to accept this invitation", "sign_in_required");
    if (result.status !== "accepted") throw unauthorized("invalid or expired invitation");
    const { user, membership } = result;
    await writeAudit(ctx, { merchantId: membership.merchantId, actorId: user.id, action: "merchant.user_invite_accepted", subjectType: "merchant_user", subjectId: membership.id });
    const token = signJwt({ sub: user.id, kind: "user", email: user.email }, ctx.config.jwtSecret);
    return ok(reply, { token, user: publicUser(user), merchants: [{ merchantId: membership.merchantId, role: membership.role }] });
  });

  // ---- Affiliate portal login: MAGIC LINK (not email-only) ------------------
  // Knowing an affiliate's email must NOT grant a session. We email a short-lived,
  // SINGLE-USE link to the affiliate's own inbox; only someone who controls that inbox
  // can complete login. Always returns 200 (no account enumeration).
  app.post("/auth/affiliate/request-link", async (request, reply) => {
    const body = parseBody(z.object({ email: z.string().email() }), request);
    const affiliate = await ctx.db.affiliates.findOne((a) => a.primaryEmail.toLowerCase() === body.email.toLowerCase());
    // Null when this affiliate already holds the maximum number of unused sign-in links:
    // nothing is minted or mailed (the public form cannot be used to mail-bomb them).
    const magic = affiliate ? await mintSignInMagicLink(ctx, affiliate) : null;
    if (affiliate && magic) {
      await ctx.transactionalMailer.send({
        to: affiliate.primaryEmail,
        subject: "Your Vantage sign-in link",
        text: `Sign in to your affiliate portal: ${magic.url}\n\nThis link works once and expires in ${SIGN_IN_LINK_TTL_SECONDS / 60} minutes.`,
      });
      // Dev only: return the token so the demo can complete login without a real
      // inbox. Never exposed in production.
      if (ctx.config.exposeMagicLink) {
        return ok(reply, { sent: true, devToken: magic.token });
      }
    }
    return ok(reply, { sent: true });
  });

  // Exchange a magic-link token for a real portal session token — ONCE. Every failure
  // (bad signature, expired, already used, unknown affiliate) is the same 401, on which
  // the portal shows its "send me a new link" form.
  app.post("/auth/affiliate/verify", async (request, reply) => {
    const body = parseBody(z.object({ token: z.string() }), request);
    const affiliate = await redeemMagicLinkToken(ctx, body.token);
    if (!affiliate) throw unauthorized("invalid or expired link");
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
      // A support session says so: the portal shows a read-only banner and whose view it is.
      return ok(reply, { kind: "affiliate", affiliate, ...(principal.impersonation ? { impersonation: principal.impersonation } : {}) });
    }
    return ok(reply, { kind: "apikey", scopes: principal.scopes });
  });

  void badRequest;
};
