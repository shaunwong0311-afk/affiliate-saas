import { z } from "zod";
import type { Affiliate } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, parseQuery, ok, paginationSchema, paginate } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { signJwt } from "../auth/jwt.js";
import { writeAudit } from "../services/audit.js";

/**
 * Admin / governance surface (Section 9). Every handler is merchant-scoped and
 * tenant-isolated: rows are fetched against `merchantId` and any cross-tenant
 * affiliate access is gated through an active relationship lookup.
 */
export const adminRoutes: RouteModule = (app, ctx) => {
  // ---- Audit trail ----------------------------------------------------------
  app.get("/admin/audit-logs", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const q = parseQuery(paginationSchema, request);
    const logs = await ctx.db.auditLogs.find((l) => l.merchantId === merchantId);
    logs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return ok(reply, paginate(logs, q));
  });

  // ---- Role management ------------------------------------------------------
  app.patch("/admin/users/:userId/role", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "owner");
    const userId = (request.params as { userId: string }).userId;
    const body = parseBody(
      z.object({ role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]) }),
      request,
    );
    const membership = await ctx.db.merchantUsers.findOne(
      (m) => m.merchantId === merchantId && m.userId === userId,
    );
    if (!membership) throw notFound("membership");
    const updated = await ctx.db.merchantUsers.update(membership.id, { role: body.role });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "user.role_changed",
      subjectType: "merchantUser",
      subjectId: membership.id,
      metadata: { userId, role: body.role },
    });
    return ok(reply, updated);
  });

  // ---- Impersonation (support tooling) --------------------------------------
  app.post("/admin/impersonate/:affiliateId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "owner");
    const affiliateId = (request.params as { affiliateId: string }).affiliateId;
    const affiliate = await ctx.db.affiliates.get(affiliateId);
    if (!affiliate) throw notFound("affiliate");
    const relationship = await ctx.db.relationships.findOne(
      (r) => r.affiliateId === affiliateId && r.merchantId === merchantId,
    );
    if (!relationship) throw notFound("affiliate");
    const token = signJwt(
      { sub: affiliateId, kind: "affiliate", email: affiliate.primaryEmail },
      ctx.config.jwtSecret,
    );
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "affiliate.impersonated",
      subjectType: "affiliate",
      subjectId: affiliateId,
    });
    return ok(reply, { token });
  });

  // ---- Tenant data export ---------------------------------------------------
  app.get("/admin/export", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    const [programs, offers, relationships, conversions, ledger, prospects] = await Promise.all([
      ctx.db.programs.find((p) => p.merchantId === merchantId),
      ctx.db.offers.find((o) => o.merchantId === merchantId),
      ctx.db.relationships.find((r) => r.merchantId === merchantId),
      ctx.db.conversions.count((c) => c.merchantId === merchantId),
      ctx.db.ledger.count((e) => e.merchantId === merchantId),
      ctx.db.prospects.count((p) => p.merchantId === merchantId),
    ]);
    return ok(reply, {
      merchant,
      programs,
      offers,
      relationships,
      conversions,
      ledger,
      prospects,
    });
  });

  // ---- GDPR data deletion (PII redaction) -----------------------------------
  app.post("/admin/data-delete", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "owner");
    const body = parseBody(z.object({ affiliateId: z.string().min(1) }), request);
    const affiliate = await ctx.db.affiliates.get(body.affiliateId);
    if (!affiliate) throw notFound("affiliate");
    const relationships = await ctx.db.relationships.find((r) => r.affiliateId === body.affiliateId);
    const mine = relationships.filter((r) => r.merchantId === merchantId);
    if (mine.length === 0) throw notFound("affiliate");

    // Remove THIS merchant's relationships + per-merchant CRM data for the affiliate.
    for (const rel of mine) {
      for (const n of await ctx.db.affiliateNotes.find((x) => x.relationshipId === rel.id)) await ctx.db.affiliateNotes.delete(n.id);
      for (const t of await ctx.db.affiliateTasks.find((x) => x.relationshipId === rel.id)) await ctx.db.affiliateTasks.delete(t.id);
      for (const m of await ctx.db.affiliateMessages.find((x) => x.relationshipId === rel.id)) await ctx.db.affiliateMessages.delete(m.id);
      await ctx.db.relationships.delete(rel.id);
    }

    // The affiliate is a GLOBAL identity. Only redact the shared profile when no
    // OTHER merchant still has a relationship with them — otherwise redacting would
    // corrupt other tenants' data.
    const others = relationships.filter((r) => r.merchantId !== merchantId);
    const globallyRedacted = others.length === 0;
    if (globallyRedacted) {
      await ctx.db.affiliates.update(body.affiliateId, {
        name: "[deleted]",
        primaryEmail: "deleted+" + body.affiliateId + "@redacted.invalid",
        status: "banned",
      } as Partial<Affiliate>);
    }
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "affiliate.data_deleted",
      subjectType: "affiliate",
      subjectId: body.affiliateId,
      metadata: { globallyRedacted, relationshipsRemoved: mine.length },
    });
    return ok(reply, { deleted: true, globallyRedacted });
  });
};
