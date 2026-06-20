/**
 * Auto-ingest of replies (Section 8.5). Replaces hand-pasting: in production an
 * IMAP poller or an ESP inbound-parse webhook delivers replies, which the engine
 * classifies and routes. The webhook path is just the API endpoint; the IMAP
 * poller is a skeleton here. Both yield a normalized InboundReply.
 */
export interface InboundReply {
  /** The mailbox/campaign the reply came to (to resolve the prospect). */
  toEmail: string;
  fromEmail: string;
  subject: string;
  body: string;
  /** Provider message id, for dedup. */
  messageId: string;
  receivedAt: string;
}

export interface ReplyIngestionSource {
  readonly kind: string;
  /** Pull any new replies since the last cursor. */
  poll(): Promise<InboundReply[]>;
}

/** Strip quoted history and signatures so the classifier sees only the new text. */
export function extractReplyText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break; // quoted previous message
    if (/^On .* wrote:$/.test(line)) break; // gmail/outlook quote header
    if (/^-{2,}\s*$/.test(line)) break; // signature delimiter
    if (/^From:\s/.test(line) || /^Sent:\s/.test(line)) break; // forwarded header
    out.push(line);
  }
  return out.join("\n").trim() || raw.trim();
}

/** IMAP poller skeleton — connects to the merchant mailbox and fetches unseen mail. */
export class ImapReplyIngestion implements ReplyIngestionSource {
  readonly kind = "imap";
  constructor(private readonly opts: { host: string; user: string; accessToken: string }) {}
  async poll(): Promise<InboundReply[]> {
    // Real impl: open IMAP over the merchant's OAuth token, fetch UNSEEN, parse
    // each into InboundReply, mark seen. Omitted to avoid an IMAP dependency.
    void this.opts;
    return [];
  }
}

/** Parse an ESP inbound-parse webhook payload into a normalized reply. */
export function parseInboundWebhook(payload: any): InboundReply | null {
  if (!payload) return null;
  const toEmail = payload.to ?? payload.recipient ?? payload.To ?? "";
  const fromEmail = payload.from ?? payload.sender ?? payload.From ?? "";
  const subject = payload.subject ?? payload.Subject ?? "";
  const body = extractReplyText(payload.text ?? payload["body-plain"] ?? payload.body ?? "");
  const messageId = payload.messageId ?? payload["Message-Id"] ?? `${fromEmail}:${subject}`;
  if (!fromEmail || !body) return null;
  return { toEmail, fromEmail, subject, body, messageId, receivedAt: new Date().toISOString() };
}
