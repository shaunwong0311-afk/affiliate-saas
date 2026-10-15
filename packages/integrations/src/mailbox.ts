import { createHash, randomUUID } from "node:crypto";
import type { MailboxSender, OutboundEmail, SendFailureKind, SendResult } from "./ports.js";

/**
 * Send-as-the-merchant mailbox adapters (Section 8.4). Outreach goes from the
 * merchant's connected mailbox (Gmail / Microsoft Graph OAuth, or SMTP) under the
 * merchant's identity — converts better and protects platform domain reputation.
 *
 * Two rules every adapter here obeys (AUDIT-2026-10 O1/O2/O9):
 *  - `send()` never throws. A network error, a missing dependency or a provider outage is a
 *    `failed` result with a reason — one mailbox's bad day must not abort a scheduler tick.
 *  - Only a permanent problem with the RECIPIENT's own address is `bounced`. Sender-side,
 *    policy, quota and auth rejections are `failed` (with a `failure` kind): the prospect is
 *    not suppressed and the caller backs the mailbox off instead of burning the list.
 */

/** Default: a deterministic mock that records sends and simulates bounces. Dev/test only. */
export class MockMailboxSender implements MailboxSender {
  readonly provider = "mock";
  readonly outbox: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<SendResult> {
    this.outbox.push(email);
    const messageId = email.messageId ?? `mock_${createHash("sha1").update(email.toEmail + email.subject).digest("hex").slice(0, 16)}`;
    if (/bounce|invalid|noexist/i.test(email.toEmail)) {
      return { messageId, status: "bounced", reason: "simulated hard bounce" };
    }
    return { messageId, status: "sent" };
  }
}

/**
 * A sender that refuses to send and says why. This — never the mock — is what a mailbox that
 * cannot be resolved/built yields: a mock would report `sent` for mail that never left.
 */
export function unavailableMailboxSender(reason: string, failure: SendFailureKind = "config"): MailboxSender {
  return {
    provider: "unavailable",
    async send(): Promise<SendResult> {
      return { messageId: "", status: "failed", reason, failure };
    },
  };
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

// ---- Message-Id + RFC 5322 / MIME building ------------------------------------

/**
 * A fresh RFC 5322 Message-Id on the sending address's own domain. We stamp OUR id on every
 * rail and store it: it is what follow-ups thread on (`In-Reply-To`/`References`) and what an
 * inbound reply or bounce is correlated by. A provider's API id (Gmail's `id`) is not a
 * Message-Id and must never be stored in its place.
 */
export function newMessageId(fromEmail: string): string {
  const domain = (fromEmail.split("@")[1] ?? "").toLowerCase().replace(/[^a-z0-9.-]/g, "") || "localhost.invalid";
  return `<${randomUUID()}@${domain}>`;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Collapse CR/LF (and other control characters) — a header value must never carry a line break. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
}

/** RFC 2047 encoded-words for a non-ASCII header value (UTF-8, base64, ≤75 chars per word). */
function encodeWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    // 45 UTF-8 bytes → 60 base64 chars → a 72-char encoded-word. Never split a code point.
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** An unstructured header value (Subject): ASCII as-is, anything else as encoded-words. */
function encodeUnstructured(value: string): string {
  const clean = oneLine(value);
  return PRINTABLE_ASCII.test(clean) ? clean : encodeWords(clean);
}

/** `Display Name <addr>` with the display name quoted when it carries specials. Not MIME-encoded
 *  (for transports like nodemailer that encode themselves). */
function formatAddress(name: string, email: string): string {
  const addr = oneLine(email).replace(/[<>\s]/g, "");
  const display = oneLine(name);
  if (!display) return addr;
  // A bare `Lumen, Inc. <a@b>` parses as TWO addresses; quote anything with RFC 5322 specials.
  const needsQuote = /[()<>[\]:;@\\,."]/.test(display);
  return `${needsQuote ? `"${display.replace(/(["\\])/g, "\\$1")}"` : display} <${addr}>`;
}

/** The same, MIME-safe for a raw message we build ourselves (non-ASCII names → encoded-words). */
function encodeAddress(name: string, email: string): string {
  const addr = oneLine(email).replace(/[<>\s]/g, "");
  const display = oneLine(name);
  if (!display) return addr;
  if (!PRINTABLE_ASCII.test(display)) return `${encodeWords(display)} <${addr}>`;
  return formatAddress(display, addr);
}

