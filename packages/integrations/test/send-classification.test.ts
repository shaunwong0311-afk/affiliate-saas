import { describe, it, expect } from "vitest";
import { classifySmtpFailure, GmailSender, MicrosoftGraphSender, SmtpSender } from "../src/index.js";
import type { OutboundEmail, SmtpFailureInput, SmtpTransport } from "../src/index.js";

/**
 * AUDIT-2026-10 O2 — every SMTP 5xx used to be a recipient hard bounce: `553 sender rejected`,
 * a quota `550 5.4.5` or a host limit marked the prospect bounced and suppressed it.
 * AUDIT-2026-10 O1 — the Gmail and Graph senders threw on a network error, ending the tick.
 */

const email: OutboundEmail = { fromName: "Lumen", fromEmail: "team@lumen.com", toEmail: "creator@example.com", subject: "Hi", body: "Hello there." };

/** Reply texts as real servers send them (Postfix, Exim/cPanel, Gmail, Exchange Online). */
const BOUNCES: Array<[string, SmtpFailureInput]> = [
  ["Postfix unknown user", { responseCode: 550, command: "RCPT TO", response: "550 5.1.1 <x@y.com>: Recipient address rejected: User unknown in virtual mailbox table" }],
  ["Gmail no such account", { responseCode: 550, response: "550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address" }],
  ["Exchange recipient not found", { responseCode: 550, response: "550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup" }],
  ["Exchange Online edge block of an unknown recipient", { responseCode: 550, command: "RCPT TO", response: "550 5.4.1 Recipient address rejected: Access denied. AS(201806281)" }],
  ["disabled mailbox", { responseCode: 550, response: "550 5.2.1 The email account that you tried to reach is disabled." }],
  ["bad destination domain", { responseCode: 550, response: "550 5.1.2 Bad destination system address" }],
  ["no enhanced code, explicit wording", { responseCode: 550, command: "RCPT TO", response: "550 No such user here" }],
];

const NOT_BOUNCES: Array<[string, SmtpFailureInput, string]> = [
  ["sender address rejected", { responseCode: 553, command: "MAIL FROM", response: "553 5.1.8 <team@lumen.com>: Sender address rejected: Domain not found" }, "sender"],
  ["sender rejected, no enhanced code", { responseCode: 553, response: "553 sender rejected" }, "sender"],
  ["Gmail daily sending quota", { responseCode: 550, command: "DATA", response: "550 5.4.5 Daily user sending quota exceeded." }, "quota"],
  ["cPanel hourly host limit", { responseCode: 550, command: "RCPT TO", response: '550 "Domain lumen.com has exceeded the max emails per hour (25/25 (100%)) allowed.  Message discarded."' }, "quota"],
  ["relay denied (our auth, not their address)", { responseCode: 554, command: "RCPT TO", response: "554 5.7.1 <x@y.com>: Relay access denied" }, "sender"],
  ["blocklisted sending IP", { responseCode: 554, response: "554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org" }, "policy"],
  ["content rejected as spam", { responseCode: 550, command: "DATA", response: "550 5.7.1 Message rejected as spam by Content Filtering." }, "policy"],
  ["recipient policy rejection behind Postfix's prefix", { responseCode: 554, command: "RCPT TO", response: "554 5.7.1 <x@y.com>: Recipient address rejected: Access denied" }, "policy"],
  ["auth failure carrying a 535", { code: "EAUTH", responseCode: 535, response: "535-5.7.8 Username and Password not accepted." }, "auth"],
  ["authentication required", { responseCode: 530, response: "530 5.7.0 Authentication Required" }, "auth"],
  ["recipient mailbox full (soft)", { responseCode: 552, response: "552 5.2.2 The email account that you tried to reach is over quota." }, "recipient"],
  ["greylisted (soft)", { responseCode: 450, command: "RCPT TO", response: "450 4.7.1 Greylisted, please try again in 5 minutes" }, "recipient"],
  ["RFC catch-all 550 — also used for policy", { responseCode: 550, response: "550 Requested action not taken: mailbox unavailable" }, "unknown"],
  ["connection refused", { code: "ECONNREFUSED", message: "connect ECONNREFUSED 192.168.1.10:587" }, "network"],
  ["timeout", { code: "ETIMEDOUT", message: "Connection timeout" }, "network"],
];

