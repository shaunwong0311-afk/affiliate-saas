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
  /** In-Reply-To header — correlates the mail to OUR outreach (vs unrelated inbox traffic). */
  inReplyTo?: string | null;
  /** References header chain, same purpose. */
  references?: string | null;
  receivedAt: string;
}

export interface ReplyIngestionSource {
  readonly kind: string;
  /** Pull any new replies since the last cursor. */
  poll(): Promise<InboundReply[]>;
}

/**
 * Strip quoted history, signatures, and OUR OWN outreach footer so the classifier sees only
 * the sender's new text. Handles bottom-posted replies (new text below the quote) by skipping
 * quoted/header lines instead of stopping at the first one. CRITICAL: never falls back to the
 * raw email — the raw includes our own "Unsubscribe: reply STOP…" footer, and classifying that
 * used to globally suppress prospects who bottom-posted "I'm interested!". No extractable new
 * text → "" → the caller routes to human review instead of guessing.
 */
export function extractReplyText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    // `>`-quoted lines are SKIPPED (not a stop): bottom-posters put their reply below them.
    if (/^\s*>/.test(line)) continue;
    // An unprefixed quote header / signature delimiter / our own footer means everything
    // below is the original message (Outlook-style top-posting) — stop collecting.
    if (/^On .{0,200} wrote:\s*$/.test(line)) break;
    if (/^(From|Sent):\s/.test(line)) break;
    if (/^(-{2,}|—+)\s*$/.test(line)) break;
    if (/^Unsubscribe: reply STOP/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * IMAP connection config for a merchant's mailbox (the SMTP rail's inbound side).
 * Password auth for cPanel/host + Gmail app-password mailboxes; `accessToken`
 * (XOAUTH2) reserved for OAuth rails that grant an IMAP scope.
 */
export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass?: string;
  accessToken?: string;
  secure?: boolean; // implicit TLS (993). Defaults true.
}

/** One fetched message, already reduced to the fields we route on. */
export interface ImapMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  receivedAt: string;
}

/**
 * An open IMAP session over the merchant's INBOX. CRITICAL: reads are PEEK-only —
 * we NEVER set the \Seen flag, because this is the merchant's real business inbox,
 * not a dedicated address. Dedup is our responsibility (by Message-Id), not theirs.
 */
export interface ImapSession {
  /** Fetch messages received strictly after `since` (null = a sensible default window). PEEK, no flag change. */
  fetchSince(since: Date | null): Promise<ImapMessage[]>;
  close(): Promise<void>;
}

export type ImapSessionFactory = (cfg: ImapConfig) => Promise<ImapSession>;

/** First-poll lookback when a mailbox has no cursor yet (avoids scanning years of mail). */
const DEFAULT_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * IMAP reply poller (OUTREACH-SPEC §16 #2) — the SMTP-rail inbound transport. Opens the
 * merchant's mailbox, fetches messages newer than the last cursor WITHOUT touching flags,
 * and normalizes each to an InboundReply. The scheduler dedups by Message-Id and routes
 * through `processInboundReply`. imapflow + mailparser are OPTIONAL deps, dynamically
 * imported by the default factory (same pattern as nodemailer); a factory is injectable
 * for offline tests.
 */
export class ImapReplyIngestion implements ReplyIngestionSource {
  readonly kind = "imap";
  constructor(
    private readonly opts: { config: ImapConfig; since?: Date | null; factory?: ImapSessionFactory },
  ) {}

  async poll(): Promise<InboundReply[]> {
    const factory = this.opts.factory ?? defaultImapSessionFactory;
    const since = this.opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    const session = await factory(this.opts.config);
    try {
      const messages = await session.fetchSince(since);
      return messages.map((m) => ({
        toEmail: m.to,
        fromEmail: m.from,
        subject: m.subject,
        body: extractReplyText(m.text),
        messageId: m.messageId || `${m.from}:${m.subject}:${m.receivedAt}`,
        inReplyTo: m.inReplyTo ?? null,
        references: m.references ?? null,
        receivedAt: m.receivedAt,
      }));
    } finally {
      await session.close().catch(() => {});
    }
  }
}

/**
 * Default IMAP session backed by imapflow + mailparser (both optional). Uses BODY.PEEK
 * (imapflow's `source` does not set \Seen) so the merchant's unread state is untouched.
 * Throws a clear, actionable error if the libraries aren't installed.
 */
export const defaultImapSessionFactory: ImapSessionFactory = async (cfg) => {
  const imapflow: any = await import("imapflow" as string).catch(() => {
    throw new Error("imap reply ingestion needs imapflow + mailparser — run `npm install imapflow mailparser`");
  });
  const mailparser: any = await import("mailparser" as string).catch(() => {
    throw new Error("imap reply ingestion needs imapflow + mailparser — run `npm install imapflow mailparser`");
  });
  const auth = cfg.accessToken ? { user: cfg.user, accessToken: cfg.accessToken } : { user: cfg.user, pass: cfg.pass };
  const client = new imapflow.ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure ?? cfg.port === 993,
    auth,
    logger: false,
    // We never send from this client and never mutate flags; keep the connection minimal.
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  return {
    async fetchSince(since) {
      const out: ImapMessage[] = [];
      const query = since ? { since } : { all: true };
      // `source` uses BODY.PEEK[] — this does NOT mark messages \Seen.
      for await (const msg of client.fetch(query, { uid: true, envelope: true, source: true, internalDate: true })) {
        const parsed = await mailparser.simpleParser(msg.source);
        const env = msg.envelope ?? {};
        const from = parsed.from?.value?.[0]?.address ?? env.from?.[0]?.address ?? "";
        const to = parsed.to?.value?.[0]?.address ?? env.to?.[0]?.address ?? "";
        const receivedAt = (msg.internalDate ?? env.date ?? parsed.date ?? new Date()).toISOString?.() ?? new Date().toISOString();
        // Defence in depth: imapflow's `since` is date-granular, so re-filter by exact time.
        if (since && new Date(receivedAt).getTime() <= since.getTime()) continue;
        out.push({
          uid: msg.uid,
          from: String(from).toLowerCase(),
          to: String(to).toLowerCase(),
          subject: parsed.subject ?? env.subject ?? "",
          text: parsed.text ?? "",
          messageId: (parsed.messageId ?? env.messageId ?? "").replace(/^<|>$/g, ""),
          inReplyTo: (parsed.inReplyTo ?? env.inReplyTo ?? null) || null,
          references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? null),
          receivedAt,
        });
      }
      return out;
    },
    async close() {
      lock.release();
      await client.logout().catch(() => client.close?.());
    },
  };
};

/** Parse an ESP inbound-parse webhook payload into a normalized reply. An empty extracted
 * body is kept (routed to human review), never re-hydrated from the raw email. */
export function parseInboundWebhook(payload: any): InboundReply | null {
  if (!payload) return null;
  const toEmail = payload.to ?? payload.recipient ?? payload.To ?? "";
  const fromEmail = payload.from ?? payload.sender ?? payload.From ?? "";
  const subject = payload.subject ?? payload.Subject ?? "";
  const body = extractReplyText(payload.text ?? payload["body-plain"] ?? payload.body ?? "");
  const messageId = payload.messageId ?? payload["Message-Id"] ?? `${fromEmail}:${subject}`;
  if (!fromEmail) return null;
  return {
    toEmail,
    fromEmail,
    subject,
    body,
    messageId,
    inReplyTo: payload.inReplyTo ?? payload["In-Reply-To"] ?? null,
    references: payload.references ?? payload.References ?? null,
    receivedAt: new Date().toISOString(),
  };
}