/** RFC 2045 quoted-printable: 76-column lines, CRLF line ends, UTF-8 bytes escaped. */
function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const bytes = Buffer.from(line, "utf8");
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const lastOnLine = i === bytes.length - 1;
      const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !lastOnLine);
      const token = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (cur.length + token.length > 75) {
        out.push(`${cur}=`); // soft line break (never inside an =XX escape)
        cur = "";
      }
      cur += token;
    }
    out.push(cur);
  }
  return out.join("\r\n");
}

/** Headers the builder writes itself — a caller-supplied duplicate is dropped, not doubled. */
const OWNED_HEADERS = new Set(["date", "from", "to", "subject", "message-id", "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding"]);

/**
 * Build a complete RFC 5322 / MIME message for the raw-MIME rails (Gmail API `raw`, Graph
 * `sendMail` MIME). Headers and body are separated by an empty line, every line ends in CRLF,
 * non-ASCII headers are RFC 2047 encoded, the body is 7bit or quoted-printable, and a
 * `Message-ID` is always present. Header values are forced onto one line, so a subject or
 * display name carrying a line break (LLM output) cannot inject headers.
 */
export function buildRfc822(email: OutboundEmail): string {
  const messageId = email.messageId ?? newMessageId(email.fromEmail);
  const references = (email.references?.length ? email.references : email.inReplyTo ? [email.inReplyTo] : []).map(oneLine).filter(Boolean);
  const headers: string[] = [
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
    `From: ${encodeAddress(email.fromName, email.fromEmail)}`,
    `To: ${oneLine(email.toEmail).replace(/[<>\s]/g, "")}`,
    `Subject: ${encodeUnstructured(email.subject)}`,
    `Message-ID: ${oneLine(messageId)}`,
  ];
  // Threading: set both In-Reply-To AND References (mail clients thread on References).
  if (email.inReplyTo) headers.push(`In-Reply-To: ${oneLine(email.inReplyTo)}`);
  if (references.length) headers.push(`References: ${references.join("\r\n ")}`);
  for (const [name, value] of Object.entries(email.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || OWNED_HEADERS.has(name.toLowerCase())) continue;
    headers.push(`${name}: ${encodeUnstructured(value)}`);
  }
  const body = email.body.replace(/\r\n|\r|\n/g, "\r\n");
  const sevenBit = PRINTABLE_ASCII.test(body.replace(/[\r\n\t]/g, "")) && body.split("\r\n").every((l) => l.length <= 998);
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", `Content-Transfer-Encoding: ${sevenBit ? "7bit" : "quoted-printable"}`);
  // The EMPTY line is the header/body separator — it must survive (it used to be filtered out).
  return `${headers.join("\r\n")}\r\n\r\n${sevenBit ? body : quotedPrintable(body)}\r\n`;
}

// ---- Failure classification ---------------------------------------------------

/** The fields of an SMTP failure we classify on (nodemailer's error shape, or a DSN's). */
export interface SmtpFailureInput {
  message?: string;
  /** nodemailer/Node error code: EAUTH, EENVELOPE, ECONNECTION, ETIMEDOUT, … */
  code?: string;
  /** The 3-digit SMTP reply code, when the server answered. */
  responseCode?: number;
  /** The server's full reply text. */
  response?: string;
  /** The SMTP command the server was answering (`RCPT TO`, `MAIL FROM`, `DATA`, …). */
  command?: string;
  /** RFC 3463 enhanced status when known separately (a DSN's `Status:` field). */
  enhancedStatus?: string;
}

export interface FailureClass {
  status: "bounced" | "failed";
  failure?: SendFailureKind;
  reason: string;
}

/** Connection / DNS / TLS / stream errors — nothing was ever said about the recipient. */
const NETWORK_CODES = /^(ECONNECTION|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ESOCKET|EDNS|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ETLS|ESTARTTLS|EPROTOCOL|ESTREAM)/i;
/** RFC 3463 statuses that name a PERMANENT problem with the recipient's own address/mailbox:
 *  bad mailbox, bad destination domain, bad address syntax, moved, null MX, disabled. */
const RECIPIENT_ENHANCED = new Set(["5.1.1", "5.1.2", "5.1.3", "5.1.6", "5.1.10", "5.2.1"]);
/** Explicit "this mailbox does not exist" wording, for servers that send no enhanced status.
 *  Deliberately excludes the RFC's catch-all "mailbox unavailable" and Postfix's
 *  "Recipient address rejected" prefix: both are also used for policy rejections. */
