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

  it("passes custom headers (e.g. List-Unsubscribe) through to the transport", async () => {
    const t = fakeTransport();
    const sender = new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => t);
    await sender.send({ ...email, headers: { "List-Unsubscribe": "<https://x/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    expect(t.sent()[0].headers).toMatchObject({ "List-Unsubscribe": "<https://x/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
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

  it("never mistakes the SMTP port in a connection error for a 5xx bounce code", async () => {
    // "587" used to match the old \b5\d\d\b regex → one outage mass-suppressed prospects.
    const r = await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ throwMsg: "connect ECONNREFUSED 192.168.1.10:587" })).send(email);
    expect(r.status).toBe("failed");
  });

  it("classifies from the real SMTP responseCode, and never treats auth errors as bounces", async () => {
    const throwing = (err: Error & { code?: string; responseCode?: number }): SmtpTransport => ({
      async sendMail() {
        throw err;
      },
      async verify() {
        return true;
      },
    });
    // Recipient-level 550 with a responseCode → hard bounce.
    const rej = Object.assign(new Error("Recipient address rejected"), { responseCode: 550 });
    expect((await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => throwing(rej)).send(email)).status).toBe("bounced");
    // EAUTH carries a 535 responseCode but is a MAILBOX problem, not a recipient bounce.
    const auth = Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
    expect((await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => throwing(auth)).send(email)).status).toBe("failed");
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

describe("OAuth-rail parity (Graph / Gmail)", () => {
  const withHeaders = { ...email, inReplyTo: "<prev@x.com>", headers: { "List-Unsubscribe": "<https://x/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };

  function capturingHttp(status = 202) {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    return {
      calls,
      async post(url: string, body: unknown, headers: Record<string, string>) {
        calls.push({ url, body, headers });
        return { status, json: status < 300 ? {} : { error: { code: "ErrorInvalidRecipients" } } };
      },
    };
  }

  it("Graph sends RAW MIME carrying List-Unsubscribe + threading, and returns a stamped message id", async () => {
    const http = capturingHttp(202);
    const { MicrosoftGraphSender } = await import("../src/index.js");
    const r = await new MicrosoftGraphSender({ accessToken: "t", http }).send(withHeaders);
    expect(r.status).toBe("sent");
    expect(r.messageId).toMatch(/@/); // a real Message-Id we can thread/correlate on
    expect(http.calls[0].headers["Content-Type"]).toBe("text/plain"); // raw MIME, not the structured object
    const mime = Buffer.from(http.calls[0].body as string, "base64").toString("utf8");
    expect(mime).toContain("List-Unsubscribe: <https://x/u>");
    expect(mime).toContain("In-Reply-To: <prev@x.com>");
    expect(mime).toContain("References: <prev@x.com>");
  });

  it("Graph maps a recipient-level error to a hard bounce (not a generic failure)", async () => {
    const { MicrosoftGraphSender } = await import("../src/index.js");
    const r = await new MicrosoftGraphSender({ accessToken: "t", http: capturingHttp(400) }).send(email);
    expect(r.status).toBe("bounced");
  });

  it("Gmail MIME includes List-Unsubscribe + References", async () => {
    const http = capturingHttp(200);
    const { GmailSender } = await import("../src/index.js");
    await new GmailSender({ accessToken: "t", http }).send(withHeaders);
    const raw = Buffer.from((http.calls[0].body as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain("List-Unsubscribe:");
    expect(raw).toContain("References: <prev@x.com>");
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
