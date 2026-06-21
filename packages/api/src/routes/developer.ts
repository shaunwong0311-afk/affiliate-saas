import { z } from "zod";
import { newId } from "@affiliate/core";
import type { ApiKey, WebhookSubscription } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound, badRequest } from "../errors.js";
import { generateApiKey } from "../auth/jwt.js";
import { writeAudit } from "../services/audit.js";
import { isPublicWebhookUrl } from "../services/webhooks.js";

/**
 * Section 9 — Developer surface: scoped API keys and outbound webhook
 * subscriptions. Plaintext API keys are returned exactly once on creation; we
 * only ever persist the hashed form and never expose `hashedKey` on reads.
 */
export const developerRoutes: RouteModule = (app, ctx) => {
  // ---- API keys -------------------------------------------------------------
  app.get("/developer/api-keys", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const keys = await ctx.db.apiKeys.find((k) => k.merchantId === merchantId);
    const safe = keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    }));
    return ok(reply, safe);
  });

  app.post("/developer/api-keys", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(
      z.object({
        name: z.string().min(1),
        scopes: z.array(z.string()).default(["read"]),
      }),
      request,
    );
    const { plaintext, prefix, hashed } = generateApiKey();
    const key: ApiKey = {
      id: newId("ak"),
      merchantId,
      name: body.name,
      prefix,
      hashedKey: hashed,
      scopes: body.scopes,
      lastUsedAt: null,
      createdAt: ctx.clock.now().toISOString(),
      revokedAt: null,
    };
    await ctx.db.apiKeys.insert(key);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "api_key.created",
      subjectType: "api_key",
      subjectId: key.id,
      metadata: { scopes: key.scopes },
    });
    return ok(reply, { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, key: plaintext }, 201);
  });

  app.delete("/developer/api-keys/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const key = await ctx.db.apiKeys.get(id);
    if (!key || key.merchantId !== merchantId) throw notFound("api key");
    const updated = await ctx.db.apiKeys.update(id, { revokedAt: ctx.clock.now().toISOString() });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "api_key.revoked",
      subjectType: "api_key",
      subjectId: id,
    });
    return ok(reply, updated);
  });

  // ---- Webhook subscriptions ------------------------------------------------
  app.get("/developer/webhooks", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const subs = await ctx.db.webhookSubscriptions.find((w) => w.merchantId === merchantId);
    return ok(reply, subs);
  });

  app.post("/developer/webhooks", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(
      z.object({
        url: z.string().url(),
        events: z.array(z.string()).min(1),
      }),
      request,
    );
    // SSRF: reject internal/private webhook targets at creation time.
    if (!isPublicWebhookUrl(body.url)) throw badRequest("webhook url must be a public http(s) endpoint");
    const sub: WebhookSubscription = {
      id: newId("whs"),
      merchantId,
      url: body.url,
      events: body.events,
      secret: "whsec_" + newId(),
      status: "active",
    };
    await ctx.db.webhookSubscriptions.insert(sub);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "webhook.created",
      subjectType: "webhook_subscription",
      subjectId: sub.id,
    });
    return ok(reply, sub, 201);
  });

  app.patch("/developer/webhooks/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const sub = await ctx.db.webhookSubscriptions.get(id);
    if (!sub || sub.merchantId !== merchantId) throw notFound("webhook subscription");
    const body = parseBody(
      z.object({
        url: z.string().url().optional(),
        events: z.array(z.string()).min(1).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      }),
      request,
    );
    const updated = await ctx.db.webhookSubscriptions.update(id, body as Partial<WebhookSubscription>);
    return ok(reply, updated);
  });

  app.delete("/developer/webhooks/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const sub = await ctx.db.webhookSubscriptions.get(id);
    if (!sub || sub.merchantId !== merchantId) throw notFound("webhook subscription");
    await ctx.db.webhookSubscriptions.delete(id);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "webhook.deleted",
      subjectType: "webhook_subscription",
      subjectId: id,
    });
    return ok(reply, { id, deleted: true });
  });

  // ---- Webhook deliveries (observability) -----------------------------------
  app.get("/developer/webhook-deliveries", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const deliveries = await ctx.db.webhookDeliveries.find((d) => d.merchantId === merchantId);
    deliveries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return ok(reply, deliveries);
  });
};
