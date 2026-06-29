import { z } from "zod";
import { newId } from "@affiliate/core";
import { detectMailProvider, SmtpSender, type MailboxCredentials } from "@affiliate/integrations";
import type { MerchantIntegration, Mailbox, SendingDomain } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";

/** Secret-store key for a mailbox's encrypted credentials (never stored in the row). */
const credsRef = (mailboxId: string) => `mailbox:${mailboxId}:creds`;

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

  // ---- Smart Connect: detect the easiest connection method from the email ----
  app.post("/mailboxes/detect", async (request, reply) => {
    await requireMerchant(ctx, request, "admin");
    const body = parseBody(z.object({ email: z.string().email() }), request);
    return ok(reply, await detectMailProvider(body.email));
  });

  // Store SMTP/app-password credentials (encrypted in the SecretStore) + live-test them.
  app.post("/mailboxes/:id/credentials/smtp", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    const body = parseBody(
      z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        user: z.string().min(1),
        pass: z.string().min(1),
        secure: z.boolean().optional(),
        imapHost: z.string().optional(),
        imapPort: z.number().int().min(1).max(65535).optional(),
      }),
      request,
    );
    const creds: MailboxCredentials = {
      kind: "smtp",
      host: body.host,
      port: body.port,
      user: body.user,
      pass: body.pass,
      secure: body.secure,
      imapHost: body.imapHost,
      imapPort: body.imapPort,
    };
    const ref = credsRef(id);
    await ctx.secrets.put(ref, JSON.stringify(creds));
    const test = await new SmtpSender({ host: body.host, port: body.port, user: body.user, pass: body.pass, secure: body.secure }).verify();
    const updated = await ctx.db.mailboxes.update(id, {
      provider: "smtp",
      credentialsRef: ref,
      status: test.ok ? "connected" : "error",
    });
    await writeAudit(ctx, { merchantId, actorId: null, action: "mailbox.connected", subjectType: "mailbox", subjectId: id, metadata: { provider: "smtp", ok: test.ok } });
    return ok(reply, { mailbox: updated, test });
  });

  // Re-test a connected mailbox (the "Test connection" button).
  app.post("/mailboxes/:id/test", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    if (!mailbox.credentialsRef) return ok(reply, { ok: false, reason: "no credentials connected" });
    const raw = await ctx.secrets.get(mailbox.credentialsRef);
    if (!raw) return ok(reply, { ok: false, reason: "credentials missing" });
    const creds = JSON.parse(raw) as MailboxCredentials;
    if (creds.kind === "smtp" && creds.host && creds.port && creds.user && creds.pass != null) {
      const test = await new SmtpSender({ host: creds.host, port: creds.port, user: creds.user, pass: creds.pass, secure: creds.secure }).verify();
      await ctx.db.mailboxes.update(id, { status: test.ok ? "connected" : "error" });
      return ok(reply, test);
    }
    return ok(reply, { ok: mailbox.status === "connected" });
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

  // REAL DNS verification — fails closed. We perform actual TXT lookups and only
  // mark a record verified when it genuinely exists; we never claim "verified"
  // without checking. (DKIM needs a selector to look up, so it stays pending until
  // a selector is configured.)
  app.post("/sending-domains/:id/verify", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const domain = await ctx.db.sendingDomains.get(id);
    if (!domain || domain.merchantId !== merchantId) throw notFound("sending domain");

    const spfOk = await hasTxtRecord(domain.domain, (v) => v.toLowerCase().startsWith("v=spf1"));
    const dmarcOk = await hasTxtRecord(`_dmarc.${domain.domain}`, (v) => v.toLowerCase().startsWith("v=dmarc1"));

    const updated = await ctx.db.sendingDomains.update(id, {
      spfStatus: spfOk ? "verified" : "failed",
      dmarcStatus: dmarcOk ? "verified" : "failed",
      // DKIM verification requires the selector; not configured → remains pending.
      dkimStatus: "pending",
    });
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "sending_domain.verify_attempted",
      subjectType: "sending_domain",
      subjectId: id,
      metadata: { spfOk, dmarcOk },
    });
    return ok(reply, updated);
  });
};

/** Real DNS TXT lookup. Returns false on any error (fail closed). */
async function hasTxtRecord(host: string, predicate: (value: string) => boolean): Promise<boolean> {
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.resolveTxt(host);
    return records.some((chunks) => predicate(chunks.join("")));
  } catch {
    return false;
  }
}
