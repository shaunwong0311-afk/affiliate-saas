import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Merchant, MerchantUser, User } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant, requirePrincipal } from "../auth/middleware.js";
import { mintTeamInvite, TEAM_INVITE_TTL_SECONDS } from "../auth/invite.js";
import { enforceEmailRateLimit, enforceRateLimit, TEAM_INVITE_PER_EMAIL_LIMIT, TEAM_INVITE_PER_MERCHANT_LIMIT } from "../auth/rate-limit.js";
import { ROLE_RANK } from "../auth/rbac.js";
import { notFound, forbidden, conflict } from "../errors.js";
import { writeAudit, actorIdOf } from "../services/audit.js";
import { publicMerchant } from "../sanitize.js";
import type { MerchantRole } from "@affiliate/db";

/** A caller may never grant a role above their own rank (no privilege escalation). */
function assertCanGrant(callerRole: MerchantRole, target: MerchantRole): void {
  if (ROLE_RANK[target] > ROLE_RANK[callerRole]) {
    throw forbidden(`role "${callerRole}" cannot grant the higher role "${target}"`);
  }
}

const merchantPatchSchema = z.object({
  name: z.string().min(1).optional(),
  niche: z.string().nullish(),
  competitors: z.array(z.string()).optional(),
  physicalAddress: z.string().nullish(),
  defaultCurrency: z.string().length(3).optional(),
  bookingUrl: z.string().url().nullish(),
});

const addUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]),
});

const patchUserSchema = z.object({
  role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]).optional(),
  status: z.enum(["active", "invited", "disabled"]).optional(),
});

