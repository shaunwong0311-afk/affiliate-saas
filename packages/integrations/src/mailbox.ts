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

/** Gmail API sender — real shape; requires an OAuth access token + HTTP client. */
export class GmailSender implements MailboxSender {
  readonly provider = "gmail";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.provider);
    const raw = Buffer.from(buildRfc822(email)).toString("base64url");
    const res = await this.opts.http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { raw },
      { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
    );
    return res.status < 300
      ? { messageId: res.json.id, status: "sent" }
      : { messageId: "", status: "failed", reason: `gmail ${res.status}` };
  }
}

/** Microsoft Graph sender — skeleton. */
export class MicrosoftGraphSender implements MailboxSender {
  readonly provider = "microsoft";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}
  async send(email: OutboundEmail): Promise<SendResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.provider);
    const res = await this.opts.http.post(
      "https://graph.microsoft.com/v1.0/me/sendMail",
      {
        message: {
          subject: email.subject,
          body: { contentType: "Text", content: email.body },
          toRecipients: [{ emailAddress: { address: email.toEmail } }],
        },
      },
      { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
    );
    return res.status < 300 ? { messageId: `graph_${Date.now()}`, status: "sent" } : { messageId: "", status: "failed" };
  }
}

function buildRfc822(email: OutboundEmail): string {
  return [
    `From: ${email.fromName} <${email.fromEmail}>`,
    `To: ${email.toEmail}`,
    `Subject: ${email.subject}`,
    email.inReplyTo ? `In-Reply-To: ${email.inReplyTo}` : "",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    email.body,
  ]
    .filter(Boolean)
    .join("\r\n");
}
