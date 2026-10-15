import { describe, it, expect } from "vitest";
import { buildRfc822, newMessageId, GmailSender, MicrosoftGraphSender, SmtpSender, MockMailboxSender } from "../src/index.js";
import type { OutboundEmail, SmtpTransport } from "../src/index.js";

/**
 * AUDIT-2026-10 O9 — the raw MIME builder used by the Gmail and Graph rails dropped the empty
 * line between headers and body, sent non-ASCII headers raw, and the Gmail rail stored the
 * API's internal id where a Message-Id belongs (then reused it as In-Reply-To).
 */

const email: OutboundEmail = {
  fromName: "Lumen Skincare",
  fromEmail: "team@lumen.com",
  toEmail: "creator@example.com",
  subject: "Partner with us",
  body: "Hi there,\nloved your reviews.\n\n—\nLumen Skincare\n1 Market St",
};

/** Split a raw message at the header/body separator. */
function parts(raw: string): { headers: string; body: string } {
  const i = raw.indexOf("\r\n\r\n");
  return { headers: raw.slice(0, i), body: raw.slice(i + 4) };
}

/** Decode a quoted-printable body back to text. */
function decodeQp(body: string): string {
  const joined = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Decode RFC 2047 encoded-words in a header value. */
function decodeWords(value: string): string {
  return value.replace(/\r\n /g, "").replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

describe("buildRfc822", () => {
  it("separates headers from the body with an empty line", () => {
    const raw = buildRfc822(email);
    expect(raw).toContain("\r\n\r\n");
    const { headers, body } = parts(raw);
    // Every header is in the header block, and the body is NOT (it used to be glued onto the
    // last header line, so the whole text became part of `Content-Type`).
    expect(headers).toMatch(/^Content-Type: text\/plain; charset=UTF-8$/m);
    expect(headers).not.toContain("loved your reviews");
    expect(decodeQp(body)).toContain("loved your reviews.");
  });

  it("ends every line with CRLF — no bare LF, even when the body was written with LF", () => {
    const raw = buildRfc822(email);
    expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    // The body's own blank line survives as a blank line (it used to be filtered out too).
    expect(decodeQp(parts(raw).body)).toContain("loved your reviews.\r\n\r\n—\r\nLumen Skincare");
  });

  it("encodes non-ASCII headers (RFC 2047) and declares the body encoding", () => {
    const raw = buildRfc822({ ...email, fromName: "Crème Brûlée & Co", subject: "Partenariat — découvrez notre programme d'affiliation, c'est très intéressant pour vous" });
    const { headers, body } = parts(raw);
    expect(headers).not.toMatch(/[^\x00-\x7f]/); // header block is pure ASCII
    const subject = /^Subject: ((?:.|\r\n )*)$/m.exec(headers)![1]!;
    expect(decodeWords(subject)).toBe("Partenariat — découvrez notre programme d'affiliation, c'est très intéressant pour vous");
    // Each encoded-word stays within the 75-character limit.
    for (const word of subject.split("\r\n ")) expect(word.length).toBeLessThanOrEqual(75);
    const from = /^From: (.*)$/m.exec(headers)![1]!;
    expect(decodeWords(from)).toBe("Crème Brûlée & Co <team@lumen.com>");
    expect(headers).toMatch(/^MIME-Version: 1\.0$/m);
    expect(headers).toMatch(/^Content-Transfer-Encoding: quoted-printable$/m);
    expect(body).not.toMatch(/[^\x00-\x7f]/); // and so is the encoded body
    for (const line of body.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("always carries a Message-ID — ours when given, a fresh one otherwise", () => {
    expect(buildRfc822({ ...email, messageId: "<abc-123@lumen.com>" })).toMatch(/^Message-ID: <abc-123@lumen\.com>$/m);
    const generated = /^Message-ID: (<[^>\s]+@lumen\.com>)$/m.exec(buildRfc822(email));
    expect(generated).not.toBeNull();
    expect(newMessageId("team@lumen.com")).toMatch(/^<[0-9a-f-]{36}@lumen\.com>$/);
    expect(newMessageId("team@lumen.com")).not.toBe(newMessageId("team@lumen.com"));
  });

  it("cannot be made to inject a header through a subject or display name with a line break", () => {
    const raw = buildRfc822({ ...email, subject: "Hello\r\nBcc: attacker@evil.test", fromName: "Lumen\nX-Injected: 1" });
    const { headers } = parts(raw);
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).not.toMatch(/^X-Injected:/m);
  });

  it("quotes a display name that carries a comma instead of emitting two addresses", () => {
    const { headers } = parts(buildRfc822({ ...email, fromName: "Lumen, Inc." }));
    expect(headers).toMatch(/^From: "Lumen, Inc\." <team@lumen\.com>$/m);
  });

  it("threads with In-Reply-To and the full References chain", () => {
    const { headers } = parts(buildRfc822({ ...email, inReplyTo: "<b@lumen.com>", references: ["<a@lumen.com>", "<b@lumen.com>"] }));
    expect(headers).toMatch(/^In-Reply-To: <b@lumen\.com>$/m);
    expect(headers.replace(/\r\n /g, " ")).toMatch(/^References: <a@lumen\.com> <b@lumen\.com>$/m);
  });
});

describe("every rail reports OUR Message-Id (never a provider-internal id)", () => {
  const http = (json: unknown, status = 200) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    return { calls, async post(url: string, body: unknown) { calls.push({ url, body }); return { status, json }; } };
  };

  it("Gmail: returns the Message-Id stamped in the MIME, not the API's message id", async () => {
    const h = http({ id: "18c5f0a2b3d4e5f6", threadId: "18c5f0a2b3d4e5f6" });
    const r = await new GmailSender({ accessToken: "t", http: h }).send({ ...email, messageId: "<ours-1@lumen.com>" });
    expect(r).toMatchObject({ status: "sent", messageId: "<ours-1@lumen.com>" });
    const raw = Buffer.from((h.calls[0]!.body as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toMatch(/^Message-ID: <ours-1@lumen\.com>$/m);
    expect(raw).toContain("\r\n\r\n"); // a well-formed message reaches the API
  });

  it("Gmail and Graph stamp a Message-Id themselves when the caller passes none", async () => {
    const g = await new GmailSender({ accessToken: "t", http: http({ id: "18c5f0a2" }) }).send(email);
    expect(g.messageId).toMatch(/^<.+@lumen\.com>$/);
    const h = http({}, 202);
    const m = await new MicrosoftGraphSender({ accessToken: "t", http: h }).send(email);
    expect(m.messageId).toMatch(/^<.+@lumen\.com>$/);
    expect(Buffer.from(h.calls[0]!.body as string, "base64").toString("utf8")).toContain(`Message-ID: ${m.messageId}`);
  });

  it("SMTP: hands our Message-Id to the transport and reports it", async () => {
    const seen: any[] = [];
    const transport: SmtpTransport = { async sendMail(msg) { seen.push(msg); return { accepted: [msg.to], rejected: [] }; }, async verify() { return true; } };
    const r = await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => transport).send({ ...email, messageId: "<ours-2@lumen.com>" });
    expect(seen[0].messageId).toBe("<ours-2@lumen.com>");
    expect(r).toMatchObject({ status: "sent", messageId: "<ours-2@lumen.com>" });
  });

  it("the mock echoes the stamped id too, so dev and tests thread like production", async () => {
    expect((await new MockMailboxSender().send({ ...email, messageId: "<ours-3@lumen.com>" })).messageId).toBe("<ours-3@lumen.com>");
  });
});
