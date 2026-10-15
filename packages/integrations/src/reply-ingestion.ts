import { createHash } from "node:crypto";
import { classifySmtpFailure } from "./mailbox.js";

/**
 * Auto-ingest of replies (Section 8.5). Replaces hand-pasting: an inbox poller (IMAP for the
 * SMTP rail, Microsoft Graph for the Microsoft OAuth rail) or an ESP inbound-parse webhook
 * delivers inbound mail, which the engine classifies and routes. Every path yields the same
 * normalized InboundReply — a real reply, a delivery-status notification (`bounce`), or
 * list/automated mail (`bulk`) that must never be mistaken for a reply.
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
  /**
   * Set when this message is a delivery-status notification (a bounce from mailer-daemon /
   * `multipart/report`), not something a person wrote. Routed as a bounce, never as a reply.
   */
  bounce?: DeliveryStatusReport | null;
  /**
   * True for list / bulk / machine-generated mail (`List-Id`, `List-Unsubscribe`,
   * `Precedence: bulk`, `Auto-Submitted: auto-generated`): a prospect's own newsletter landing
   * in the merchant's inbox. Only ever a reply when it references one of our Message-Ids.
   */
  bulk?: boolean;
}

/** What a delivery-status notification says about one of OUR sends. */
export interface DeliveryStatusReport {
  /** Address(es) the report names as undelivered (lowercased). May be a superset when the
   *  report had to be read from its human-readable text — match against who we emailed. */
  recipients: string[];
  action: "failed" | "delayed" | "delivered" | "relayed" | "expanded" | null;
  /** RFC 3463 enhanced status, e.g. "5.1.1". */
  status: string | null;
  /** The remote server's reply / the reporting MTA's explanation. */
  diagnostic: string | null;
  /** Message-Id candidates for the ORIGINAL message (embedded headers, In-Reply-To,
   *  References) without angle brackets — match against the ids we stamped on our sends. */
  originalMessageIds: string[];
  /**
   * hard  = the recipient's address is permanently bad → bounce + suppress;
   * soft  = delayed / transient → nothing to do yet;
   * other = it failed (or was delivered) for a reason that is NOT the recipient's address —
   *         policy, quota, sender rejection. Never suppresses the prospect.
   */
  kind: "hard" | "soft" | "other";
}

