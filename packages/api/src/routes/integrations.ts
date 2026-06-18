import { z } from "zod";
import { newId } from "@affiliate/core";
import type { MerchantIntegration, Mailbox, SendingDomain } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";

const integrationCreateSchema = z.object({
  kind: z.enum(["shopify", "woocommerce", "stripe", "s2s", "klaviyo", "hubspot", "chargebee", "recurly"]),
  config: z.record(z.unknown()).optional(),
  credentialsRef: z.string().optional(),
});

const integrationPatchSchema = z.object({
  status: z.enum(["connected", "error", "disconnected"]).optional(),
  config: z.record(z.unknown()).optional(),
});

const mailboxCreateSchema = z.object({
  provider: z.enum(["gmail", "microsoft", "smtp"]),
  email: z.string().email(),
  dailyCap: z.number().int().min(1).default(50),
});

const mailboxPatchSchema = z.object({
  status: z.enum(["connected", "warming", "error", "disconnected"]).optional(),
  dailyCap: z.number().int().min(1).optional(),
  warmupStatus: z.enum(["not_started", "warming", "ready"]).optional(),
});

const domainCreateSchema = z.object({
  domain: z.string().min(1),
});

export const integrationRoutes: RouteModule = (app, ctx) => {
  // ---- Integrations ---------------------------------------------------------
  app.get("/integrations", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const integrations = await ctx.db.integrations.find((i) => i.merchantId === merchantId);
    return ok(reply, integrations);
  });

  app.post("/integrations", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(integrationCreateSchema, request);
    const integration: MerchantIntegration = {
      id: newId("int"),
      merchantId,
      kind: body.kind,
      status: "connected",
      credentialsRef: body.credentialsRef ?? "",
      config: {},
      lastSyncAt: null,
    };
    await ctx.db.integrations.insert(integration);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "integration.created",
      subjectType: "integration",
      subjectId: integration.id,
      metadata: { kind: integration.kind },
    });
    return ok(reply, integration, 201);
  });

  app.patch("/integrations/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const integration = await ctx.db.integrations.get(id);
    if (!integration || integration.merchantId !== merchantId) throw notFound("integration");
    const body = parseBody(integrationPatchSchema, request);
    const updated = await ctx.db.integrations.update(id, body as Partial<MerchantIntegration>);
    return ok(reply, updated);
  });

  app.delete("/integrations/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const integration = await ctx.db.integrations.get(id);
    if (!integration || integration.merchantId !== merchantId) throw notFound("integration");
    await ctx.db.integrations.delete(id);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "integration.deleted",
      subjectType: "integration",
      subjectId: id,
    });
    return ok(reply, { id, deleted: true });
  });

  // ---- Mailboxes ------------------------------------------------------------
  app.get("/mailboxes", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const mailboxes = await ctx.db.mailboxes.find((m) => m.merchantId === merchantId);
    return ok(reply, mailboxes);
  });

  app.post("/mailboxes", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(mailboxCreateSchema, request);
    const mailbox: Mailbox = {
      id: newId("mbx"),
      merchantId,
      provider: body.provider,
      email: body.email,
      status: "connected",
      dailyCap: body.dailyCap,
      warmupStatus: "not_started",
      credentialsRef: "",
    };
    await ctx.db.mailboxes.insert(mailbox);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "mailbox.created",
      subjectType: "mailbox",
      subjectId: mailbox.id,
      metadata: { provider: mailbox.provider, email: mailbox.email },
    });
    return ok(reply, mailbox, 201);
  });

  app.patch("/mailboxes/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    const body = parseBody(mailboxPatchSchema, request);
    const updated = await ctx.db.mailboxes.update(id, body as Partial<Mailbox>);
    return ok(reply, updated);
  });

  app.delete("/mailboxes/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    await ctx.db.mailboxes.delete(id);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "mailbox.deleted",
      subjectType: "mailbox",
      subjectId: id,
    });
    return ok(reply, { id, deleted: true });
  });

  // ---- Sending domains ------------------------------------------------------
  app.get("/sending-domains", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const domains = await ctx.db.sendingDomains.find((d) => d.merchantId === merchantId);
    return ok(reply, domains);
  });

  app.post("/sending-domains", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const body = parseBody(domainCreateSchema, request);
    const domain: SendingDomain = {
      id: newId("dom"),
      merchantId,
      domain: body.domain,
      spfStatus: "pending",
      dkimStatus: "pending",
      dmarcStatus: "pending",
      warmupStatus: "not_started",
    };
    await ctx.db.sendingDomains.insert(domain);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "sending_domain.created",
      subjectType: "sending_domain",
      subjectId: domain.id,
      metadata: { domain: domain.domain },
    });
    return ok(reply, domain, 201);
  });

  app.post("/sending-domains/:id/verify", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const domain = await ctx.db.sendingDomains.get(id);
    if (!domain || domain.merchantId !== merchantId) throw notFound("sending domain");
    const updated = await ctx.db.sendingDomains.update(id, {
      spfStatus: "verified",
      dkimStatus: "verified",
      dmarcStatus: "verified",
    });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "sending_domain.verified",
      subjectType: "sending_domain",
      subjectId: id,
    });
    return ok(reply, updated);
  });
};
