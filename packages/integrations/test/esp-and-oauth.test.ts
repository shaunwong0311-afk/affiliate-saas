import { describe, it, expect } from "vitest";
import { ConsoleTransactionalMailer, ResendMailer, PostmarkMailer, exchangeCode, microsoftOAuth, googleOAuth, type PostForm } from "../src/index.js";

/**
 * AUDIT-2026-10 O13 — with no ESP key in production the console mailer answered `sent`
 * (stamping welcome emails as delivered that never left), and the sending address was a
 * hard-coded domain.
 * AUDIT-2026-10 O15 — the OAuth callback could not tell WHICH account had consented.
 */

const email = { to: "recruit@site.com", subject: "You're in", text: "Welcome!" };

describe("ConsoleTransactionalMailer", () => {
  it("records and reports sent outside production", async () => {
    const mailer = new ConsoleTransactionalMailer({ production: false });
    expect((await mailer.send(email)).status).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
  });

  it("does NOT report sent in production — nothing leaves the process", async () => {
    const mailer = new ConsoleTransactionalMailer({ production: true });
    const res = await mailer.send(email);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/no transactional ESP configured/);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("ESP adapters send from the deployment's configured identity", () => {
  function capture(status = 200, json: unknown = { id: "re_1", MessageID: "pm_1" }) {
    const calls: Array<{ url: string; body: any }> = [];
    return { calls, async post(url: string, body: unknown) { calls.push({ url, body }); return { status, json }; } };
  }

  it("Resend: uses the configured from (with the caller's display name), not a baked-in domain", async () => {
    const http = capture();
    const res = await new ResendMailer({ apiKey: "k", http, from: "hello@mail.acme-affiliates.com" }).send({ ...email, fromName: "Lumen Skincare" });
    expect(res).toMatchObject({ status: "sent", id: "re_1" });
    expect(http.calls[0]!.body.from).toBe('"Lumen Skincare" <hello@mail.acme-affiliates.com>');
    expect(JSON.stringify(http.calls[0]!.body)).not.toContain("vantage.dev");
  });

  it("Postmark: the same", async () => {
    const http = capture();
    const res = await new PostmarkMailer({ serverToken: "t", http, from: "hello@mail.acme-affiliates.com" }).send(email);
    expect(res).toMatchObject({ status: "sent", id: "pm_1" });
    expect(http.calls[0]!.body.From).toBe("hello@mail.acme-affiliates.com");
  });

  it("with no sending identity configured, fails with the reason instead of inventing one", async () => {
    const http = capture();
    const res = await new ResendMailer({ apiKey: "k", http }).send(email);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/TRANSACTIONAL_FROM/);
    expect(http.calls).toHaveLength(0);
  });

  it("an ESP error or a network failure is a failed result, never a throw or a sent", async () => {
    expect(await new ResendMailer({ apiKey: "k", http: capture(422, { message: "The lumen.com domain is not verified." }), from: "a@b.co" }).send(email)).toMatchObject({ status: "failed" });
    const down = { async post(): Promise<{ status: number; json: any }> { throw new Error("ECONNRESET"); } };
    expect(await new ResendMailer({ apiKey: "k", http: down, from: "a@b.co" }).send(email)).toMatchObject({ status: "failed" });
    expect(await new PostmarkMailer({ serverToken: "t", http: down, from: "a@b.co" }).send(email)).toMatchObject({ status: "failed" });
    // A 2xx with an empty body must not crash on `json.id`.
    expect(await new ResendMailer({ apiKey: "k", http: capture(200, null), from: "a@b.co" }).send(email)).toMatchObject({ status: "sent" });
  });
});

describe("exchangeCode reports the account that consented", () => {
  const idToken = (claims: Record<string, unknown>) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const http = (json: unknown): PostForm => ({ async post() { return { status: 200, json }; } });
  const ms = microsoftOAuth({ clientId: "c", clientSecret: "s", redirectUri: "https://api/cb" });
  const google = googleOAuth({ clientId: "c", clientSecret: "s", redirectUri: "https://api/cb" });

  it("Google: the email claim", async () => {
    const t = await exchangeCode(google, "code", http({ access_token: "at", expires_in: 3600, id_token: idToken({ sub: "1", email: "Owner@Lumen.com", email_verified: true }) }));
    expect(t.accountEmail).toBe("owner@lumen.com");
    expect(t.accountEmails).toEqual(["owner@lumen.com"]);
  });

  it("Microsoft: the mailbox address and the sign-in name, which can differ", async () => {
    const t = await exchangeCode(ms, "code", http({ access_token: "at", expires_in: 3600, id_token: idToken({ email: "jane@brand.com", preferred_username: "jane@brand.onmicrosoft.com" }) }));
    expect(t.accountEmails).toEqual(["jane@brand.com", "jane@brand.onmicrosoft.com"]);
  });

  it("no id_token (or an unreadable one) → unknown, never a guess", async () => {
    expect((await exchangeCode(ms, "code", http({ access_token: "at", expires_in: 3600 }))).accountEmails).toEqual([]);
    expect((await exchangeCode(ms, "code", http({ access_token: "at", expires_in: 3600, id_token: "not-a-jwt" }))).accountEmail).toBeNull();
  });
});
