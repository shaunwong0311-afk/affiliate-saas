import { z } from "zod";
import { newId } from "@affiliate/core";
import { detectMailProvider, SmtpSender, buildConsentUrl, exchangeCode, type MailboxCredentials } from "@affiliate/integrations";
import type { MerchantIntegration, Mailbox, SendingDomain } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { badRequest, notFound } from "../errors.js";
import { writeAudit } from "../services/audit.js";
import { oauthProviderFor, signOAuthState, verifyOAuthState, newOAuthNonce, type OAuthProviderName } from "../services/oauth.js";
import { inboundState, ingestReplies } from "@affiliate/recruitment";

/** Secret-store key for a mailbox's encrypted credentials (never stored in the row). */
const credsRef = (mailboxId: string) => `mailbox:${mailboxId}:creds`;

/** Why a rail has no inbound path at all (set at connect time; the reply poller says the same). */
const NO_IMAP = "no IMAP server is set for this mailbox, so replies and STOP requests cannot be read — add its IMAP settings to enable follow-ups";
const GMAIL_OAUTH_NO_INBOUND = "reading replies is not built yet for Gmail connected with Google sign-in — connect this mailbox with an app password (SMTP + IMAP) to enable follow-ups";

/**
 * A mailbox row as the API returns it: plus `inbound` — whether replies to it are being read
 * and, when not, why — and `followUpsOnHold`, so the UI can warn that automated follow-ups are
 * paused for it (AUDIT-2026-10 O5). The in-flight OAuth nonce is never returned.
 */