export const merchantRoutes: RouteModule = (app, ctx) => {
  // ---- List merchants the current user belongs to ---------------------------
  app.get("/merchants", async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== "user") return ok(reply, []);
    const memberships = await ctx.db.merchantUsers.find(
      (m) => m.userId === principal.userId && m.status === "active",
    );
    const merchants: Merchant[] = [];
    for (const m of memberships) {
      const merchant = await ctx.db.merchants.get(m.merchantId);
      if (merchant) merchants.push(merchant);
    }
    return ok(reply, merchants.map(publicMerchant));
  });

  // ---- Single merchant (postbackSecret redacted) ----------------------------
  app.get("/merchants/:merchantId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    return ok(reply, publicMerchant(merchant));
  });

  // The postback secret is sensitive — only admins+ can reveal it.
  app.get("/merchants/:merchantId/postback-secret", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    return ok(reply, { postbackSecret: merchant.postbackSecret });
  });

  app.patch("/merchants/:merchantId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    const body = parseBody(merchantPatchSchema, request);
    const patch: Partial<Merchant> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.niche !== undefined) patch.niche = body.niche ?? null;
    if (body.competitors !== undefined) patch.competitors = body.competitors;
    if (body.physicalAddress !== undefined) patch.physicalAddress = body.physicalAddress ?? null;
    if (body.defaultCurrency !== undefined) patch.defaultCurrency = body.defaultCurrency.toUpperCase();
    if (body.bookingUrl !== undefined) patch.bookingUrl = body.bookingUrl ?? null;
    const updated = await ctx.db.merchants.update(merchantId, patch);
    await writeAudit(ctx, {
      merchantId,
      actorId: actorIdOf(request),
      action: "merchant.updated",
      subjectType: "merchant",
      subjectId: merchantId,
      metadata: patch,
    });
    return ok(reply, publicMerchant(updated));
  });

  // ---- Rotate postback secret -----------------------------------------------
  app.post("/merchants/:merchantId/rotate-postback-secret", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "owner");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    const postbackSecret = "whsec_" + newId();
    await ctx.db.merchants.update(merchantId, { postbackSecret });
    await writeAudit(ctx, {
      merchantId,
      actorId: actorIdOf(request),
      action: "merchant.postback_secret_rotated",
      subjectType: "merchant",
      subjectId: merchantId,
    });
    return ok(reply, { postbackSecret });
  });

  // ---- Team -----------------------------------------------------------------
  app.get("/merchants/:merchantId/users", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const members = await ctx.db.merchantUsers.find((m) => m.merchantId === merchantId);
    return ok(reply, members);
  });

  app.post("/merchants/:merchantId/users", async (request, reply) => {
    const { merchantId, role: callerRole } = await requireMerchant(ctx, request, "admin");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    const body = parseBody(addUserSchema, request);
    assertCanGrant(callerRole, body.role);
    const email = body.email.toLowerCase();

    // (Case-insensitive, like login: signup keeps the address as typed, and a second row for
    // the same inbox must never be created.)
    let user = await ctx.db.users.findOne((u) => u.email.toLowerCase() === email);
    let membership = user
      ? await ctx.db.merchantUsers.findOne((m) => m.merchantId === merchantId && m.userId === user!.id)
      : null;
    // This route also UPDATES an existing member, so the PATCH rule applies here too: a
    // member who outranks the caller cannot be touched (an admin re-adding the owner's
    // address as "viewer" would otherwise demote the owner).
    if (membership && ROLE_RANK[membership.role] > ROLE_RANK[callerRole]) throw forbidden("cannot modify a higher-ranked member");

    // Only someone who is ALREADY an accepted member stays active (this call is then just a
    // role / name update). Everyone else — a new address, a pending account, and also an
    // existing account that is not yet a member — is `invited` and becomes active only by
    // redeeming the emailed link (auth/invite.ts). An existing account is NOT added on the
    // spot: signup verifies nothing, so whoever registered an address first would otherwise
    // receive the role meant for the person who owns that inbox.
    const alreadyMember = !!user && user.passwordHash !== "" && membership?.status === "active";
    const memberStatus: MerchantUser["status"] = alreadyMember ? "active" : "invited";

    // Every invitation sends an email to an address the inviter chose: bound how often one
    // merchant, and one address, can cause mail.
    if (!alreadyMember) {
      enforceRateLimit(app.rateLimiter, `team-invite-merchant|${merchantId}`, TEAM_INVITE_PER_MERCHANT_LIMIT);
      enforceEmailRateLimit(app.rateLimiter, "team-invite-email", email, TEAM_INVITE_PER_EMAIL_LIMIT);
    }
    if (!user) {
      const created: User = {
        id: newId("user"),
        email,
        name: body.name,
        passwordHash: "", // set when the invitee accepts via /auth/accept-invite (token required)
        createdAt: ctx.clock.now().toISOString(),
      };
      await ctx.db.users.insert(created);
      user = created;
    }

    if (membership) {
      membership = await ctx.db.merchantUsers.update(membership.id, {
        role: body.role,
        status: memberStatus,
        name: body.name,
        email,
      });
    } else {
      const newMembership: MerchantUser = {
        id: newId("muser"),
        merchantId,
        userId: user.id,
        email,
        name: body.name,
        role: body.role,
        status: memberStatus,
      };
      await ctx.db.merchantUsers.insert(newMembership);
      membership = newMembership;
    }

    // The invitee proves they own the address by opening a single-use link sent TO it. The
    // token is never returned in production; outside it, `devInviteToken` lets the flow run
    // without an inbox.
    let inviteSent = false;
    let devInviteToken: string | undefined;
    if (!alreadyMember) {
      const invite = await mintTeamInvite(ctx, user, merchantId);
      const merchantName = merchant.name.replace(/[\r\n]+/g, " ").slice(0, 80);
      const delivery = await ctx.transactionalMailer
        .send({
          to: user.email,
          subject: `You have been invited to ${merchantName} on Vantage`,
          text:
            `You have been invited to join ${merchantName} on Vantage as ${body.role}.\n\n` +
            `Accept the invitation: ${invite.url}\n\n` +
            `You will be asked to choose a password, or to sign in if you already have an account. ` +
            `This link works once and expires in ${TEAM_INVITE_TTL_SECONDS / 86_400} days. If you were not expecting it, ignore this email.`,
        })
        .catch(() => null);
      inviteSent = delivery?.status === "sent";
      if (ctx.config.exposeMagicLink) devInviteToken = invite.token;
    }

    await writeAudit(ctx, {
      merchantId,
      actorId: actorIdOf(request),
      action: "merchant.user_added",
      subjectType: "merchant_user",
      subjectId: membership.id,
      metadata: { userId: user.id, role: body.role, invited: !alreadyMember, inviteSent },
    });
    return ok(reply, { ...membership, inviteSent, ...(devInviteToken ? { devInviteToken } : {}) }, 201);
  });

  app.patch("/merchants/:merchantId/users/:userId", async (request, reply) => {
    const { merchantId, role: callerRole } = await requireMerchant(ctx, request, "admin");
    const userId = (request.params as { userId: string }).userId;
    const membership = await ctx.db.merchantUsers.findOne(
      (m) => m.merchantId === merchantId && m.userId === userId,
    );
    if (!membership) throw notFound("merchant user");
    const body = parseBody(patchUserSchema, request);
    // Block escalation: cannot assign a role above the caller's own rank, and
    // cannot edit a member who already outranks the caller.
    if (ROLE_RANK[membership.role] > ROLE_RANK[callerRole]) throw forbidden("cannot modify a higher-ranked member");
    const patch: Partial<MerchantUser> = {};
    if (body.role !== undefined) {
      assertCanGrant(callerRole, body.role);
      patch.role = body.role;
    }
    // A membership becomes active ONLY by its invitee accepting the emailed invitation —
    // never by an edit here (that would hand the role to whoever holds the account, proof or
    // not). To bring back a disabled member, invite them again.
    if (body.status === "active" && membership.status !== "active") {
      throw conflict("a member becomes active by accepting an invitation — send the invitation again instead");
    }
    if (body.status !== undefined) patch.status = body.status;
    const updated = await ctx.db.merchantUsers.update(membership.id, patch);
    await writeAudit(ctx, {
      merchantId,
      actorId: actorIdOf(request),
      action: "merchant.user_updated",
      subjectType: "merchant_user",
      subjectId: membership.id,
      metadata: patch,
    });
    return ok(reply, updated);
  });
};