export interface ReplyIngestionSource {
  readonly kind: string;
  /** Pull any new replies since the last cursor. */
  poll(): Promise<InboundReply[]>;
  /** Rail-specific position to persist and resume from, set by a successful `poll()`. */
  nextCursor?: string | null;
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
    if (/^Unsubscribe: (reply STOP|https?:\/\/)/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * The bare address out of a From/To value: `Jane Doe <jane@site.com>`, `"Doe, Jane"
 * <jane@site.com>`, `jane@site.com (Jane)`, or a list (first address wins). Lowercased;
 * "" when there is no address. A display-name form used to be compared verbatim and so
 * never matched a prospect.
 */
export function parseAddress(value: unknown): string {
  if (Array.isArray(value)) return parseAddress(value[0]);
  const s = typeof value === "string" ? value : value && typeof value === "object" ? String((value as { address?: unknown; email?: unknown }).address ?? (value as { email?: unknown }).email ?? "") : "";
  const angle = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/.exec(s);
  const bare = angle?.[1] ?? /([^\s<>()"',;:]+@[^\s<>()"',;:]+)/.exec(s)?.[1] ?? "";
  return bare.trim().toLowerCase();
}

/** The header block (everything before the first empty line) of a raw RFC 5322 message. */
function headerBlockOf(raw: string): string {
  const end = raw.search(/\r?\n\r?\n/);
  return end === -1 ? raw : raw.slice(0, end);
}

/** A header's value from a raw header block, unfolded. Null when absent. */
function headerValue(headers: string, name: string): string | null {
  const m = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t]+.*)*)`, "im").exec(headers);
  return m ? m[1]!.replace(/\r?\n[ \t]+/g, " ").trim() : null;
}

/** List / bulk / machine-generated mail per its own headers (RFC 2919, 2369, 3834). An
 *  auto-REPLY (out-of-office) is deliberately not bulk: it is a real signal about the prospect. */
function isBulkMail(headers: string): boolean {
  if (!headers) return false;
  if (headerValue(headers, "list-id") != null || headerValue(headers, "list-unsubscribe") != null) return true;
  if (/^(bulk|list|junk)\b/i.test(headerValue(headers, "precedence") ?? "")) return true;
  return /^auto-generated\b/i.test(headerValue(headers, "auto-submitted") ?? "");
}

/**
 * Dedup key for a message that carries no Message-Id: a digest of the fields that make it
 * THIS message. A retry of the same payload collapses; a second, different reply from the same
 * person with the same subject does not (the old `from:subject` key silently dropped it).
 */
function contentKey(from: string, parts: Array<string | null | undefined>): string {
  return `${from}:${createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 32)}`;
}

const ADDRESS_RE = /[^\s<>()"',;:[\]]+@[^\s<>()"',;:[\]]+\.[a-z]{2,}/gi;
const DAEMON_SENDER = /^(mailer-daemon|mailerdaemon|mail-daemon|postmaster|microsoftexchange[0-9a-f]+)@/i;
const DSN_WORDING =
  /delivery status notification|undeliverable|undelivered mail|delivery (has )?failed|returned to sender|could ?n[o']t be delivered|wasn't delivered|was not delivered|address not found|mail delivery (failed|subsystem|system)|failure notice|delivery incomplete/i;

/**
 * Recognize and read a delivery-status notification (RFC 3464 `multipart/report`, or the
 * mailer-daemon / Exchange NDR variants that only say it in prose). Returns null for anything
 * that is not a DSN, so ordinary mail is never read as a bounce.
 *
 * Reads the machine-readable `message/delivery-status` fields when the raw source is
 * available (IMAP), and falls back to the human-readable text (Graph, webhooks) — in that
 * case `recipients` holds every address the text names, for the caller to intersect with the
 * addresses it actually sent to. Permanence is decided by the same table as a synchronous
 * SMTP rejection: only a bad RECIPIENT address is `hard`.
 *
 * NOT validated against live bounces: built from RFC 3464 and the documented formats of
 * Postfix, Exim, Gmail and Exchange Online; a provider's unusual prose can read as `other`.
 */
export function parseDeliveryStatus(msg: {
  from?: string | null;
  subject?: string | null;
  /** Raw header block of the notification itself. */
  headers?: string | null;
  /** Decoded text body. */
  text?: string | null;
  /** Full raw source when the transport has it (carries the machine-readable part). */
  raw?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** The notification's own Message-Id, excluded from `originalMessageIds`. */
  messageId?: string | null;
}): DeliveryStatusReport | null {
  const headers = msg.headers ?? (msg.raw ? headerBlockOf(msg.raw) : "");
  const text = msg.text ?? "";
  const hay = `${text}\n${msg.raw ?? ""}`;
  const contentType = headerValue(headers, "content-type") ?? "";
  const failedHeader = headerValue(headers, "x-failed-recipients");
  const isReport = /multipart\/report/i.test(contentType) && /report-type\s*=\s*"?delivery-status/i.test(contentType);
  const hasStatusPart = /^content-type:\s*message\/delivery-status/im.test(hay);
  const isNdr = headerValue(headers, "x-ms-exchange-message-is-ndr") != null;
  const daemon = DAEMON_SENDER.test(parseAddress(msg.from ?? ""));
  const worded = DSN_WORDING.test(`${msg.subject ?? ""}\n${text.slice(0, 4000)}`);
  if (!(isReport || hasStatusPart || failedHeader || isNdr || (daemon && worded))) return null;

  const recipients = new Set<string>();
  for (const m of hay.matchAll(/^(?:final|original)-recipient:\s*(?:[\w-]+\s*;)?\s*<?([^\s<>;,]+@[^\s<>;,]+)>?/gim)) recipients.add(m[1]!.toLowerCase());
  for (const a of (failedHeader ?? "").match(ADDRESS_RE) ?? []) recipients.add(a.toLowerCase());
  let action = (/^action:\s*(failed|delayed|delivered|relayed|expanded)\b/im.exec(hay)?.[1]?.toLowerCase() ?? null) as DeliveryStatusReport["action"];
  let status = /^status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(hay)?.[1] ?? null;
  const diag = /^diagnostic-code:\s*(?:[\w-]+\s*;)?\s*(.+(?:\r?\n[ \t]+.+)*)/im.exec(hay);
  let diagnostic = diag ? diag[1]!.replace(/\r?\n[ \t]+/g, " ").trim() : null;

  // No machine-readable part (Graph / webhook / prose-only NDR): read the notification's text.
  const human = text.slice(0, 8000);
  if (recipients.size === 0) {
    for (const a of human.match(ADDRESS_RE) ?? []) {
      const addr = a.toLowerCase().replace(/[.>]+$/, "");
      if (!DAEMON_SENDER.test(addr)) recipients.add(addr);
    }
  }
  if (!status) status = /(?<![\d.])([245]\.\d{1,3}\.\d{1,3})(?!\.?\d)/.exec(human)?.[1] ?? null;
  if (!diagnostic) diagnostic = /\b[45]\d\d[- ](?:[45]\.\d{1,3}\.\d{1,3}[ -])?[^\r\n]{3,300}/.exec(human)?.[0]?.trim() ?? null;
  if (!action) {
    if (status?.startsWith("4.")) action = "delayed";
    else if (status?.startsWith("5.")) action = "failed";
    else if (/delay|still (being )?retr|will (be )?retr|not yet been delivered|warning/i.test(`${msg.subject ?? ""}\n${human.slice(0, 1500)}`)) action = "delayed";
    else if (worded) action = "failed";
  }

  let kind: DeliveryStatusReport["kind"];
  if (action === "delayed" || status?.startsWith("4.")) kind = "soft";
  else if (action !== "failed") kind = "other"; // delivered / relayed / unknown — not a bounce
  else {
    const cls = classifySmtpFailure({
      response: diagnostic ?? "",
      ...(status ? { enhancedStatus: status } : {}),
      // Prose-only notification: let the wording decide ("address couldn't be found").
      ...(!diagnostic && !status ? { message: human.slice(0, 1500) } : {}),
    });
    kind = cls.status === "bounced" ? "hard" : "other";
  }

  const own = (msg.messageId ?? "").replace(/^<|>$/g, "");
  const ids = new Set<string>();
  for (const m of hay.matchAll(/^message-id:\s*<?([^<>\s]+@[^<>\s]+)>?/gim)) ids.add(m[1]!);
  for (const m of `${msg.inReplyTo ?? ""} ${msg.references ?? ""}`.matchAll(/<?([^<>\s,]+@[^<>\s,]+)>?/g)) ids.add(m[1]!);
  ids.delete(own);

  return { recipients: [...recipients], action, status, diagnostic: diagnostic ? diagnostic.slice(0, 300) : null, originalMessageIds: [...ids], kind };
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
  /** Raw header block — bulk/list detection and delivery-status recognition read it. */
  headers?: string | null;
  /** Raw source, kept only for messages that look like delivery-status notifications. */
  raw?: string | null;
}

/** Where to resume an IMAP poll: a UID is only meaningful within its UIDVALIDITY. */
export interface ImapPosition {
  uidValidity: string;
  lastUid: number;
}

/**
 * An open IMAP session over the merchant's INBOX. CRITICAL: reads are PEEK-only —
 * we NEVER set the \Seen flag, because this is the merchant's real business inbox,
 * not a dedicated address. Dedup is our responsibility (by Message-Id), not theirs.
 */
export interface ImapSession {
  /**
   * Fetch new messages. With `after` (and an unchanged UIDVALIDITY) only UIDs above it are
   * read — nothing already seen is downloaded again. Otherwise messages received strictly
   * after `since` (null = a sensible default window). PEEK, no flag change.
   */
  fetchSince(since: Date | null, after?: ImapPosition | null): Promise<ImapMessage[]>;
  /** The position reached by the last `fetchSince` (null when the server did not report one). */
  position?(): ImapPosition | null;
  close(): Promise<void>;
}

export type ImapSessionFactory = (cfg: ImapConfig) => Promise<ImapSession>;

/** First-poll lookback when a mailbox has no cursor yet (avoids scanning years of mail). */
const DEFAULT_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
/** Raw source kept per suspected delivery-status notification (they are small). */
const MAX_DSN_RAW_BYTES = 256 * 1024;

function parseImapCursor(cursor: string | null | undefined): ImapPosition | null {
  const m = /^imap:([^:]+):(\d+)$/.exec(cursor ?? "");
  return m ? { uidValidity: m[1]!, lastUid: Number(m[2]) } : null;
}

/**
 * IMAP reply poller (OUTREACH-SPEC §16 #2) — the SMTP-rail inbound transport. Opens the
 * merchant's mailbox, fetches messages newer than the stored cursor WITHOUT touching flags,
 * and normalizes each to an InboundReply (recognizing bounces and bulk mail). The scheduler
 * dedups by Message-Id and routes through `processInboundReply`. imapflow + mailparser are
 * OPTIONAL deps, dynamically imported by the default factory (same pattern as nodemailer); a
 * factory is injectable for offline tests.
 *
 * `cursor` is the UID position from the previous poll (`nextCursor`). IMAP's own SINCE is
 * day-granular, so a time cursor alone re-downloaded the whole day's inbox on every tick.
 */
export class ImapReplyIngestion implements ReplyIngestionSource {
  readonly kind = "imap";
  nextCursor: string | null = null;
  constructor(
    private readonly opts: { config: ImapConfig; since?: Date | null; cursor?: string | null; factory?: ImapSessionFactory },
  ) {}

  async poll(): Promise<InboundReply[]> {
    const factory = this.opts.factory ?? defaultImapSessionFactory;
    const since = this.opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    const session = await factory(this.opts.config);
    try {
      const messages = await session.fetchSince(since, parseImapCursor(this.opts.cursor));
      const pos = session.position?.() ?? null;
      this.nextCursor = pos ? `imap:${pos.uidValidity}:${pos.lastUid}` : (this.opts.cursor ?? null);
      return messages.map((m) => {
        const from = parseAddress(m.from);
        const bounce = parseDeliveryStatus({ from: m.from, subject: m.subject, headers: m.headers, text: m.text, raw: m.raw, inReplyTo: m.inReplyTo, references: m.references, messageId: m.messageId });
        return {
          toEmail: parseAddress(m.to),
          fromEmail: from,
          subject: m.subject,
          body: extractReplyText(m.text),
          messageId: m.messageId || contentKey(from, [m.subject, m.receivedAt, m.text]),
          inReplyTo: m.inReplyTo ?? null,
          references: m.references ?? null,
          receivedAt: m.receivedAt,
          ...(bounce ? { bounce } : {}),
          ...(isBulkMail(m.headers ?? "") ? { bulk: true } : {}),
        };
      });
    } finally {
      await session.close().catch(() => {});
    }
  }
}

/**
 * Default IMAP session backed by imapflow + mailparser (both optional). Uses BODY.PEEK
 * (imapflow's `source` does not set \Seen) so the merchant's unread state is untouched.
 * Throws a clear, actionable error if the libraries aren't installed.
 *
 * NOT validated against a live IMAP server — the UID-range fetch and the mailbox
 * `uidValidity`/`uidNext` fields follow imapflow's documentation.
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
  let reached: ImapPosition | null = null;
  return {
    async fetchSince(since, after) {
      const out: ImapMessage[] = [];
      const uidValidity = client.mailbox?.uidValidity != null ? String(client.mailbox.uidValidity) : null;
      // Resume by UID only inside the same UIDVALIDITY; a reset makes old UIDs meaningless.
      const byUid = after != null && uidValidity != null && after.uidValidity === uidValidity;
      const query = byUid ? { uid: `${after.lastUid + 1}:*` } : since ? { since } : { all: true };
      let maxUid = byUid ? after.lastUid : 0;
      // `source` uses BODY.PEEK[] — this does NOT mark messages \Seen.
      for await (const msg of client.fetch(query, { uid: true, envelope: true, source: true, internalDate: true })) {
        // `n:*` always returns the newest message, even when its UID is below n.
        if (byUid && msg.uid <= after.lastUid) continue;
        if (msg.uid > maxUid) maxUid = msg.uid;
        const source = Buffer.isBuffer(msg.source) ? msg.source.toString("utf8") : String(msg.source ?? "");
        const parsed = await mailparser.simpleParser(msg.source);
        const env = msg.envelope ?? {};
        const from = parsed.from?.value?.[0]?.address ?? env.from?.[0]?.address ?? "";
        const to = parsed.to?.value?.[0]?.address ?? env.to?.[0]?.address ?? "";
        const receivedAt = (msg.internalDate ?? env.date ?? parsed.date ?? new Date()).toISOString?.() ?? new Date().toISOString();
        // Defence in depth: imapflow's `since` is date-granular, so re-filter by exact time.
        if (!byUid && since && new Date(receivedAt).getTime() <= since.getTime()) continue;
        const headers = headerBlockOf(source);
        const looksLikeDsn = DAEMON_SENDER.test(String(from)) || /multipart\/report|delivery-status/i.test(headerValue(headers, "content-type") ?? "");
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
          headers,
          ...(looksLikeDsn ? { raw: source.slice(0, MAX_DSN_RAW_BYTES) } : {}),
        });
      }
      // Everything below UIDNEXT has now been seen or deliberately skipped as too old.
      const uidNext = Number(client.mailbox?.uidNext ?? 0);
      const lastUid = Math.max(maxUid, uidNext > 0 ? uidNext - 1 : 0);
      reached = uidValidity != null && lastUid > 0 ? { uidValidity, lastUid } : null;
      return out;
    },
    position() {
      return reached;
    },
    async close() {
      lock.release();
      await client.logout().catch(() => client.close?.());
    },
  };
};

/** The read side of the HTTP client the Graph poller needs (`FetchJsonClient` satisfies it). */
export interface GraphHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
}

const GRAPH_INBOX = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";
const GRAPH_SELECT = "id,internetMessageId,subject,from,toRecipients,receivedDateTime,body,uniqueBody,internetMessageHeaders";

/**
 * Microsoft Graph reply poller — the inbound side of the Microsoft OAuth rail (delegated
 * `Mail.Read`, which the connect flow already requests). Lists the signed-in user's Inbox
 * for messages received at/after the stored cursor, oldest first, read-only (a GET never
 * changes `isRead`), and normalizes each to an InboundReply — the same contract as the IMAP
 * poller, so bounce (NDR) recognition, bulk filtering and routing are shared.
 *
 * The cursor is the newest `receivedDateTime` seen (the server's clock, so no skew against
 * ours); the filter is inclusive and Message-Id dedup absorbs the one-message overlap. An
 * auth failure throws: the caller records the mailbox's inbound path as broken, which holds
 * its follow-ups until it is reconnected.
 *
 * NOT validated against live Graph — written from the documented `messages` API ($filter +
 * $orderby on receivedDateTime, `Prefer: outlook.body-content-type="text"`, `uniqueBody`,
 * `internetMessageHeaders`). No real tenant has been polled.
 */
export class GraphReplyIngestion implements ReplyIngestionSource {
  readonly kind = "graph";
  nextCursor: string | null = null;
  constructor(
    private readonly opts: { accessToken: string; http: GraphHttpClient; since?: Date | null; cursor?: string | null; mailboxEmail?: string; maxMessages?: number },
  ) {}

  async poll(): Promise<InboundReply[]> {
    const fromCursor = /^graph:(.+)$/.exec(this.opts.cursor ?? "")?.[1];
    const since = fromCursor && !Number.isNaN(Date.parse(fromCursor)) ? new Date(fromCursor) : (this.opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS));
    const headers = { Authorization: `Bearer ${this.opts.accessToken}`, Prefer: 'outlook.body-content-type="text"' };
    const max = this.opts.maxMessages ?? 200;
    let url: string | null =
      `${GRAPH_INBOX}?$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` +
      `&$orderby=${encodeURIComponent("receivedDateTime asc")}&$top=50&$select=${GRAPH_SELECT}`;
    const out: InboundReply[] = [];
    let newest = since.getTime();
    while (url && out.length < max) {
      const res: { status: number; json: any } = await this.opts.http.get(url, headers);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`microsoft inbox read was refused (${res.status}) — reconnect the mailbox and grant Mail.Read`);
      }
      if (res.status >= 300) throw new Error(`microsoft inbox read failed (${res.status})`);
      for (const m of (res.json?.value ?? []) as any[]) {
        const hdrs = ((m.internetMessageHeaders ?? []) as Array<{ name?: string; value?: string }>).map((h) => `${h.name ?? ""}: ${h.value ?? ""}`).join("\r\n");
        const from = parseAddress(m.from?.emailAddress?.address ?? "");
        // `uniqueBody` is Graph's own "new text of this message" (no quoted history).
        const text = String(m.uniqueBody?.content || m.body?.content || "");
        const full = String(m.body?.content ?? text);
        const messageId = String(m.internetMessageId ?? "").replace(/^<|>$/g, "");
        const receivedAt = String(m.receivedDateTime ?? new Date().toISOString());
        const at = Date.parse(receivedAt);
        if (!Number.isNaN(at) && at > newest) newest = at;
        const inReplyTo = headerValue(hdrs, "in-reply-to");
        const references = headerValue(hdrs, "references");
        const bounce = parseDeliveryStatus({ from, subject: m.subject, headers: hdrs, text: full, inReplyTo, references, messageId });
        out.push({
          toEmail: parseAddress(m.toRecipients?.[0]?.emailAddress?.address ?? this.opts.mailboxEmail ?? ""),
          fromEmail: from,
          subject: String(m.subject ?? ""),
          body: extractReplyText(text),
          messageId: messageId || contentKey(from, [String(m.subject ?? ""), receivedAt, text]),
          inReplyTo,
          references,
          receivedAt,
          ...(bounce ? { bounce } : {}),
          ...(isBulkMail(hdrs) ? { bulk: true } : {}),
        });
      }
      url = typeof res.json?.["@odata.nextLink"] === "string" ? res.json["@odata.nextLink"] : null;
    }
    this.nextCursor = `graph:${new Date(newest).toISOString()}`;
    return out;
  }
}

/** Parse an ESP inbound-parse webhook payload into a normalized reply. An empty extracted
 * body is kept (routed to human review), never re-hydrated from the raw email. */
export function parseInboundWebhook(payload: any): InboundReply | null {
  if (!payload) return null;
  // `Name <addr>` is what every ESP sends; compare addresses, not display strings.
  const toEmail = parseAddress(payload.to ?? payload.recipient ?? payload.To ?? "");
  const fromEmail = parseAddress(payload.from ?? payload.sender ?? payload.From ?? "");
  if (!fromEmail) return null;
  const subject = String(payload.subject ?? payload.Subject ?? "");
  const rawText = String(payload.text ?? payload["body-plain"] ?? payload.body ?? "");
  const headers = typeof payload.headers === "string" ? payload.headers : typeof payload["message-headers"] === "string" ? payload["message-headers"] : "";
  const inReplyTo = payload.inReplyTo ?? payload["In-Reply-To"] ?? headerValue(headers, "in-reply-to") ?? null;
  const references = payload.references ?? payload.References ?? headerValue(headers, "references") ?? null;
  const givenId = payload.messageId ?? payload["Message-Id"] ?? payload["Message-ID"] ?? headerValue(headers, "message-id");
  const messageId = givenId ? String(givenId).replace(/^<|>$/g, "") : contentKey(fromEmail, [toEmail, subject, String(payload.date ?? payload.Date ?? payload.timestamp ?? ""), rawText]);
  const bounce = parseDeliveryStatus({ from: fromEmail, subject, headers, text: rawText, inReplyTo, references, messageId });
  return {
    toEmail,
    fromEmail,
    subject,
    body: extractReplyText(rawText),
    messageId,
    inReplyTo,
    references,
    receivedAt: new Date().toISOString(),
    ...(bounce ? { bounce } : {}),
    ...(isBulkMail(headers) ? { bulk: true } : {}),
  };
}