function presentMailbox(mailbox: Mailbox, now: Date) {
  const { oauthNonce: _nonce, ...row } = mailbox;
  const inbound = inboundState(mailbox);
  const backingOff = !!mailbox.sendBackoffUntil && new Date(mailbox.sendBackoffUntil).getTime() > now.getTime();
  return { ...row, inbound, followUpsOnHold: !inbound.working, sendingOnHold: backingOff };
}

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
    const now = ctx.clock.now();
    return ok(reply, mailboxes.map((m) => presentMailbox(m, now)));
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
    return ok(reply, presentMailbox(updated, ctx.clock.now()));
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
    // On a successful connect, start the warmup clock (not_started → warming) so the ramp +
    // graduation schedule begins; clear any prior auto-pause and any failure backoff.
    const startWarmup = test.ok && mailbox.warmupStatus === "not_started";
    const updated = await ctx.db.mailboxes.update(id, {
      provider: "smtp",
      credentialsRef: ref,
      status: test.ok ? "connected" : "error",
      autoPausedReason: null,
      sendFailures: 0,
      sendBackoffUntil: null,
      lastSendError: null,
      // Inbound: with no IMAP server there is no way to read replies, and that is known now.
      // With one, it is unverified until the first read (the scheduler's next tick, or "Test
      // connection") — follow-ups stay on hold until a read has actually succeeded.
      inboundStatus: body.imapHost ? undefined : "unavailable",
      inboundError: body.imapHost ? null : NO_IMAP,
      inboundCursor: null,
      ...(startWarmup ? { warmupStatus: "warming" as const, warmupStartedAt: ctx.clock.now().toISOString() } : {}),
    });
    await writeAudit(ctx, { merchantId, actorId: null, action: "mailbox.connected", subjectType: "mailbox", subjectId: id, metadata: { provider: "smtp", ok: test.ok, imap: !!body.imapHost } });
    return ok(reply, { mailbox: presentMailbox(updated, ctx.clock.now()), test });
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
    let creds: MailboxCredentials;
    try {
      creds = JSON.parse(raw) as MailboxCredentials;
    } catch {
      return ok(reply, { ok: false, reason: "credentials unreadable" });
    }
    let test: { ok: boolean; reason?: string } = { ok: mailbox.status === "connected" };
    if (creds.kind === "smtp" && creds.host && creds.port && creds.user && creds.pass != null) {
      test = await new SmtpSender({ host: creds.host, port: creds.port, user: creds.user, pass: creds.pass, secure: creds.secure }).verify();
      await ctx.db.mailboxes.update(id, { status: test.ok ? "connected" : "error" });
    }
    // The other half of "connected": can we READ this mailbox? Read it now (routing anything
    // new) so the answer is current — it is what decides whether follow-ups may go out.
    await ingestReplies(ctx, { merchantId, mailboxId: id }).catch(() => undefined);
    const fresh = (await ctx.db.mailboxes.get(id)) ?? mailbox;
    return ok(reply, { ...test, inbound: inboundState(fresh) });
  });

  // Resume a mailbox the deliverability monitor auto-paused (after fixing the list/source),
  // or one being held back after send failures (after fixing what made them fail).
  app.post("/mailboxes/:id/resume", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    const updated = await ctx.db.mailboxes.update(id, { status: "connected", autoPausedReason: null, sendFailures: 0, sendBackoffUntil: null, lastSendError: null });
    await writeAudit(ctx, { merchantId, actorId: null, action: "mailbox.resumed", subjectType: "mailbox", subjectId: id });
    return ok(reply, presentMailbox(updated, ctx.clock.now()));
  });

  app.delete("/mailboxes/:id", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    await ctx.db.mailboxes.delete(id);
    // The credentials go with it — a deleted mailbox must not leave a usable grant behind.
    if (mailbox.credentialsRef) await ctx.secrets.delete(mailbox.credentialsRef).catch(() => undefined);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "mailbox.deleted",
      subjectType: "mailbox",
      subjectId: id,
    });
    return ok(reply, { id, deleted: true });
  });

  // ---- Mailbox OAuth connect (Microsoft Graph / Gmail) ----------------------
  // Returns the provider consent URL to redirect the merchant to. State is a signed,
  // short-lived token carrying the mailbox target (anti-CSRF).
  app.post("/mailboxes/:id/connect/:provider", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "admin");
    const id = (request.params as { id: string }).id;
    const provider = (request.params as { provider: string }).provider as OAuthProviderName;
    if (provider !== "microsoft" && provider !== "google") throw badRequest("unknown provider");
    const mailbox = await ctx.db.mailboxes.get(id);
    if (!mailbox || mailbox.merchantId !== merchantId) throw notFound("mailbox");
    const cfg = oauthProviderFor(ctx.config, provider);
    if (!cfg) throw badRequest(`${provider} OAuth is not configured on this server`);
    // One connect request = one nonce, remembered on the mailbox. The callback accepts a state
    // only while its nonce is the one stored here, and clears it: a state can be used once,
    // and starting a new connect invalidates the previous link.
    const nonce = newOAuthNonce();
    await ctx.db.mailboxes.update(id, { oauthNonce: nonce });
    const state = signOAuthState({ mailboxId: id, merchantId, provider, nonce }, ctx.config.jwtSecret);
    return ok(reply, { consentUrl: buildConsentUrl(cfg, state, { loginHint: mailbox.email }) });
  });

  // The provider redirects the merchant's browser here after consent (public — no JWT;
  // the signed state carries the identity). We exchange the code + store the tokens.
  app.get("/oauth/:provider/callback", async (request, reply) => {
    const provider = (request.params as { provider: string }).provider as OAuthProviderName;
    const q = request.query as { code?: string; state?: string; error?: string };
    const appUrl = ctx.config.corsOrigins[0] ?? "http://localhost:5173";
    if (q.error) return reply.redirect(`${appUrl}/#/integrations?oauth_error=${encodeURIComponent(q.error)}`);
    const st = q.state ? verifyOAuthState(q.state, ctx.config.jwtSecret) : null;
    const cfg = oauthProviderFor(ctx.config, provider);
    if (!st || st.provider !== provider || !q.code || !cfg) {
      return reply.type("text/html").send("<p>Invalid or expired connection request. Please try connecting again.</p>");
    }
    const mailbox = await ctx.db.mailboxes.get(st.mailboxId);
    if (!mailbox || mailbox.merchantId !== st.merchantId) return reply.type("text/html").send("<p>Mailbox not found.</p>");
    // Single use: the state must carry the nonce of the connect request in flight, and that
    // nonce is spent here — before the code is exchanged — so a replayed callback finds none.
    if (!mailbox.oauthNonce || mailbox.oauthNonce !== st.nonce) {
      return reply.type("text/html").send("<p>This connection link has already been used or was replaced by a newer one. Please start connecting again.</p>");
    }
    await ctx.db.mailboxes.update(st.mailboxId, { oauthNonce: null });
    try {
      const tokens = await exchangeCode(cfg, q.code);
      // The account that consented must BE this mailbox. The login hint is only a hint: sign in
      // as another account and we would hold a grant to send (and read mail) as someone else
      // while the row still shows this address. No readable identity → not connected either.
      const wanted = mailbox.email.trim().toLowerCase();
      const consented = tokens.accountEmails ?? [];
      if (!consented.includes(wanted)) {
        await writeAudit(ctx, { merchantId: st.merchantId, actorId: null, action: "mailbox.connect_rejected", subjectType: "mailbox", subjectId: st.mailboxId, metadata: { provider, reason: consented.length ? "account_mismatch" : "account_unknown" } });
        const detail = consented.length ? `account_mismatch&expected=${encodeURIComponent(wanted)}&got=${encodeURIComponent(consented[0]!)}` : "account_unverified";
        return reply.redirect(`${appUrl}/#/integrations?oauth_error=${detail}`);
      }
      const creds: MailboxCredentials = {
        kind: provider === "microsoft" ? "microsoft" : "gmail_oauth",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? undefined,
        expiresAt: tokens.expiresAt,
      };
      const ref = credsRef(st.mailboxId);
      await ctx.secrets.put(ref, JSON.stringify(creds));
      const startWarmup = mailbox.warmupStatus === "not_started";
      await ctx.db.mailboxes.update(st.mailboxId, {
        provider: provider === "microsoft" ? "microsoft" : "gmail",
        credentialsRef: ref,
        status: "connected",
        autoPausedReason: null,
        sendFailures: 0,
        sendBackoffUntil: null,
        lastSendError: null,
        // Inbound: Microsoft is read through Graph (unverified until the first read succeeds);
        // Gmail via Google sign-in has no reply reader, so its follow-ups stay on hold.
        inboundStatus: provider === "google" ? "unavailable" : undefined,
        inboundError: provider === "google" ? GMAIL_OAUTH_NO_INBOUND : null,
        inboundCursor: null,
        ...(startWarmup ? { warmupStatus: "warming" as const, warmupStartedAt: ctx.clock.now().toISOString() } : {}),
      });
      await writeAudit(ctx, { merchantId: st.merchantId, actorId: null, action: "mailbox.connected", subjectType: "mailbox", subjectId: st.mailboxId, metadata: { provider, oauth: true } });
      return reply.redirect(`${appUrl}/#/integrations?connected=${provider}`);
    } catch {
      return reply.type("text/html").send("<p>Connection failed — the authorization may have expired. Close this window and try again.</p>");
    }
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

    const body = (request.body ?? {}) as { dkimSelector?: string };
    const spfOk = await hasTxtRecord(domain.domain, (v) => v.toLowerCase().startsWith("v=spf1"));
    const dmarcOk = await hasTxtRecord(`_dmarc.${domain.domain}`, (v) => v.toLowerCase().startsWith("v=dmarc1"));

    // DKIM needs a selector. Use the one provided, else probe the common provider
    // selectors. A DKIM TXT record contains `v=DKIM1` and/or a public key (`p=`).
    const selectors = body.dkimSelector ? [body.dkimSelector] : ["google", "default", "s1", "s2", "k1", "dkim", "mail", "selector1", "selector2"];
    let dkimOk = false;
    let dkimSelector: string | null = null;
    for (const sel of selectors) {
      if (await hasTxtRecord(`${sel}._domainkey.${domain.domain}`, (v) => /v=dkim1|(^|;)\s*p=/i.test(v))) {
        dkimOk = true;
        dkimSelector = sel;
        break;
      }
    }

    const updated = await ctx.db.sendingDomains.update(id, {
      spfStatus: spfOk ? "verified" : "failed",
      dmarcStatus: dmarcOk ? "verified" : "failed",
      dkimStatus: dkimOk ? "verified" : "failed",
    });
    // From-alignment: outreach mailboxes whose address-domain matches an authenticated
    // sending domain are aligned (best deliverability). Surface any that aren't.
    const mailboxes = await ctx.db.mailboxes.find((m) => m.merchantId === merchantId);
    const aligned = mailboxes.filter((m) => emailDomain(m.email) === domain.domain.replace(/^mail\./, "")).map((m) => m.email);
    const unaligned = mailboxes.filter((m) => !aligned.includes(m.email) && emailDomain(m.email) !== domain.domain).map((m) => m.email);
    await writeAudit(ctx, {
      merchantId,
      actorId: null,
      action: "sending_domain.verify_attempted",
      subjectType: "sending_domain",
      subjectId: id,
      metadata: { spfOk, dmarcOk, dkimOk, dkimSelector },
    });
    return ok(reply, { ...updated, dkimSelector, alignment: { aligned, unaligned } });
  });
};

/** The domain part of an email address (lowercased), or "" when malformed. */
function emailDomain(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}

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
