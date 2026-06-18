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
  /** Verified sending identity on the ESP (e.g. notifications@platform.com). */
  from: string;
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

/** Default dev mailer: records and "delivers" without leaving the process. */
export class ConsoleTransactionalMailer implements TransactionalMailer {
  readonly provider = "console";
  readonly sent: TransactionalEmail[] = [];
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    this.sent.push(email);
    return { id: `console_${this.sent.length}`, status: "sent" };
  }
}

export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }>;
}

/** Resend adapter (real shape; requires API key + HTTP client). */
export class ResendMailer implements TransactionalMailer {
  readonly provider = "resend";
  constructor(private readonly opts: { apiKey: string; http?: HttpClient }) {}
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    if (!this.opts.http) throw new Error("resend not configured");
    const res = await this.opts.http.post(
      "https://api.resend.com/emails",
      { from: email.from, to: email.to, subject: email.subject, html: email.html, text: email.text },
      { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
    );
    return res.status < 300 ? { id: res.json.id, status: "sent" } : { id: "", status: "failed", reason: `resend ${res.status}` };
  }
}

/** Postmark adapter skeleton. */
export class PostmarkMailer implements TransactionalMailer {
  readonly provider = "postmark";
  constructor(private readonly opts: { serverToken: string; http?: HttpClient }) {}
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    if (!this.opts.http) throw new Error("postmark not configured");
    const res = await this.opts.http.post(
      "https://api.postmarkapp.com/email",
      { From: email.from, To: email.to, Subject: email.subject, HtmlBody: email.html, TextBody: email.text },
      { "X-Postmark-Server-Token": this.opts.serverToken, "Content-Type": "application/json", Accept: "application/json" },
    );
    return res.status < 300 ? { id: String(res.json.MessageID), status: "sent" } : { id: "", status: "failed" };
  }
}
