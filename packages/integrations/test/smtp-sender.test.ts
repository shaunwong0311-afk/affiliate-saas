import { describe, it, expect } from "vitest";
import { SmtpSender, buildMailboxSender } from "../src/index.js";
import type { SmtpTransport, OutboundEmail, MailboxCredentials } from "../src/index.js";

const email: OutboundEmail = {
  fromName: "Lumen Skincare",
  fromEmail: "team@lumen.com",
  toEmail: "creator@example.com",
  subject: "Partner with us",
  body: "Hi — loved your reviews.",
};

/** A fake nodemailer transport that records calls and returns a scripted result. */
function fakeTransport(opts: { rejected?: string[]; throwMsg?: string; verifyOk?: boolean } = {}) {
  const sent: any[] = [];
  const t: SmtpTransport & { sent: () => any[] } = {
    sent: () => sent,
    async sendMail(msg) {
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      sent.push(msg);
      return { messageId: "<abc@lumen.com>", accepted: ["creator@example.com"], rejected: opts.rejected ?? [] };
    },
    async verify() {
      if (opts.verifyOk === false) throw new Error("535 auth failed");
      return true;
    },
  };
  return t;
}

describe("SmtpSender", () => {
  it("sends via SMTP and returns sent with the message id", async () => {
    const t = fakeTransport();
    const sender = new SmtpSender({ host: "smtp.host.com", port: 587, user: "u", pass: "p" }, () => t);
    const r = await sender.send(email);
    expect(r.status).toBe("sent");
    expect(r.messageId).toBe("<abc@lumen.com>");
    expect(t.sent()[0]).toMatchObject({ from: "Lumen Skincare <team@lumen.com>", to: "creator@example.com", subject: "Partner with us", text: "Hi — loved your reviews." });
  });

  it("sets threading headers when inReplyTo is present", async () => {
    const t = fakeTransport();
    const sender = new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => t);
    await sender.send({ ...email, inReplyTo: "<prev@x.com>" });
    expect(t.sent()[0]).toMatchObject({ inReplyTo: "<prev@x.com>", references: "<prev@x.com>" });
  });

  it("returns bounced when the recipient is rejected by the server", async () => {
    const sender = new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ rejected: ["creator@example.com"] }));
    const r = await sender.send(email);
    expect(r.status).toBe("bounced");
  });

  it("classifies a 5xx error as a hard bounce, other errors as transient failure", async () => {
    const bounce = await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ throwMsg: "550 user unknown" })).send(email);
    expect(bounce.status).toBe("bounced");
    const fail = await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ throwMsg: "ETIMEDOUT connection" })).send(email);
    expect(fail.status).toBe("failed");
  });

  it("verify() reports connection/auth health (for the connect test step)", async () => {
    expect(await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport()).verify()).toEqual({ ok: true });
    const bad = await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ verifyOk: false })).verify();
    expect(bad.ok).toBe(false);
  });

  it("defaults secure=true for port 465", async () => {
    let received: any = null;
    const sender = new SmtpSender({ host: "h", port: 465, user: "u", pass: "p" }, (cfg) => {
      received = cfg;
      return fakeTransport();
    });
    await sender.send(email);
    expect(received.secure).toBe(true);
  });
});

describe("buildMailboxSender", () => {
  it("builds an SMTP sender from smtp credentials", () => {
    const creds: MailboxCredentials = { kind: "smtp", host: "h", port: 587, user: "u", pass: "p" };
    expect(buildMailboxSender(creds).provider).toBe("smtp");
  });
  it("builds Graph / Gmail senders from oauth credentials", () => {
    expect(buildMailboxSender({ kind: "microsoft", accessToken: "t" }).provider).toBe("microsoft");
    expect(buildMailboxSender({ kind: "gmail_oauth", accessToken: "t" }).provider).toBe("gmail");
  });
  it("falls back to the mock when credentials are incomplete", () => {
    expect(buildMailboxSender({ kind: "smtp", host: "h" }).provider).toBe("mock"); // missing port/user/pass
    expect(buildMailboxSender({ kind: "microsoft" }).provider).toBe("mock"); // no access token
  });
});
