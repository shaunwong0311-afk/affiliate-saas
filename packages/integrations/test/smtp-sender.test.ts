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
function fakeTransport(opts: { rejected?: string[]; rejectedErrors?: Array<{ recipient?: string; responseCode?: number; response?: string }>; throwMsg?: string; verifyOk?: boolean } = {}) {
  const sent: any[] = [];
  const t: SmtpTransport & { sent: () => any[] } = {
    sent: () => sent,
    async sendMail(msg) {
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      sent.push(msg);
      return { messageId: "<abc@lumen.com>", accepted: ["creator@example.com"], rejected: opts.rejected ?? [], ...(opts.rejectedErrors ? { rejectedErrors: opts.rejectedErrors } : {}) };
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

  // CHANGED by AUDIT-2026-10 O2. This test used to assert that ANY recipient the server refused
  // at RCPT is a hard bounce. A refusal is a bounce only when the server says the ADDRESS is
  // permanently bad; a greylist (4xx), a relay/policy refusal or a refusal with no stated
  // reason is a failure to retry — the prospect must not be burned for it.
  it("a recipient the server refused is a bounce only when the address itself is permanently bad", async () => {
    const send = (rejectedErrors?: Array<{ recipient?: string; responseCode?: number; response?: string }>) =>
      new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ rejected: ["creator@example.com"], rejectedErrors })).send(email);

    const unknown = await send([{ recipient: "creator@example.com", responseCode: 550, response: "550 5.1.1 <creator@example.com>: Recipient address rejected: User unknown in virtual mailbox table" }]);
    expect(unknown.status).toBe("bounced");

    const greylisted = await send([{ recipient: "creator@example.com", responseCode: 450, response: "450 4.7.1 <creator@example.com>: Recipient address rejected: Greylisted, try again later" }]);
    expect(greylisted).toMatchObject({ status: "failed", failure: "recipient" });

    const relayDenied = await send([{ recipient: "creator@example.com", responseCode: 554, response: "554 5.7.1 <creator@example.com>: Relay access denied" }]);
    expect(relayDenied.status).toBe("failed");

    const noReason = await send(undefined);
    expect(noReason.status).toBe("failed");
  });

  // CHANGED by AUDIT-2026-10 O2. This test was titled "classifies a 5xx error as a hard bounce"
  // — the defect itself: 553 sender-rejected, a 550 quota and a host limit all burned the
  // prospect. Only a recipient-level permanent failure is a bounce (full table in
  // send-classification.test.ts).
  it("a 5xx is a hard bounce ONLY when it names the recipient's address; anything else is a failure", async () => {
    const send = (throwMsg: string) => new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => fakeTransport({ throwMsg })).send(email);
    expect((await send("550 user unknown")).status).toBe("bounced");
    expect((await send("ETIMEDOUT connection")).status).toBe("failed");
    expect((await send("553 sender rejected")).status).toBe("failed");
    expect((await send("550 5.4.5 Daily user sending quota exceeded")).status).toBe("failed");
    expect((await send('550 "Domain lumen.com has exceeded the max emails per hour (25/25 (100%)) allowed.  Message discarded."')).status).toBe("failed");
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
    // Recipient-level 550 with a responseCode → hard bounce. (CHANGED by AUDIT-2026-10 O2: the
    // fixture used to be a bare "Recipient address rejected" + 550, which is also how Postfix
    // prefixes its POLICY rejections — the reply now says what a real unknown-user reply says.)
    const rej = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <creator@example.com>: Recipient address rejected: User unknown"), {
      code: "EENVELOPE",
      command: "RCPT TO",
      responseCode: 550,
      response: "550 5.1.1 <creator@example.com>: Recipient address rejected: User unknown",
    });
    expect((await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => throwing(rej)).send(email)).status).toBe("bounced");
    // The same prefix with a POLICY reason is not a bounce.
    const policy = Object.assign(new Error("Recipient address rejected: Access denied"), { code: "EENVELOPE", command: "RCPT TO", responseCode: 554, response: "554 5.7.1 <creator@example.com>: Recipient address rejected: Access denied" });
    expect((await new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => throwing(policy)).send(email)).status).toBe("failed");
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
  // CHANGED by AUDIT-2026-10 O4. This test used to assert a fallback to the MOCK sender, which
  // answers `sent` for mail that never leaves. Credentials that cannot build their rail now
  // yield a sender that fails with the reason.
  it("fails closed — never the mock — when credentials are incomplete", async () => {
    const smtp = buildMailboxSender({ kind: "smtp", host: "h" }); // missing port/user/pass
    const graph = buildMailboxSender({ kind: "microsoft" }); // no access token
    for (const sender of [smtp, graph]) {
      expect(sender.provider).not.toBe("mock");
      const r = await sender.send(email);
      expect(r.status).toBe("failed");
      expect(r.messageId).toBe("");
      expect(r.reason).toBeTruthy();
    }
  });
});
