import { createHash } from "node:crypto";
import type { MailboxSender, OutboundEmail, SendResult } from "./ports.js";

/**
 * Send-as-the-merchant mailbox adapters (Section 8.4). Outreach goes from the
 * merchant's connected mailbox (Gmail / Microsoft Graph OAuth, or SMTP) under the
 * merchant's identity — converts better and protects platform domain reputation.
 */

/** Default: a deterministic mock that records sends and simulates bounces. */
export class MockMailboxSender implements MailboxSender {
  readonly provider = "mock";
  readonly outbox: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<SendResult> {
    this.outbox.push(email);
    const messageId = `mock_${createHash("sha1").update(email.toEmail + email.subject).digest("hex").slice(0, 16)}`;
    if (/bounce|invalid|noexist/i.test(email.toEmail)) {
      return { messageId, status: "bounced", reason: "simulated hard bounce" };
    }
    return { messageId, status: "sent" };
  }
}

export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }>;
}

export class NotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} mailbox is not configured (no OAuth token/HTTP client)`);
    this.name = "NotConfiguredError";
  }
}

/**
 * True when a provider error payload names a recipient/address problem (a hard bounce we
 * should suppress) vs a transient/auth failure (retry, don't suppress). Errs toward "failed".
 */
function providerErrorIsBounce(status: number, json: unknown): boolean {
  if (status < 400) return false;
  const blob = JSON.stringify(json ?? "").toLowerCase();
  return /invalidrecipient|recipient.*(not found|reject|invalid)|address.*(invalid|rejected|not found)|no such user|mailbox.*(unavailable|not found)|failedrecipient/i.test(blob);
}

/** Gmail API sender — real shape; requires an OAuth access token + HTTP client. */
export class GmailSender implements MailboxSender {
  readonly provider = "gmail";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.provider);
    // buildRfc822 carries List-Unsubscribe + In-Reply-To/References, so bulk-sender headers
    // and follow-up threading survive on the Gmail rail exactly as on SMTP.
    const raw = Buffer.from(buildRfc822(email)).toString("base64url");
    const res = await this.opts.http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { raw },
      { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
    );
    if (res.status < 300) return { messageId: res.json?.id ?? "", status: "sent" };
    return { messageId: "", status: providerErrorIsBounce(res.status, res.json) ? "bounced" : "failed", reason: `gmail ${res.status}` };
  }
}

/**
 * Microsoft Graph sender. Sends RAW MIME (base64) so the RFC 8058 List-Unsubscribe headers
 * and In-Reply-To/References threading survive — Graph's structured `message` object only
 * accepts `internetMessageHeaders` for `x-`-prefixed customs, which would silently DROP
 * List-Unsubscribe. Recipient-level Graph errors map to a hard bounce.
 */
export class MicrosoftGraphSender implements MailboxSender {
  readonly provider = "microsoft";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}
  async send(email: OutboundEmail): Promise<SendResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.provider);
    // Graph's sendMail returns 202 with no message id, so we STAMP our own Message-Id in the
    // MIME and return it — that's what lets follow-ups thread + inbound replies correlate.
    const domain = email.fromEmail.split("@")[1] ?? "mail.local";
    const messageId = email.messageId ?? `<${createHash("sha1").update(email.toEmail + email.subject + email.body).digest("hex").slice(0, 24)}@${domain}>`;
    // POST /me/sendMail with a base64 MIME body (Content-Type text/plain) preserves all headers.
    const mime = Buffer.from(buildRfc822({ ...email, messageId })).toString("base64");
    const res = await this.opts.http.post(
      "https://graph.microsoft.com/v1.0/me/sendMail",
      mime,
      { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "text/plain" },
    );
    if (res.status < 300) return { messageId, status: "sent" };
    return { messageId: "", status: providerErrorIsBounce(res.status, res.json) ? "bounced" : "failed", reason: `graph ${res.status}` };
  }
}

/**
 * SMTP sender — the highest-coverage rail (Section 8.4 / OUTREACH-SPEC §2). Sends as the
 * merchant over standard SMTP AUTH, covering business email hosted on the merchant's web
 * host (cPanel/Rackspace/GoDaddy/Namecheap/Zoho/Fastmail) AND free Gmail / Workspace via an
 * app password. Needs NO OAuth and NO third-party verification, so it's the launch rail.
 * (NOT for Outlook/M365 — Exchange Online retired basic-auth SMTP; those use Graph OAuth.)
 *
 * nodemailer is an OPTIONAL dependency, dynamically imported (same pattern as undici/
 * playwright) so install + tests work without it. A transport factory can be injected for
 * offline testing. To enable real sending: `npm install nodemailer`.
 */
export interface SmtpConfig {
  host: string;
  port: number; // 587 (STARTTLS) or 465 (implicit TLS)
  user: string;
  pass: string; // mailbox password or app password
  secure?: boolean; // defaults to true for port 465
}

export interface SmtpTransport {
  sendMail(msg: {
    from: string;
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string; accepted?: string[]; rejected?: string[]; response?: string }>;
  verify(): Promise<boolean>;
}

export type SmtpTransportFactory = (cfg: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => SmtpTransport;

export class SmtpSender implements MailboxSender {
  readonly provider = "smtp";
  private transportP: Promise<SmtpTransport> | null = null;
  constructor(
    private readonly cfg: SmtpConfig,
    private readonly factory?: SmtpTransportFactory,
  ) {}

  private transport(): Promise<SmtpTransport> {
    if (!this.transportP) {
      const cfg = {
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.secure ?? this.cfg.port === 465,
        auth: { user: this.cfg.user, pass: this.cfg.pass },
      };
      this.transportP = (async () => {
        if (this.factory) return this.factory(cfg);
        const nm: any = await import("nodemailer" as string).catch(() => {
          throw new NotConfiguredError("smtp (nodemailer not installed — run `npm install nodemailer`)");
        });
        return nm.createTransport(cfg) as SmtpTransport;
      })().catch((e) => {
        this.transportP = null; // don't cache a failed init
        throw e;
      });
    }
    return this.transportP;
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    try {
      const t = await this.transport();
      const info = await t.sendMail({
        from: `${email.fromName} <${email.fromEmail}>`,
        to: email.toEmail,
        subject: email.subject,
        text: email.body,
        ...(email.inReplyTo ? { inReplyTo: email.inReplyTo, references: email.inReplyTo } : {}),
        ...(email.headers ? { headers: email.headers } : {}),
      });
      if (info.rejected && info.rejected.length > 0) {
        return { messageId: info.messageId ?? "", status: "bounced", reason: `rejected: ${info.rejected.join(", ")}` };
      }
      return { messageId: info.messageId ?? "", status: "sent" };
    } catch (e: unknown) {
      // A recipient-level 5xx / "user unknown" is a hard bounce → suppress; anything else
      // (auth, TLS, network) is a transient failure → retry later, don't suppress the address.
      // Classification order matters: connection/auth error CODES first (an EAUTH carries a 535
      // responseCode that would otherwise read as a bounce), then the real SMTP responseCode,
      // then textual recipient markers. NEVER regex a bare 5xx out of free text — Node network
      // errors embed the port ("connect ECONNREFUSED 1.2.3.4:587") and would match.
      const err = e as { message?: string; code?: string; responseCode?: number };
      const msg = err?.message ?? String(e);
      const transient = /^(ECONNECTION|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKET|EDNS|EAUTH|EENVELOPE?TLS|ETLS)/i.test(err?.code ?? "");
      const hardBounce =
        !transient &&
        ((typeof err?.responseCode === "number" && err.responseCode >= 500) ||
          /mailbox unavailable|user unknown|no such user|recipient.*reject|does not exist|\b5\d\d[ -]\d\.\d+\.\d+\b/i.test(msg));
      return { messageId: "", status: hardBounce ? "bounced" : "failed", reason: msg.slice(0, 200) };
    }
  }

  /** Connection + auth check for the "test mailbox" step on connect. */
  async verify(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const t = await this.transport();
      await t.verify();
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
  }
}

/**
 * Encrypted mailbox credentials, stored ONLY in the SecretStore (referenced by an opaque
 * `credentialsRef` on the Mailbox row — never in the row itself). One shape per rail.
 */
export interface MailboxCredentials {
  kind: "smtp" | "microsoft" | "gmail_oauth";
  // smtp rail (cPanel/host + Gmail app-password)
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  secure?: boolean;
  // imap (reply ingestion for the smtp rail)
  imapHost?: string;
  imapPort?: number;
  // oauth rails (microsoft / gmail) — accessToken refreshed before use
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

/**
 * Construct the right send-as-the-merchant adapter from stored credentials (OUTREACH-SPEC
 * §4.1). Pure — token refresh + credential loading happen at the call site (where the
 * SecretStore lives). Falls back to the mock when the rail can't be built.
 */
export function buildMailboxSender(
  creds: MailboxCredentials,
  opts: { http?: HttpClient; smtpFactory?: SmtpTransportFactory } = {},
): MailboxSender {
  switch (creds.kind) {
    case "smtp":
      if (!creds.host || !creds.port || !creds.user || creds.pass == null) return new MockMailboxSender();
      return new SmtpSender({ host: creds.host, port: creds.port, user: creds.user, pass: creds.pass, secure: creds.secure }, opts.smtpFactory);
    case "microsoft":
      if (!creds.accessToken) return new MockMailboxSender();
      return new MicrosoftGraphSender({ accessToken: creds.accessToken, http: opts.http });
    case "gmail_oauth":
      if (!creds.accessToken) return new MockMailboxSender();
      return new GmailSender({ accessToken: creds.accessToken, http: opts.http });
    default:
      return new MockMailboxSender();
  }
}

function buildRfc822(email: OutboundEmail): string {
  const extra = Object.entries(email.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
  return [
    `From: ${email.fromName} <${email.fromEmail}>`,
    `To: ${email.toEmail}`,
    `Subject: ${email.subject}`,
    email.messageId ? `Message-Id: ${email.messageId}` : "",
    // Threading: set both In-Reply-To AND References (mail clients thread on References).
    email.inReplyTo ? `In-Reply-To: ${email.inReplyTo}` : "",
    email.inReplyTo ? `References: ${email.inReplyTo}` : "",
    ...extra,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    email.body,
  ]
    .filter(Boolean)
    .join("\r\n");
}
