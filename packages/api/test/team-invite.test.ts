import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "@affiliate/db";
import type { SecretStore, TransactionalEmail, TransactionalMailer, TransactionalResult } from "@affiliate/integrations";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signJwt } from "../src/auth/jwt.js";

/**
 * Team-invite takeover. `POST /auth/accept-invite` used to take `{ email, password }`, so
 * anyone who knew an invited team member's address could set the password of their pending
 * account and walk in with the role it had been granted. And an address that already had an
 * account was added as an ACTIVE member on the spot — signup verifies nothing, so whoever
 * registered the address first received the role.
 *
 * Now every invitation is a single-use token mailed to the invited address
 * (`{app}/#/accept-invite?token=…`), and a membership becomes active only when it is redeemed:
 * with a chosen password (new account) or with a session of the invited account (existing one).
 */
class RecordingMailer implements TransactionalMailer {
  readonly provider = "recording";
  readonly sent: TransactionalEmail[] = [];
  next: TransactionalResult["status"] = "sent";
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    this.sent.push(email);
    return { id: `r${this.sent.length}`, status: this.next };
  }
}

type Account = { token: string; merchantId: string; userId: string };

const json = { "content-type": "application/json" };
const INVITEE = "new.admin@corp.test";

let app: FastifyInstance;
let db: Database;
let mailer: RecordingMailer;
let owner: Account;

async function signup(email: string, merchantName: string): Promise<Account> {
  const res = await app.inject({ method: "POST", url: "/auth/signup", headers: json, payload: { email, password: "account-password", name: email, merchantName } });
  const data = JSON.parse(res.body).data;
  return { token: data.token as string, merchantId: data.merchant.id as string, userId: data.user.id as string };
}

async function invite(email: string, role = "admin", as: Account = owner) {
  const res = await app.inject({ method: "POST", url: `/merchants/${as.merchantId}/users`, headers: { ...json, authorization: `Bearer ${as.token}` }, payload: { email, name: "New Admin", role } });
  return { status: res.statusCode, data: res.body ? (JSON.parse(res.body).data ?? JSON.parse(res.body)) : {} };
}

