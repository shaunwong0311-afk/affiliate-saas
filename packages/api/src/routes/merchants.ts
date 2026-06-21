import { z } from "zod";
import { newId } from "@affiliate/core";
import type { Merchant, MerchantUser, User } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant, requirePrincipal } from "../auth/middleware.js";
import { ROLE_RANK } from "../auth/rbac.js";
import { notFound, forbidden } from "../errors.js";
import { writeAudit } from "../services/audit.js";
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
    const updated = await ctx.db.merchants.update(merchantId, patch);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
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
      actorId: null,
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

    let user = await ctx.db.users.findOne((u) => u.email === email);
    const isNewUser = !user;
    if (!user) {
      const created: User = {
        id: newId("user"),
        email,
        name: body.name,
        passwordHash: "", // set when the invitee accepts via /auth/accept-invite
        createdAt: ctx.clock.now().toISOString(),
      };
      await ctx.db.users.insert(created);
      user = created;
    }

    // A brand-new (password-less) invitee is `invited` until they accept and set a
    // password; an existing real user is added as `active`.
    const memberStatus: MerchantUser["status"] = isNewUser && user.passwordHash === "" ? "invited" : "active";

    let membership = await ctx.db.merchantUsers.findOne(
      (m) => m.merchantId === merchantId && m.userId === user!.id,
    );
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

    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "merchant.user_added",
      subjectType: "merchant_user",
      subjectId: membership.id,
      metadata: { userId: user.id, role: body.role },
    });
    return ok(reply, membership, 201);
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
    if (body.status !== undefined) patch.status = body.status;
    const updated = await ctx.db.merchantUsers.update(membership.id, patch);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "merchant.user_updated",
      subjectType: "merchant_user",
      subjectId: membership.id,
      metadata: patch,
    });
    return ok(reply, updated);
  });
};
