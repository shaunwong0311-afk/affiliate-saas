/**
 * Transactional email via a reputable ESP (Section 11 deployment rule). Distinct
 * from the merchant-mailbox sender used for recruitment outreach: transactional
 * mail (payout notifications, statements, approvals, password resets) must NOT
 * leave the origin box's IP — Hetzner ranges carry poor sending reputation — so it
 * routes through Postmark / SES / Resend. The merchant-mailbox path already sends
 * via Google/Microsoft, so no mail ever originates from the box itself.
 */
export interface TransactionalEmail {
  to: string;
  subject: string;
  html?: string;
  text: string;
  /**
   * Sending address. Optional: when omitted the mailer uses the identity it was configured
   * with (`TRANSACTIONAL_FROM` — an address on a domain VERIFIED with the ESP). Callers should
   * leave it unset rather than hard-code a domain the deployment does not own.
   */
  from?: string;
  /** Display name to show with the sending address (e.g. the merchant's name). */
  fromName?: string;
}

export interface TransactionalResult {
  id: string;
  status: "sent" | "failed";
  reason?: string;
}

export interface TransactionalMailer {
  readonly provider: string;
  send(email: TransactionalEmail): Promise<TransactionalResult>;
}

/** `Name <addr>` for the ESP `from` field (the display name is stripped of characters that
 *  would break the header). */
function formatFrom(address: string, name?: string): string {
  const display = (name ?? "").replace(/[\r\n"<>]/g, "").trim();
  return display ? `"${display}" <${address}>` : address;
}

const NO_SENDER = "no sending identity configured — set TRANSACTIONAL_FROM to an address on a domain verified with the ESP";

/**
 * Default dev mailer: records and "delivers" without leaving the process. In PRODUCTION it
 * reports `failed`, never `sent` — nothing leaves this class, and a `sent` here used to stamp
 * `activationEmailSentAt` for welcome emails no recruit ever received (AUDIT-2026-10 O13).
 */
export class ConsoleTransactionalMailer implements TransactionalMailer {
  readonly provider = "console";
  readonly sent: TransactionalEmail[] = [];
  private readonly production: boolean;
  constructor(opts: { production?: boolean } = {}) {
    this.production = opts.production ?? process.env.NODE_ENV === "production";
  }
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    if (this.production) {
      return { id: "", status: "failed", reason: "no transactional ESP configured (RESEND_API_KEY / POSTMARK_SERVER_TOKEN) — nothing was sent" };
    }
    this.sent.push(email);
    return { id: `console_${this.sent.length}`, status: "sent" };
  }
}

export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }>;
}

/**
 * Resend adapter (real shape; requires API key + HTTP client). `from` is the deployment's
 * verified sending identity. Never throws: a network error is a `failed` result.
 * NOT validated against the live Resend API — no key has ever been run.
 */
export class ResendMailer implements TransactionalMailer {
  readonly provider = "resend";
  constructor(private readonly opts: { apiKey: string; http?: HttpClient; from?: string }) {}
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    if (!this.opts.http) return { id: "", status: "failed", reason: "resend not configured" };
    const from = email.from ?? this.opts.from;
    if (!from) return { id: "", status: "failed", reason: NO_SENDER };
    try {
      const res = await this.opts.http.post(
        "https://api.resend.com/emails",
        { from: formatFrom(from, email.fromName), to: email.to, subject: email.subject, html: email.html, text: email.text },
        { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      );
      if (res.status < 300) return { id: String(res.json?.id ?? ""), status: "sent" };
      return { id: "", status: "failed", reason: `resend ${res.status}${res.json?.message ? ` ${String(res.json.message).slice(0, 160)}` : ""}` };
    } catch (e) {
      return { id: "", status: "failed", reason: `resend request failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
    }
  }
}

/** Postmark adapter (real shape, same contract as Resend). NOT validated against the live API. */
export class PostmarkMailer implements TransactionalMailer {
  readonly provider = "postmark";
  constructor(private readonly opts: { serverToken: string; http?: HttpClient; from?: string }) {}
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    if (!this.opts.http) return { id: "", status: "failed", reason: "postmark not configured" };
    const from = email.from ?? this.opts.from;
    if (!from) return { id: "", status: "failed", reason: NO_SENDER };
    try {
      const res = await this.opts.http.post(
        "https://api.postmarkapp.com/email",
        { From: formatFrom(from, email.fromName), To: email.to, Subject: email.subject, HtmlBody: email.html, TextBody: email.text },
        { "X-Postmark-Server-Token": this.opts.serverToken, "Content-Type": "application/json", Accept: "application/json" },
      );
      if (res.status < 300) return { id: String(res.json?.MessageID ?? ""), status: "sent" };
      return { id: "", status: "failed", reason: `postmark ${res.status}${res.json?.Message ? ` ${String(res.json.Message).slice(0, 160)}` : ""}` };
    } catch (e) {
      return { id: "", status: "failed", reason: `postmark request failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
    }
  }
}