describe("classifySmtpFailure", () => {
  it.each(BOUNCES)("bounce: %s", (_name, err) => {
    expect(classifySmtpFailure(err).status).toBe("bounced");
  });

  it.each(NOT_BOUNCES)("NOT a bounce: %s", (_name, err, failure) => {
    expect(classifySmtpFailure(err)).toMatchObject({ status: "failed", failure });
  });

  it("never reads a status code out of an IP address or a port", () => {
    // An address that LOOKS like "5.1.1" and a port that looks like a 5xx reply code.
    expect(classifySmtpFailure({ message: "connect ECONNREFUSED 5.1.1.200:550" }).status).toBe("failed");
    expect(classifySmtpFailure({ message: "getaddrinfo ENOTFOUND smtp.lumen.com" }).status).toBe("failed");
  });

  it("keeps the server's own words as the reason", () => {
    expect(classifySmtpFailure({ responseCode: 550, response: "550 5.4.5 Daily user sending quota exceeded." }).reason).toContain("quota exceeded");
  });
});

describe("OAuth rails never throw, and never call a sender-side error a bounce", () => {
  const throwing = { async post(): Promise<{ status: number; json: any }> { throw new Error("fetch failed: socket hang up"); } };
  const answering = (status: number, json: unknown) => ({ async post() { return { status, json }; } });

  it("Gmail returns failed on a network error instead of throwing", async () => {
    const r = await new GmailSender({ accessToken: "t", http: throwing }).send(email);
    expect(r).toMatchObject({ status: "failed", failure: "network", messageId: "" });
    expect(r.reason).toContain("socket hang up");
  });

  it("Graph returns failed on a network error instead of throwing", async () => {
    const r = await new MicrosoftGraphSender({ accessToken: "t", http: throwing }).send(email);
    expect(r).toMatchObject({ status: "failed", failure: "network", messageId: "" });
  });

  it("a sender without an HTTP client fails closed rather than throwing", async () => {
    expect((await new GmailSender({ accessToken: "t" }).send(email)).status).toBe("failed");
    expect((await new MicrosoftGraphSender({ accessToken: "t" }).send(email)).status).toBe("failed");
  });

  it("Graph: an expired grant, a throttle and the SENDER's missing mailbox are failures, not bounces", async () => {
    const send = (status: number, json: unknown) => new MicrosoftGraphSender({ accessToken: "t", http: answering(status, json) }).send(email);
    expect(await send(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } })).toMatchObject({ status: "failed", failure: "auth" });
    expect(await send(429, { error: { code: "ApplicationThrottled", message: "Application is over its MailboxConcurrency limit." } })).toMatchObject({ status: "failed", failure: "quota" });
    // "mailbox … not found" here describes the SIGNED-IN SENDER, not the recipient.
    expect((await send(404, { error: { code: "MailboxNotEnabledForRESTAPI", message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise; mailbox not found." } })).status).toBe("failed");
    expect((await send(503, null)).status).toBe("failed");
    // Only an explicitly invalid RECIPIENT is a bounce.
    expect((await send(400, { error: { code: "ErrorInvalidRecipients", message: "At least one recipient isn't valid." } })).status).toBe("bounced");
  });

  it("Gmail: 403/429/5xx are failures; only an invalid To header is a bounce", async () => {
    const send = (status: number, json: unknown) => new GmailSender({ accessToken: "t", http: answering(status, json) }).send(email);
    expect(await send(403, { error: { code: 403, message: "Insufficient Permission" } })).toMatchObject({ status: "failed", failure: "auth" });
    expect(await send(429, { error: { code: 429, message: "User-rate limit exceeded." } })).toMatchObject({ status: "failed", failure: "quota" });
    expect((await send(500, { error: { code: 500, message: "Backend Error" } })).status).toBe("failed");
    expect((await send(400, { error: { code: 400, message: "Invalid To header" } })).status).toBe("bounced");
  });
});

describe("SmtpSender never throws either", () => {
  it("a transport that cannot be built is a failed send", async () => {
    const sender = new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => {
      throw new Error("boom building transport");
    });
    await expect(sender.send(email)).resolves.toMatchObject({ status: "failed" });
  });

  it("a non-Error rejection is a failed send", async () => {
    const transport: SmtpTransport = { async sendMail() { throw "string failure"; }, async verify() { return true; } };
    await expect(new SmtpSender({ host: "h", port: 587, user: "u", pass: "p" }, () => transport).send(email)).resolves.toMatchObject({ status: "failed" });
  });
});
