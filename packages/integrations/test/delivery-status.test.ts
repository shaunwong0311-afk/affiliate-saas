import { describe, it, expect } from "vitest";
import { parseDeliveryStatus, ImapReplyIngestion, parseInboundWebhook, type ImapMessage, type ImapSession } from "../src/index.js";

/**
 * AUDIT-2026-10 O6 — nothing parsed the delivery-status notifications (bounces) that arrive
 * in the merchant's inbox; only synchronous SMTP rejections were ever seen. Real relays
 * accept a message and bounce it later.
 */

/** An RFC 3464 multipart/report as Postfix generates it. */
function postfixDsn(opts: { status: string; diagnostic: string; action?: string; recipient?: string; originalId?: string }): string {
  const rcpt = opts.recipient ?? "creator@site.com";
  return [
    "Return-Path: <>",
    "From: MAILER-DAEMON@mx.lumen.com (Mail Delivery System)",
    "To: team@lumen.com",
    "Subject: Undelivered Mail Returned to Sender",
    "Message-Id: <20260702150000.4F3A1@mx.lumen.com>",
    'Content-Type: multipart/report; report-type=delivery-status;',
    '\tboundary="B0UND"',
    "MIME-Version: 1.0",
    "",
    "--B0UND",
    "Content-Description: Notification",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "This is the mail system at host mx.lumen.com.",
    "I'm sorry to have to inform you that your message could not",
    "be delivered to one or more recipients.",
    "",
    `<${rcpt}>: host mx.site.com[198.51.100.9] said: ${opts.diagnostic}`,
    "",
    "--B0UND",
    "Content-Description: Delivery report",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.lumen.com",
    "Arrival-Date: Thu,  2 Jul 2026 15:00:00 +0000 (UTC)",
    "",
    `Final-Recipient: rfc822; ${rcpt}`,
    `Original-Recipient: rfc822;${rcpt}`,
    `Action: ${opts.action ?? "failed"}`,
    `Status: ${opts.status}`,
    "Remote-MTA: dns; mx.site.com",
    `Diagnostic-Code: smtp; ${opts.diagnostic}`,
    "",
    "--B0UND",
    "Content-Description: Undelivered Message Headers",
    "Content-Type: text/rfc822-headers",
    "",
    "From: Lumen Skincare <team@lumen.com>",
    `To: ${rcpt}`,
    "Subject: Partnering with Lumen Skincare",
    `Message-ID: ${opts.originalId ?? "<our-first-touch@lumen.com>"}`,
    "",
    "--B0UND--",
    "",
  ].join("\r\n");
}

const headersOf = (raw: string) => raw.slice(0, raw.indexOf("\r\n\r\n"));

describe("parseDeliveryStatus", () => {
  it("reads a hard bounce: recipient, status, diagnostic and OUR original Message-Id", () => {
    const raw = postfixDsn({ status: "5.1.1", diagnostic: "550 5.1.1 <creator@site.com>: Recipient address rejected: User unknown in virtual mailbox table (in reply to RCPT TO command)" });
    const report = parseDeliveryStatus({ from: "MAILER-DAEMON@mx.lumen.com", subject: "Undelivered Mail Returned to Sender", headers: headersOf(raw), raw, text: "", messageId: "20260702150000.4F3A1@mx.lumen.com" });
    expect(report).not.toBeNull();
    expect(report!.kind).toBe("hard");
    expect(report!.action).toBe("failed");
    expect(report!.status).toBe("5.1.1");
    expect(report!.recipients).toEqual(["creator@site.com"]);
    expect(report!.diagnostic).toContain("User unknown");
    expect(report!.originalMessageIds).toContain("our-first-touch@lumen.com");
    expect(report!.originalMessageIds).not.toContain("20260702150000.4F3A1@mx.lumen.com"); // not the report's own id
  });

  it("a permanent failure that is NOT the recipient's address is not a hard bounce", () => {
    const blocked = postfixDsn({ status: "5.7.1", diagnostic: "554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org" });
    expect(parseDeliveryStatus({ from: "MAILER-DAEMON@mx.lumen.com", headers: headersOf(blocked), raw: blocked })!.kind).toBe("other");
    const full = postfixDsn({ status: "5.2.2", diagnostic: "552 5.2.2 The email account that you tried to reach is over quota" });
    expect(parseDeliveryStatus({ from: "MAILER-DAEMON@mx.lumen.com", headers: headersOf(full), raw: full })!.kind).toBe("other");
  });

  it("a delay notice is soft — nothing has failed yet", () => {
    const raw = postfixDsn({ action: "delayed", status: "4.4.1", diagnostic: "connect to mx.site.com[198.51.100.9]:25: Connection timed out" });
    const report = parseDeliveryStatus({ from: "MAILER-DAEMON@mx.lumen.com", subject: "Delayed Mail (still being retried)", headers: headersOf(raw), raw });
    expect(report!.kind).toBe("soft");
    expect(report!.action).toBe("delayed");
  });

  it("prefers a specific code in the diagnostic over a generic 5.0.0 status", () => {
    const raw = postfixDsn({ status: "5.0.0", diagnostic: "550 5.1.1 The email account that you tried to reach does not exist." });
    expect(parseDeliveryStatus({ from: "MAILER-DAEMON@mx.lumen.com", headers: headersOf(raw), raw })!.kind).toBe("hard");
  });

  it("reads a prose-only notification (no machine-readable part) — the Graph / webhook case", () => {
    // An Exchange NDR as its text body reads; the headers are what Graph exposes.
    const text = [
      "Your message to creator@site.com couldn't be delivered.",
      "creator wasn't found at site.com.",
      "",
      "Diagnostic information for administrators:",
      "Generating server: BN8PR01MB1234.prod.exchangelabs.com",
      "creator@site.com",
      "Remote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'",
      "",
      "Original message headers:",
      "Message-ID: <our-first-touch@lumen.com>",
      "From: Lumen Skincare <team@lumen.com>",
    ].join("\n");
    const report = parseDeliveryStatus({
      from: "postmaster@lumen.com",
      subject: "Undeliverable: Partnering with Lumen Skincare",
      headers: "X-MS-Exchange-Message-Is-Ndr: \r\nContent-Type: multipart/report; report-type=delivery-status; boundary=x",
      text,
      inReplyTo: "<our-first-touch@lumen.com>",
    });
    expect(report!.kind).toBe("hard");
    expect(report!.status).toBe("5.1.10");
    expect(report!.recipients).toContain("creator@site.com");
    expect(report!.originalMessageIds).toContain("our-first-touch@lumen.com");
  });

  it("recognizes exim / Gmail style X-Failed-Recipients", () => {
    const report = parseDeliveryStatus({
      from: "mailer-daemon@googlemail.com",
      subject: "Delivery Status Notification (Failure)",
      headers: "X-Failed-Recipients: creator@site.com\r\nContent-Type: text/plain",
      text: "Address not found\nYour message wasn't delivered to creator@site.com because the address couldn't be found, or is unable to receive mail.\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.",
    });
    expect(report!.recipients).toEqual(["creator@site.com"]);
    expect(report!.kind).toBe("hard");
  });

  it("returns null for ordinary mail — a reply is never read as a bounce", () => {
    expect(parseDeliveryStatus({ from: "creator@site.com", subject: "Re: Partnering with Lumen", headers: "Content-Type: text/plain; charset=utf-8", text: "Sounds great — what's the commission?" })).toBeNull();
    // Even a person writing ABOUT a bounce is not a daemon.
    expect(parseDeliveryStatus({ from: "creator@site.com", subject: "Undeliverable?", headers: "Content-Type: text/plain", text: "Your last email said undeliverable — can you resend it to my other address?" })).toBeNull();
    // A postmaster address writing ordinary mail (no DSN wording, no report) is not a bounce either.
    expect(parseDeliveryStatus({ from: "postmaster@site.com", subject: "Hello", headers: "Content-Type: text/plain", text: "Hi, we run the mail server here and wanted to say hello." })).toBeNull();
  });
});