const RECIPIENT_UNKNOWN_TEXT =
  /user unknown|unknown user|unknown recipient|no such (user|recipient|mailbox|address|person|account)|(recipient|mailbox|address|account|user)( address)? (unknown|not found|does(n't| not) exist|is disabled|has been disabled|is inactive)|invalid (recipient|mailbox)|not a valid (recipient|mailbox)|account that you tried to reach (does not exist|is disabled)|address(?: couldn't| could not) be found|no mailbox here/i;
/** Wording that puts the fault on OUR side or on policy — never a recipient bounce. */
const NOT_RECIPIENT_TEXT =
  /sender|relay|spam|blocked|block ?list|black ?list|polic(y|ies)|quota|limit|\brate\b|too many|throttl|authenticat|not authori[sz]ed|permission|\bspf\b|\bdkim\b|\bdmarc\b|reputation|greylist|grey ?list|try again|temporar|banned|denied|exceeded/i;

function failureKindFromText(text: string, fallback: SendFailureKind): SendFailureKind {
  if (/authenticat|not authori[sz]ed|credentials|login|password/i.test(text)) return "auth";
  if (/quota|limit|\brate\b|too many|throttl|exceeded/i.test(text)) return "quota";
  if (/sender|relay|mail from/i.test(text)) return "sender";
  if (/spam|blocked|block ?list|black ?list|polic|reputation|\bspf\b|\bdkim\b|\bdmarc\b|banned|denied/i.test(text)) return "policy";
  return fallback;
}

/**
 * Classify an SMTP failure (a synchronous rejection, or the diagnostic inside a bounce
 * message). Returns `bounced` ONLY for a permanent problem with the recipient's own address;
 * everything else is `failed` with the kind of failure. Order matters:
 *  1. connection/auth error CODES (an EAUTH carries a 535 that must not read as a bounce);
 *  2. 4xx → transient;
 *  3. the RFC 3463 enhanced status, which is unambiguous when present (5.7.x policy, 5.4.5
 *     quota, 5.1.7/8 bad SENDER, 5.2.2 full mailbox are all NOT bounces);
 *  4. only then wording — and wording that blames the sender/policy wins over "unknown".
 * The reply code is read from `responseCode` or the START of the reply text, never regexed out
 * of free text: Node network errors embed the port ("connect ECONNREFUSED 1.2.3.4:587").
 *
 * NOT validated against live servers: the tables come from RFC 3463/5321 and the published
 * reply texts of Postfix, Exim, Exchange Online and Gmail. It deliberately errs toward
 * `failed` — a real bounce missed here still arrives as a delivery-status notification.
 */
export function classifySmtpFailure(err: SmtpFailureInput): FailureClass {
  const text = `${err.response ?? ""} ${err.message ?? ""}`.replace(/\s+/g, " ").trim();
  const reason = (text || err.code || "smtp error").slice(0, 200);
  const failed = (failure: SendFailureKind): FailureClass => ({ status: "failed", failure, reason });

  const code = err.code ?? "";
  if (/^E?AUTH|^ENOAUTH/i.test(code)) return failed("auth");
  if (NETWORK_CODES.test(code)) return failed("network");

  const leading = /^(?:[^:]{0,80}:\s*)?([245]\d\d)(?=[ -])/.exec((err.response ?? err.message ?? "").trim());
  const rc = typeof err.responseCode === "number" ? err.responseCode : leading ? Number(leading[1]) : null;
  // An enhanced status is only read out of the text of a real server reply (one that has a reply
  // code), and never out of something shaped like an IP address ("connect … 5.1.1.200:25").
  const inText = rc != null ? /(?<![\d.])([245]\.\d{1,3}\.\d{1,3})(?!\.?\d)/.exec(text)?.[1] : undefined;
  // A generic X.0.0 `Status:` (common in bounce reports) yields to a specific one in the reply text.
  const given = err.enhancedStatus && !/^[245]\.0\.0$/.test(err.enhancedStatus) ? err.enhancedStatus : undefined;
  const enhanced = given ?? inText ?? err.enhancedStatus ?? null;

  if (rc === 530 || rc === 534 || rc === 535 || rc === 538) return failed("auth");
  const atRecipient = /^RCPT/i.test(err.command ?? "");
  if ((rc != null && rc >= 400 && rc < 500) || enhanced?.startsWith("4.")) {
    // Greylisting, a busy or full mailbox: soft and recipient-specific. Anything else 4xx is ours.
    return failed(atRecipient || /greylist|grey ?list|mailbox (full|busy)|over quota/i.test(text) || enhanced === "4.2.2" ? "recipient" : failureKindFromText(text, "unknown"));
  }
  if (rc != null && rc < 400) return failed("unknown");

  if (enhanced && !/^5\.(0|1|2)\.0$/.test(enhanced)) {
    if (RECIPIENT_ENHANCED.has(enhanced)) return { status: "bounced", reason };
    // Exchange Online answers an unknown recipient with 5.4.1 "Recipient address rejected: Access denied".
    if (enhanced === "5.4.1" && /recipient address rejected/i.test(text)) return { status: "bounced", reason };
    if (enhanced === "5.2.2") return failed("recipient"); // mailbox full — soft, retry later
    if (enhanced === "5.1.7" || enhanced === "5.1.8") return failed("sender");
    if (enhanced === "5.4.5") return failed("quota");
    if (enhanced === "5.7.8" || enhanced === "5.7.9") return failed("auth");
    if (enhanced.startsWith("5.7.")) return failed(failureKindFromText(text, "policy"));
    return failed(failureKindFromText(text, "unknown"));
  }

  // No (specific) enhanced status: go by wording, and only explicit "no such mailbox" counts.
  if (/^MAIL/i.test(err.command ?? "")) return failed("sender");
  if (NOT_RECIPIENT_TEXT.test(text)) return failed(failureKindFromText(text, "policy"));
  if ((rc == null || rc >= 500) && RECIPIENT_UNKNOWN_TEXT.test(text)) return { status: "bounced", reason };
  return failed("unknown");
}

/** Provider API (Graph / Gmail) said the RECIPIENT address itself is invalid. Narrow on purpose:
 *  "mailbox not found" style errors there describe the SENDER's mailbox, not the recipient. */
function providerRejectedRecipient(status: number, json: unknown): boolean {
  if (status !== 400) return false;
  const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return /^ErrorInvalidRecipients?$/i.test(String(err?.code ?? "")) || /invalid to header|invalid recipient|recipient address (is )?(invalid|required)/i.test(String(err?.message ?? ""));
}

function providerFailure(provider: string, status: number, json: unknown): SendResult {
  const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const detail = [err?.code, err?.message].filter((x) => typeof x === "string" && x).join(" ");
  const reason = `${provider} ${status}${detail ? ` ${detail}` : ""}`.slice(0, 200);
  if (providerRejectedRecipient(status, json)) return { messageId: "", status: "bounced", reason };
  const failure: SendFailureKind = status === 401 || status === 403 ? "auth" : status === 429 ? "quota" : status >= 500 ? "network" : "unknown";
  return { messageId: "", status: "failed", reason, failure };
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/**
 * Gmail API sender. Sends our own RFC 5322 message (`raw`), so List-Unsubscribe and
 * In-Reply-To/References survive exactly as on SMTP, and returns OUR Message-Id — the API's
 * `id` is Gmail's internal message id and is useless as an `In-Reply-To`.
 *
 * NOT validated against the live Gmail API (no OAuth grant has ever been exercised): whether
 * Gmail preserves a caller-supplied `Message-ID` on `messages.send` is assumed, not observed.
 */
export class GmailSender implements MailboxSender {
  readonly provider = "gmail";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    if (!this.opts.http) return { messageId: "", status: "failed", reason: new NotConfiguredError(this.provider).message, failure: "config" };
    const messageId = email.messageId ?? newMessageId(email.fromEmail);
    const raw = Buffer.from(buildRfc822({ ...email, messageId }), "utf8").toString("base64url");
    let res: { status: number; json: any };
    try {
      res = await this.opts.http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        { raw },
        { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      );
    } catch (e) {
      // Timeout / DNS / reset: nothing is known to have been sent. Never throw into the tick.
      return { messageId: "", status: "failed", reason: `gmail request failed: ${errorText(e)}`, failure: "network" };
    }
    if (res.status < 300) return { messageId, status: "sent" };
    return providerFailure("gmail", res.status, res.json);
  }
}

/**
 * Microsoft Graph sender. Sends RAW MIME (base64) so the RFC 8058 List-Unsubscribe headers
 * and In-Reply-To/References threading survive — Graph's structured `message` object only
 * accepts `internetMessageHeaders` for `x-`-prefixed customs, which would silently DROP
 * List-Unsubscribe. Graph's `sendMail` returns 202 with no id, so the Message-Id we stamp in
 * the MIME is the one we return and store.
 *
 * NOT validated against live Graph: MIME `sendMail` and Exchange keeping our `Message-ID` are
 * taken from the documentation. Real delivery failures arrive later as NDRs in the inbox.
 */
export class MicrosoftGraphSender implements MailboxSender {
  readonly provider = "microsoft";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}
  async send(email: OutboundEmail): Promise<SendResult> {
    if (!this.opts.http) return { messageId: "", status: "failed", reason: new NotConfiguredError(this.provider).message, failure: "config" };
    const messageId = email.messageId ?? newMessageId(email.fromEmail);
    // POST /me/sendMail with a base64 MIME body (Content-Type text/plain) preserves all headers.
    const mime = Buffer.from(buildRfc822({ ...email, messageId }), "utf8").toString("base64");
    let res: { status: number; json: any };
    try {
      res = await this.opts.http.post(
        "https://graph.microsoft.com/v1.0/me/sendMail",
        mime,
        { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "text/plain" },
      );
    } catch (e) {
      return { messageId: "", status: "failed", reason: `graph request failed: ${errorText(e)}`, failure: "network" };
    }
    if (res.status < 300) return { messageId, status: "sent" };
    return providerFailure("graph", res.status, res.json);
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
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    headers?: Record<string, string>;
  }): Promise<{
    messageId?: string;
    accepted?: string[];
    rejected?: string[];
    /** nodemailer's per-recipient RCPT failures (reply code + text) when it reports them. */
    rejectedErrors?: Array<{ recipient?: string; responseCode?: number; response?: string; message?: string }>;
    response?: string;
  }>;
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
    const messageId = email.messageId ?? newMessageId(email.fromEmail);
    let t: SmtpTransport;
    try {
      t = await this.transport();
    } catch (e) {
      return { messageId: "", status: "failed", reason: errorText(e), failure: e instanceof NotConfiguredError ? "config" : "network" };
    }
    try {
      const references = email.references?.length ? email.references : email.inReplyTo ? [email.inReplyTo] : null;
      const info = await t.sendMail({
        from: formatAddress(email.fromName, email.fromEmail),
        to: email.toEmail,
        subject: email.subject,
        text: email.body,
        messageId, // our own id, so what we store is what the recipient's reply references
        ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
        ...(references ? { references: references.join(" ") } : {}),
        ...(email.headers ? { headers: email.headers } : {}),
      });
      if (info.rejected && info.rejected.length > 0) {
        // The server refused the recipient at RCPT. That is a bounce only when it said the
        // ADDRESS is permanently bad; a greylist (4xx), a relay/quota/policy refusal, or a
        // refusal with no stated reason is a failure to retry — not a burned prospect.
        const detail = info.rejectedErrors?.find((r) => !r.recipient || r.recipient.toLowerCase() === email.toEmail.toLowerCase()) ?? info.rejectedErrors?.[0];
        if (!detail) return { messageId: "", status: "failed", reason: `recipient rejected by the server (no reason given): ${info.rejected.join(", ")}`.slice(0, 200), failure: "unknown" };
        const cls = classifySmtpFailure({ ...detail, command: "RCPT TO" });
        return { messageId: "", status: cls.status, reason: cls.reason, ...(cls.failure ? { failure: cls.failure } : {}) };
      }
      return { messageId: info.messageId || messageId, status: "sent" };
    } catch (e: unknown) {
      const cls = classifySmtpFailure(e && typeof e === "object" ? (e as SmtpFailureInput) : { message: String(e) });
      return { messageId: "", status: cls.status, reason: cls.reason, ...(cls.failure ? { failure: cls.failure } : {}) };
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
 * SecretStore lives). Credentials that cannot build their rail yield a sender that FAILS with
 * the reason — never the mock, which would record mail as sent that never left (O4).
 */
export function buildMailboxSender(
  creds: MailboxCredentials,
  opts: { http?: HttpClient; smtpFactory?: SmtpTransportFactory } = {},
): MailboxSender {
  switch (creds.kind) {
    case "smtp":
      if (!creds.host || !creds.port || !creds.user || creds.pass == null) return unavailableMailboxSender("smtp credentials are incomplete (host, port, user and password are required)");
      return new SmtpSender({ host: creds.host, port: creds.port, user: creds.user, pass: creds.pass, secure: creds.secure }, opts.smtpFactory);
    case "microsoft":
      if (!creds.accessToken) return unavailableMailboxSender("microsoft mailbox has no access token — reconnect it", "auth");
      return new MicrosoftGraphSender({ accessToken: creds.accessToken, http: opts.http });
    case "gmail_oauth":
      if (!creds.accessToken) return unavailableMailboxSender("gmail mailbox has no access token — reconnect it", "auth");
      return new GmailSender({ accessToken: creds.accessToken, http: opts.http });
    default:
      return unavailableMailboxSender(`unknown mailbox rail "${String((creds as { kind?: unknown }).kind)}"`);
  }
}