/** POST /auth/accept-invite, optionally signed in as `session`. */
async function accept(payload: Record<string, unknown>, session?: string) {
  const res = await app.inject({ method: "POST", url: "/auth/accept-invite", headers: { ...json, ...(session ? { authorization: `Bearer ${session}` } : {}) }, payload });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

const login = (email: string, password: string) => app.inject({ method: "POST", url: "/auth/login", headers: json, payload: { email, password } });
const invitee = () => db.users.findOne((u) => u.email === INVITEE);
const membershipOf = (email: string, merchantId = owner.merchantId) => db.merchantUsers.findOne((m) => m.merchantId === merchantId && m.email === email);
/** The token inside the `{app}/#/accept-invite?token=…` link of the most recent email. */
const emailedToken = () => /\/#\/accept-invite\?token=([A-Za-z0-9._-]+)/.exec(mailer.sent.at(-1)!.text ?? "")![1]!;
/** Can this session act as a member of `merchantId`? (reads an admin-only setting) */
const canAdminister = async (session: string, merchantId = owner.merchantId) =>
  (await app.inject({ method: "GET", url: `/merchants/${merchantId}/postback-secret`, headers: { authorization: `Bearer ${session}` } })).statusCode === 200;

async function boot(overrides: Parameters<typeof buildApp>[0] = {}) {
  mailer = new RecordingMailer();
  app = await buildApp({ transactionalMailer: mailer, ...overrides });
  db = app.appContext.db;
  owner = await signup("owner@corp.test", "Corp");
}

beforeEach(() => boot());

afterEach(() => {
  vi.useRealTimers();
});

describe("a new invitee: accepting needs the emailed token", () => {
  it("knowing the invitee's email is NOT enough to take over the pending account", async () => {
    expect((await invite(INVITEE)).status).toBe(201);

    // Exactly what the old route accepted.
    const takeover = await accept({ email: INVITEE, password: "attacker-chosen-1" });
    expect(takeover.status).toBe(400);
    expect(takeover.body.data?.token).toBeUndefined();

    // Nothing changed: no password was set, the membership is still pending, and the
    // attacker's password does not sign in.
    expect((await invitee())!.passwordHash).toBe("");
    expect((await membershipOf(INVITEE))!.status).toBe("invited");
    expect((await login(INVITEE, "attacker-chosen-1")).statusCode).toBe(401);
  });

  it("the emailed link sets the password and activates the membership — once", async () => {
    const created = await invite(INVITEE);
    expect(created.data).toMatchObject({ email: INVITEE, role: "admin", status: "invited", inviteSent: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(INVITEE);
    expect(mailer.sent[0]!.text).toContain("http://localhost:5173/#/accept-invite?token=");

    const token = emailedToken();
    const accepted = await accept({ token, password: "invitee-password-1" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.merchants).toEqual([{ merchantId: owner.merchantId, role: "admin" }]);
    expect(accepted.body.data.user).toMatchObject({ email: INVITEE });
    expect(accepted.body.data.user.passwordHash).toBeUndefined();
    expect((await membershipOf(INVITEE))!.status).toBe("active");

    // The session works, and so does a normal sign-in afterwards.
    expect(await canAdminister(accepted.body.data.token as string)).toBe(true);
    expect((await login(INVITEE, "invitee-password-1")).statusCode).toBe(200);

    // The same link cannot be used again — not even to change the password.
    const replay = await accept({ token, password: "someone-elses-password" });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toEqual({ message: "invalid or expired invitation", code: "unauthorized" });
    expect((await login(INVITEE, "someone-elses-password")).statusCode).toBe(401);
    expect((await login(INVITEE, "invitee-password-1")).statusCode).toBe(200);
  });

  it("a genuine token without a password is told what is missing — and is not spent", async () => {
    await invite(INVITEE);
    const token = emailedToken();
    const first = await accept({ token });
    expect(first.status).toBe(400);
    expect(first.body.error.code).toBe("password_required");
    expect((await accept({ token, password: "short" })).status).toBe(400); // password policy, still unspent
    expect((await accept({ token, password: "invitee-password-1" })).status).toBe(200);
  });

  it("records who accepted in the audit log", async () => {
    await invite(INVITEE);
    await accept({ token: emailedToken(), password: "invitee-password-1" });
    const user = await invitee();
    const row = await db.auditLogs.findOne((l) => l.action === "merchant.user_invite_accepted");
    expect(row).toMatchObject({ merchantId: owner.merchantId, actorId: user!.id });
  });

  it("refuses forged, foreign and wrong-kind tokens", async () => {
    await invite(INVITEE);
    const user = (await invitee())!;
    const secret = app.appContext.config.jwtSecret;
    const mid = owner.merchantId;
    const forgeries = [
      "not-a-token",
      signJwt({ sub: user.id, kind: "user_invite", email: INVITEE, jti: "made-up-nonce", mid }, secret, 3600), // right shape, never issued
      signJwt({ sub: user.id, kind: "user_invite", email: INVITEE, mid }, secret, 3600), // no nonce at all
      signJwt({ sub: user.id, kind: "user", email: INVITEE }, secret, 3600), // a session token is not an invite
      signJwt({ sub: user.id, kind: "affiliate_magic", email: INVITEE, jti: "x" }, secret, 3600),
      emailedToken().replace(/.$/, (c) => (c === "A" ? "B" : "A")), // tampered signature
    ];
    for (const token of forgeries) expect((await accept({ token, password: "attacker-chosen-1" })).status, token.slice(0, 24)).toBe(401);
    expect((await invitee())!.passwordHash).toBe("");

    // An invite issued to someone else cannot set THIS account's password.
    await invite("other.person@corp.test", "viewer");
    const other = await accept({ token: emailedToken(), password: "other-password-1" });
    expect(other.status).toBe(200);
    expect(other.body.data.user.email).toBe("other.person@corp.test");
    expect((await invitee())!.passwordHash).toBe("");
  });

  it("an invite token is not a session", async () => {
    await invite(INVITEE);
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${emailedToken()}` } });
    expect(res.statusCode).toBe(401);
  });

  it("expires after 7 days", async () => {
    await invite(INVITEE);
    const token = emailedToken();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 24 * 3600 * 1000);
    expect((await accept({ token, password: "invitee-password-1" })).status).toBe(401);
  });

  it("stops working if the pending account's address is changed after the invite went out", async () => {
    await invite(INVITEE);
    const token = emailedToken();
    await db.users.update((await invitee())!.id, { email: "someone.else@corp.test" });
    expect((await accept({ token, password: "invitee-password-1" })).status).toBe(401);
  });

  it("an admin withdraws an invitation by disabling it — the link then opens nothing", async () => {
    await invite(INVITEE);
    const token = emailedToken();
    const user = (await invitee())!;
    const disabled = await app.inject({ method: "PATCH", url: `/merchants/${owner.merchantId}/users/${user.id}`, headers: { ...json, authorization: `Bearer ${owner.token}` }, payload: { status: "disabled" } });
    expect(disabled.statusCode).toBe(200);
    expect((await accept({ token, password: "invitee-password-1" })).status).toBe(401);
    expect((await invitee())!.passwordHash).toBe("");
  });
});

describe("an address that already has an account", () => {
  it("registering an address first does not capture the role later granted to it", async () => {
    // The attacker registers the CFO's address before the company ever invites it.
    const squatter = await signup("cfo@victim.test", "Squat Co");
    const invited = await invite("cfo@victim.test", "admin");
    expect(invited.status).toBe(201);
    expect(invited.data).toMatchObject({ status: "invited", userId: squatter.userId, inviteSent: true });
    expect(mailer.sent.at(-1)!.to).toBe("cfo@victim.test"); // the invitation goes to the inbox, not to the account holder

    // The squatter's session gets nothing, with or without guessing at the accept route.
    expect(await canAdminister(squatter.token)).toBe(false);
    expect((await accept({ email: "cfo@victim.test", password: "account-password" }, squatter.token)).status).toBe(400);
    expect((await accept({ token: squatter.token }, squatter.token)).status).toBe(401);

    // The real CFO opens the emailed link, but is not (and cannot be) signed in to the
    // squatted account: nothing is activated, and the token is not spent.
    const token = emailedToken();
    const opened = await accept({ token });
    expect(opened.status).toBe(401);
    expect(opened.body.error.code).toBe("sign_in_required");
    expect((await accept({ token, password: "cfo-chosen-password" })).status).toBe(401); // cannot reset the account's password either
    expect((await membershipOf("cfo@victim.test"))!.status).toBe("invited");
    expect(await canAdminister(squatter.token)).toBe(false);
    expect((await login("cfo@victim.test", "cfo-chosen-password")).statusCode).toBe(401);
  });

  it("the account's real owner accepts with the emailed token while signed in", async () => {
    const colleague = await signup("Existing.User@corp.test", "Other Co");
    const invited = await invite("existing.user@CORP.test", "viewer");
    // No second account for the same inbox (the lookup is case-insensitive, like login).
    expect(invited.data).toMatchObject({ status: "invited", userId: colleague.userId });
    expect(await db.users.count((u) => u.email.toLowerCase() === "existing.user@corp.test")).toBe(1);

    const token = emailedToken();
    // Signed in as somebody else: refused, unspent.
    expect((await accept({ token }, owner.token)).status).toBe(401);
    // Signed in as the invited account: accepted, password untouched.
    const accepted = await accept({ token }, colleague.token);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.merchants).toEqual([{ merchantId: owner.merchantId, role: "viewer" }]);
    expect((await membershipOf("existing.user@corp.test"))!.status).toBe("active");
    expect((await login("Existing.User@corp.test", "account-password")).statusCode).toBe(200);
    expect((await accept({ token }, colleague.token)).status).toBe(401); // single-use
  });

  it("an edit cannot activate a membership — only accepting the invitation can", async () => {
    const squatter = await signup("cfo@victim.test", "Squat Co");
    await invite("cfo@victim.test", "admin");
    const patch = (payload: unknown) =>
      app.inject({ method: "PATCH", url: `/merchants/${owner.merchantId}/users/${squatter.userId}`, headers: { ...json, authorization: `Bearer ${owner.token}` }, payload: payload as never });

    expect((await patch({ status: "active" })).statusCode).toBe(409);
    expect((await patch({ status: "disabled" })).statusCode).toBe(200);
    expect((await patch({ status: "active" })).statusCode).toBe(409); // not via disable → reactivate either
    expect(await canAdminister(squatter.token)).toBe(false);
  });

  it("updating someone who is already an accepted member needs no new invitation", async () => {
    const colleague = await signup("existing.user@corp.test", "Other Co");
    await invite("existing.user@corp.test", "viewer");
    await accept({ token: emailedToken() }, colleague.token);
    const mails = mailer.sent.length;

    const updated = await invite("existing.user@corp.test", "manager");
    expect(updated.data).toMatchObject({ status: "active", role: "manager", inviteSent: false });
    expect(updated.data.devInviteToken).toBeUndefined();
    expect(mailer.sent).toHaveLength(mails);
  });
});

describe("creating a team invite", () => {
  it("outside production the response carries the token (no inbox needed); production never returns it", async () => {
    const dev = await invite(INVITEE);
    expect(typeof dev.data.devInviteToken).toBe("string");
    expect((await accept({ token: dev.data.devInviteToken, password: "invitee-password-1" })).status).toBe(200);

    await boot({ config: loadConfig({ NODE_ENV: "production", JWT_SECRET: "0d2f4b6a8c1e3f5a7c9e1b3d5f7a9c0e2b4d6f8a1c3e5b7d", LOG_LEVEL: "silent" }) });
    const prod = await invite(INVITEE);
    expect(prod.status).toBe(201);
    expect(prod.data.devInviteToken).toBeUndefined();
    expect(JSON.stringify(prod.data)).not.toContain(emailedToken());
    expect(prod.data.inviteSent).toBe(true);
    // The link in the email still works there.
    expect((await accept({ token: emailedToken(), password: "invitee-password-1" })).status).toBe(200);
  });

  it("reports honestly when the invitation email could not be handed to the mailer", async () => {
    mailer.next = "failed";
    const created = await invite(INVITEE);
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ status: "invited", inviteSent: false });
  });

  it("re-sending an invite gives a second working link; accepting one retires the other", async () => {
    await invite(INVITEE);
    const first = emailedToken();
    await invite(INVITEE, "manager");
    const second = emailedToken();
    expect(second).not.toBe(first);
    expect((await membershipOf(INVITEE))!.status).toBe("invited"); // still pending after the re-send

    expect((await accept({ token: first, password: "invitee-password-1" })).status).toBe(200);
    expect((await membershipOf(INVITEE))!).toMatchObject({ status: "active", role: "manager" });
    expect((await accept({ token: second, password: "another-password-2" })).status).toBe(401);
    expect((await login(INVITEE, "invitee-password-1")).statusCode).toBe(200);
  });

  it("each merchant's invitation is accepted on its own; another merchant cannot retire it", async () => {
    const second = await signup("owner2@other.test", "Other");
    await invite(INVITEE, "admin");
    const corpToken = emailedToken();
    // The other merchant invites the same address over and over.
    for (let i = 0; i < 4; i++) await invite(INVITEE, "viewer", second);
    const otherToken = emailedToken();

    // Corp's link still works and joins Corp only.
    const joinedCorp = await accept({ token: corpToken, password: "invitee-password-1" });
    expect(joinedCorp.status).toBe(200);
    expect(joinedCorp.body.data.merchants).toEqual([{ merchantId: owner.merchantId, role: "admin" }]);
    expect((await membershipOf(INVITEE, second.merchantId))!.status).toBe("invited");

    // The other invitation now belongs to an existing account: token + that account's session.
    expect((await accept({ token: otherToken })).status).toBe(401);
    const joinedOther = await accept({ token: otherToken }, joinedCorp.body.data.token as string);
    expect(joinedOther.status).toBe(200);
    expect((await membershipOf(INVITEE, second.merchantId))!.status).toBe("active");
  });

  it("cannot be used to mail-bomb an address or as a mail cannon", async () => {
    const { TEAM_INVITE_PER_EMAIL_LIMIT, TEAM_INVITE_PER_MERCHANT_LIMIT } = await import("../src/auth/rate-limit.js");
    const statuses: number[] = [];
    // Plus-tags and Gmail dots reach the same inbox, so they share its allowance.
    const aliases = ["new.admin@gmail.com", "newadmin+1@gmail.com", "n.e.w.admin+x@googlemail.com", "NewAdmin@gmail.com", "new.admin+2@gmail.com", "newadmin+3@gmail.com"];
    expect(aliases).toHaveLength(TEAM_INVITE_PER_EMAIL_LIMIT.max + 1);
    for (const alias of aliases) statuses.push((await invite(alias)).status);
    expect(statuses.slice(0, TEAM_INVITE_PER_EMAIL_LIMIT.max).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(mailer.sent).toHaveLength(TEAM_INVITE_PER_EMAIL_LIMIT.max);

    // Per merchant too, across many different inboxes. (This merchant has already made
    // max+1 attempts above; every attempt counts, including the refused one.)
    const attemptsSoFar = TEAM_INVITE_PER_EMAIL_LIMIT.max + 1;
    const spread: number[] = [];
    for (let i = 0; i < TEAM_INVITE_PER_MERCHANT_LIMIT.max; i++) spread.push((await invite(`target${i}@elsewhere.test`, "viewer")).status);
    expect(spread.filter((s) => s === 201)).toHaveLength(TEAM_INVITE_PER_MERCHANT_LIMIT.max - attemptsSoFar);
    expect(spread.at(-1)).toBe(429);
  });
});

describe("the invite route cannot be used to modify a higher-ranked member", () => {
  it("an admin re-adding the owner's address with a lower role is refused (it used to demote the owner)", async () => {
    // A real admin: invited by the owner, accepted through the emailed link.
    await invite(INVITEE, "admin");
    const admin = await accept({ token: emailedToken(), password: "invitee-password-1" });
    const asAdmin: Account = { token: admin.body.data.token as string, merchantId: owner.merchantId, userId: "" };

    const demote = await invite("owner@corp.test", "viewer", asAdmin);
    expect(demote.status).toBe(403);
    const ownerMembership = await db.merchantUsers.findOne((m) => m.merchantId === owner.merchantId && m.userId === owner.userId);
    expect(ownerMembership).toMatchObject({ role: "owner", status: "active" });

    // The same admin can still add and update members at or below their own rank.
    expect((await invite("teammate@corp.test", "manager", asAdmin)).status).toBe(201);
    expect((await invite("teammate@corp.test", "viewer", asAdmin)).status).toBe(201);
  });
});

describe("single-use holds when two acceptances overlap", () => {
  class SlowSecretStore implements SecretStore {
    private readonly rows = new Map<string, string>();
    private readonly gap = () => new Promise<void>((resolve) => setImmediate(resolve));
    async put(ref: string, value: string): Promise<void> {
      await this.gap();
      this.rows.set(ref, value);
    }
    async get(ref: string): Promise<string | null> {
      await this.gap();
      return this.rows.get(ref) ?? null;
    }
    async delete(ref: string): Promise<void> {
      await this.gap();
      this.rows.delete(ref);
    }
  }

  it("one token, five simultaneous acceptances with different passwords: exactly one wins", async () => {
    await boot({ secrets: new SlowSecretStore() });
    await invite(INVITEE);
    const token = emailedToken();
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => accept({ token, password: `password-number-${n}` })));
    const winners = results.map((r, i) => (r.status === 200 ? i + 1 : 0)).filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
    // …and the password that sticks is the winner's.
    for (const n of [1, 2, 3, 4, 5]) {
      expect((await login(INVITEE, `password-number-${n}`)).statusCode, `password ${n}`).toBe(n === winners[0] ? 200 : 401);
    }
  });
});