describe("inbound transports mark bounces and bulk mail", () => {
  function session(messages: ImapMessage[]): () => Promise<ImapSession> {
    return async () => ({ async fetchSince() { return messages; }, async close() {} });
  }
  const base: ImapMessage = { uid: 7, from: "creator@site.com", to: "team@lumen.com", subject: "Re: hi", text: "Yes!", messageId: "m-1", receivedAt: "2026-07-02T15:00:00.000Z" };

  it("the IMAP poller flags a delivery-status notification as a bounce, not a reply", async () => {
    const raw = postfixDsn({ status: "5.1.1", diagnostic: "550 5.1.1 User unknown" });
    const dsn: ImapMessage = { ...base, uid: 8, from: "mailer-daemon@mx.lumen.com", subject: "Undelivered Mail Returned to Sender", text: "your message could not be delivered", messageId: "20260702150000.4F3A1@mx.lumen.com", headers: headersOf(raw), raw };
    const [reply, bounce] = await new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, factory: session([base, dsn]) }).poll();
    expect(reply!.bounce).toBeUndefined();
    expect(bounce!.bounce).toMatchObject({ kind: "hard", recipients: ["creator@site.com"] });
  });

  it("flags list/bulk mail by its headers (a newsletter is not a reply)", async () => {
    const newsletter: ImapMessage = { ...base, uid: 9, subject: "This week on the blog", text: "New post!\n\nUnsubscribe", messageId: "m-2", headers: "List-Unsubscribe: <https://site.com/u>\r\nList-Id: <weekly.site.com>\r\nPrecedence: bulk" };
    // An out-of-office auto-REPLY is a real signal about the prospect — not bulk.
    const ooo: ImapMessage = { ...base, uid: 10, subject: "Automatic reply", text: "I'm out of office until July 9.", messageId: "m-3", headers: "Auto-Submitted: auto-replied" };
    const [plain, bulk, auto] = await new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, factory: session([base, newsletter, ooo]) }).poll();
    expect(plain!.bulk).toBeUndefined();
    expect(bulk!.bulk).toBe(true);
    expect(auto!.bulk).toBeUndefined();
  });

  it("the inbound webhook recognizes a bounce payload when the provider forwards headers", () => {
    const inbound = parseInboundWebhook({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      to: "team@lumen.com",
      subject: "Delivery Status Notification (Failure)",
      headers: "X-Failed-Recipients: creator@site.com\r\nContent-Type: multipart/report; report-type=delivery-status",
      text: "Address not found\n550 5.1.1 The email account that you tried to reach does not exist.",
    });
    expect(inbound!.bounce).toMatchObject({ kind: "hard", recipients: ["creator@site.com"] });
  });
});
