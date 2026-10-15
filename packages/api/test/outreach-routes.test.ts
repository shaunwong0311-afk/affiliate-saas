import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * AUDIT-2026-10, outreach routes: campaigns (time zone, mailbox ownership), mailboxes (the
 * inbound state the UI must warn on), automation (sourcing cadence), the handoff "send reply"
 * (no double send) and the mailbox OAuth callback (consented account, single-use state).
 * `fetch` is stubbed where a provider would be called; nothing leaves the process.
 */

let app: FastifyInstance;
let a: { token: string; merchantId: string };
let b: { token: string; merchantId: string };

async function call(method: string, url: string, opts: { as?: { token: string; merchantId: string } | null; body?: unknown } = {}) {
  const who = opts.as === undefined ? a : opts.as;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) {
    headers.authorization = `Bearer ${who.token}`;
    headers["x-merchant-id"] = who.merchantId;
  }
  const res = await app.inject({ method: method as any, url, headers, payload: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json: any = {};
  try {
    json = res.body ? JSON.parse(res.body) : {};
  } catch {
    json = { html: res.body };
  }
  return { status: res.statusCode, data: json.data ?? json, location: res.headers.location as string | undefined, raw: res.body };
}

async function signup(email: string, merchantName: string) {
  const res = await call("POST", "/auth/signup", { as: null, body: { email, password: "supersecret", name: email, merchantName } });
  return { token: res.data.token as string, merchantId: res.data.merchant.id as string };
}

const sequence = [{ step: 1, delayDays: 0, kind: "initial", subject: "Partnering with {{merchant}}", body: "Hi {{name}} — I think you would be a strong fit for our partner program. Open to hearing the details?" }];

beforeAll(async () => {
  app = await buildApp({ config: { ...loadConfig(), oauth: { microsoft: { clientId: "cid", clientSecret: "sec" }, google: { clientId: "gid", clientSecret: "gsec" } } } });
  a = await signup("owner-a@outreach.test", "Merchant A");
  b = await signup("owner-b@outreach.test", "Merchant B");
});

afterEach(() => vi.unstubAllGlobals());

describe("O12 — a campaign's send window carries a real time zone", () => {
  it("rejects an unknown zone and accepts an IANA one (and an all-day 0–24 window)", async () => {
    const bad = await call("POST", "/recruitment/campaigns", { body: { name: "bad tz", sequence, sendWindow: { startHour: 9, endHour: 17, timezone: "Pacific Time" } } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", "/recruitment/campaigns", { body: { name: "LA", sequence, sendWindow: { startHour: 9, endHour: 17, timezone: "America/Los_Angeles" } } });
    expect(ok.status).toBe(201);
    expect(ok.data.sendWindow.timezone).toBe("America/Los_Angeles");
    const allDay = await call("POST", "/recruitment/campaigns", { body: { name: "all day", sequence, sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" } } });
    expect(allDay.status).toBe(201);
  });

  it("the window and its zone can be corrected on an existing campaign", async () => {
    const created = await call("POST", "/recruitment/campaigns", { body: { name: "fix me", sequence } });
    expect(created.data.sendWindow.timezone).toBe("UTC");
    const patched = await call("PATCH", `/recruitment/campaigns/${created.data.id}`, { body: { sendWindow: { startHour: 9, endHour: 17, timezone: "Europe/Berlin" } } });
    expect(patched.status).toBe(200);
    expect(patched.data.sendWindow).toEqual({ startHour: 9, endHour: 17, timezone: "Europe/Berlin" });
    const rejected = await call("PATCH", `/recruitment/campaigns/${created.data.id}`, { body: { sendWindow: { startHour: 9, endHour: 17, timezone: "Nowhere/Land" } } });
    expect(rejected.status).toBe(400);
  });
});

describe("a campaign can only send through its own merchant's mailbox", () => {
  it("rejects another tenant's mailbox id on create and on patch", async () => {
    const theirs = await call("POST", "/mailboxes", { as: b, body: { provider: "smtp", email: "team@merchant-b.test" } });
    expect(theirs.status).toBe(201);
    const mine = await call("POST", "/mailboxes", { body: { provider: "smtp", email: "team@merchant-a.test" } });

    const stolen = await call("POST", "/recruitment/campaigns", { body: { name: "x", sequence, mailboxId: theirs.data.id } });
    expect(stolen.status).toBe(400);
    const own = await call("POST", "/recruitment/campaigns", { body: { name: "y", sequence, mailboxId: mine.data.id } });
    expect(own.status).toBe(201);
    const patched = await call("PATCH", `/recruitment/campaigns/${own.data.id}`, { body: { mailboxId: theirs.data.id } });
    expect(patched.status).toBe(400);
    expect((await app.appContext.db.campaigns.require(own.data.id)).mailboxId).toBe(mine.data.id);
  });
});

describe("O5 — the API exposes whether a mailbox can hear replies", () => {
  it("GET /mailboxes carries the inbound state and the follow-up hold", async () => {
    const created = await call("POST", "/mailboxes", { body: { provider: "smtp", email: "inbound@merchant-a.test" } });
    // Connected (credentials on file) but with no way to read replies.
    await app.appContext.db.mailboxes.update(created.data.id, { credentialsRef: "mailbox:x:creds", inboundStatus: "unavailable", inboundError: "no IMAP server is set for this mailbox", oauthNonce: "secret-nonce" });

    const list = await call("GET", "/mailboxes");
    const row = (list.data as any[]).find((m) => m.id === created.data.id);
    expect(row.inbound).toEqual({ working: false, reason: "no IMAP server is set for this mailbox" });
    expect(row.followUpsOnHold).toBe(true);
    expect(row.oauthNonce).toBeUndefined(); // the in-flight OAuth nonce is never returned

    await app.appContext.db.mailboxes.update(created.data.id, { inboundStatus: "ok", inboundError: null });
    const after = ((await call("GET", "/mailboxes")).data as any[]).find((m) => m.id === created.data.id);
    expect(after.inbound).toEqual({ working: true, reason: null });
    expect(after.followUpsOnHold).toBe(false);

    // The deliverability dashboard rows say the same.
    const health = ((await call("GET", "/recruitment/deliverability/mailboxes")).data as any[]).find((m) => m.mailboxId === created.data.id);
    expect(health).toMatchObject({ inboundWorking: true, sendFailures: 0 });
  });

  it("'Test connection' reads the inbox and reports whether replies can be heard", async () => {
    const created = await call("POST", "/mailboxes", { body: { provider: "microsoft", email: "graph-test@merchant-a.test" } });
    const ref = `mailbox:${created.data.id}:creds`;
    await app.appContext.secrets.put(ref, JSON.stringify({ kind: "microsoft", accessToken: "good-token", refreshToken: "rt", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    await app.appContext.db.mailboxes.update(created.data.id, { credentialsRef: ref });
    let graphStatus = 403;
    vi.stubGlobal("fetch", async () => ({ status: graphStatus, ok: graphStatus < 300, async json() { return graphStatus < 300 ? { value: [] } : { error: { code: "ErrorAccessDenied" } }; } }));

    // Mail.Read was not granted → the mailbox cannot hear replies, and says so.
    const refused = await call("POST", `/mailboxes/${created.data.id}/test`, { body: {} });
    expect(refused.data.inbound.working).toBe(false);
    expect(refused.data.inbound.reason).toMatch(/Mail\.Read/);

    graphStatus = 200; // consent fixed
    const ok = await call("POST", `/mailboxes/${created.data.id}/test`, { body: {} });
    expect(ok.data.inbound).toEqual({ working: true, reason: null });
    expect((await app.appContext.db.mailboxes.require(created.data.id)).inboundStatus).toBe("ok");

    // Deleting the mailbox removes its stored credentials too.
    await call("DELETE", `/mailboxes/${created.data.id}`);
    expect(await app.appContext.secrets.get(ref)).toBeNull();
  });

  it("complaint figures are reported as not available rather than zero", async () => {
    const health = (await call("GET", "/recruitment/deliverability")).data;
    expect(health.complaintsAvailable).toBe(false);
    expect(health.complaints).toBeNull();
    expect(health.complaintRate).toBeNull();
  });
});

describe("O14 — the sourcing interval is a setting, and 'Run one cycle' still sources", () => {
  it("stores sourcingIntervalHours and reports when sourcing is next due", async () => {
    const put = await call("PUT", "/recruitment/automation", { body: { sourcingIntervalHours: 6 } });
    expect(put.status).toBe(200);
    expect(put.data.sourcingIntervalHours).toBe(6);
    expect((await call("PUT", "/recruitment/automation", { body: { sourcingIntervalHours: 0 } })).status).toBe(400);
    const state = (await call("GET", "/recruitment/automation")).data;
    expect(state.sourcingIntervalHours).toBe(6);
    expect(state).toHaveProperty("nextSourcingAt");
  });

  it("a manual cycle sources even when the interval has not elapsed", async () => {
    await call("POST", "/recruitment/automation/start", { body: {} });
    const first = (await call("POST", "/recruitment/automation/cycle", { body: {} })).data;
    const second = (await call("POST", "/recruitment/automation/cycle", { body: {} })).data;
    expect(first.sourcingRan).toBe(true);
    expect(second.sourcingRan).toBe(true);
    expect(Date.parse(second.nextSourcingAt)).toBeGreaterThan(Date.now());
  });
});

describe("O3 — 'Approve & send' on a handoff sends once", () => {
  it("a second click finds the handoff resolved and sends nothing", async () => {
    const db = app.appContext.db;
    const now = new Date().toISOString();
    await db.campaigns.insert({ id: "camp-ho", merchantId: a.merchantId, mailboxId: null, sendingDomainId: null, name: "c", sequence: [], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active" });
    await db.prospects.insert({ id: "prosp-ho", merchantId: a.merchantId, source: "x", identity: "Trail Geek", siteUrl: null, channelUrl: null, email: "handoff-creator@site.test", state: "replied", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: now, updatedAt: now });
    await db.outreachMessages.insert({ id: "om-ho", prospectId: "prosp-ho", campaignId: "camp-ho", step: 1, variant: null, subject: "Partnering", body: "b", sentAt: now, status: "sent", providerMessageId: "<first@merchant-a.test>" });
    await db.handoffs.insert({ id: "ho-1", merchantId: a.merchantId, prospectId: "prosp-ho", replyId: null, topic: "commission_question", intent: "question", tier: "B", reason: "approval", summary: "asks about commission", suggestedReply: "We pay 20%.", transcript: "What's the commission?", status: "open", assignedUserId: null, createdAt: now, resolvedAt: null });

    const [first, second] = await Promise.all([
      call("POST", "/recruitment/handoffs/ho-1/send-reply", { body: { reply: "We pay 20% on every sale." } }),
      call("POST", "/recruitment/handoffs/ho-1/send-reply", { body: { reply: "We pay 20% on every sale." } }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expect(await db.outreachMessages.count((m) => m.prospectId === "prosp-ho" && m.variant === "reply")).toBe(1);
    expect((await db.handoffs.require("ho-1")).status).toBe("resolved");
    const third = await call("POST", "/recruitment/handoffs/ho-1/send-reply", { body: { reply: "again" } });
    expect(third.status).toBe(400);
    expect(third.raw).toMatch(/already resolved/);
  });
});

describe("O15 — the mailbox OAuth callback", () => {
  const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  /** Stub the provider's token endpoint; returns how many times it was asked. */
  function stubTokenEndpoint(claims: Record<string, unknown> | null) {
    const counter = { calls: 0 };
    vi.stubGlobal("fetch", async () => {
      counter.calls++;
      const json = { access_token: "at", refresh_token: "rt", expires_in: 3600, ...(claims ? { id_token: idToken(claims) } : {}) };
      return { status: 200, ok: true, async json() { return json; } };
    });
    return counter;
  }

  async function startConnect(provider: "microsoft" | "google", email: string) {
    const mailbox = await call("POST", "/mailboxes", { body: { provider: provider === "microsoft" ? "microsoft" : "gmail", email } });
    const start = await call("POST", `/mailboxes/${mailbox.data.id}/connect/${provider}`, { body: {} });
    expect(start.status).toBe(200);
    const state = new URL(start.data.consentUrl).searchParams.get("state")!;
    return { mailboxId: mailbox.data.id as string, state, callback: `/oauth/${provider}/callback?code=the-code&state=${encodeURIComponent(state)}` };
  }

  it("refuses a grant from a DIFFERENT account than the mailbox being connected", async () => {
    const { mailboxId, callback } = await startConnect("microsoft", "owner@brand-a.test");
    stubTokenEndpoint({ email: "someone-else@other.test", preferred_username: "someone-else@other.test" });

    const res = await call("GET", callback, { as: null });

    expect(res.status).toBe(302);
    expect(res.location).toContain("oauth_error=account_mismatch");
    const mailbox = await app.appContext.db.mailboxes.require(mailboxId);
    expect(mailbox.credentialsRef).toBe(""); // not connected
    expect(await app.appContext.secrets.get(`mailbox:${mailboxId}:creds`)).toBeNull(); // no tokens kept
  });

  it("refuses when the provider does not say which account consented", async () => {
    const { mailboxId, callback } = await startConnect("microsoft", "owner2@brand-a.test");
    stubTokenEndpoint(null);
    const res = await call("GET", callback, { as: null });
    expect(res.location).toContain("oauth_error=account_unverified");
    expect((await app.appContext.db.mailboxes.require(mailboxId)).credentialsRef).toBe("");
  });

  it("connects the matching account, once: replaying the same callback is refused", async () => {
    const { mailboxId, callback } = await startConnect("microsoft", "Owner3@Brand-A.test");
    // The mailbox address is the account's primary address; the sign-in name differs.
    const token = stubTokenEndpoint({ email: "owner3@brand-a.test", preferred_username: "owner3@brand-a.onmicrosoft.com" });

    const first = await call("GET", callback, { as: null });
    expect(first.status).toBe(302);
    expect(first.location).toContain("connected=microsoft");
    const mailbox = await app.appContext.db.mailboxes.require(mailboxId);
    expect(mailbox.credentialsRef).toBeTruthy();
    expect(mailbox.oauthNonce ?? null).toBeNull();
    expect(mailbox.inboundStatus).toBeUndefined(); // Microsoft: readable through Graph, not yet verified
    expect(token.calls).toBe(1);

    const replay = await call("GET", callback, { as: null });
    expect(replay.status).toBe(200);
    expect(replay.raw).toMatch(/already been used/);
    expect(token.calls).toBe(1); // the code was not exchanged again
  });

  it("a newer connect request invalidates the older link", async () => {
    const older = await startConnect("microsoft", "owner4@brand-a.test");
    const newer = await call("POST", `/mailboxes/${older.mailboxId}/connect/microsoft`, { body: {} });
    expect(newer.status).toBe(200);
    const token = stubTokenEndpoint({ email: "owner4@brand-a.test" });
    const res = await call("GET", older.callback, { as: null });
    expect(res.raw).toMatch(/already been used or was replaced/);
    expect(token.calls).toBe(0);
  });

  it("a Gmail mailbox connected with Google sign-in is marked as unable to read replies", async () => {
    const { mailboxId, callback } = await startConnect("google", "owner5@brand-a.test");
    stubTokenEndpoint({ email: "owner5@brand-a.test", email_verified: true });
    const res = await call("GET", callback, { as: null });
    expect(res.location).toContain("connected=google");
    const row = ((await call("GET", "/mailboxes")).data as any[]).find((m) => m.id === mailboxId);
    expect(row.inboundStatus).toBe("unavailable");
    expect(row.followUpsOnHold).toBe(true);
    expect(row.inbound.reason).toMatch(/Gmail/);
  });
});
