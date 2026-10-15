import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryDatabase, type Database, type Mailbox } from "@affiliate/db";
import type { MailboxCredentials, TransactionalEmail, TransactionalMailer, TransactionalResult } from "@affiliate/integrations";
import { ingestReplies, queueFirstTouch, send } from "@affiliate/recruitment";
import { createContext, type AppContext } from "../src/context.js";
import { loadConfig } from "../src/config.js";
import { sendActivationEmail } from "../src/services/activation-email.js";

/**
 * AUDIT-2026-10, outreach wiring in the API's dependency container. Everything network-shaped
 * is stubbed: `fetch` is replaced for the duration of each test and no SMTP/IMAP is touched.
 */

const NOW = new Date("2026-07-02T15:00:00.000Z");
const productionConfig = { ...loadConfig(), isProduction: true, jwtSecret: "a-long-random-production-secret-value" };
const oauthConfig = { ...loadConfig(), oauth: { microsoft: { clientId: "cid", clientSecret: "sec" }, google: { clientId: "gid", clientSecret: "gsec" } } };

let db: Database;

async function seedMerchant(): Promise<void> {
  await db.merchants.insert({ id: "m1", name: "Lumen Skincare", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Market St, San Francisco, CA", createdAt: NOW.toISOString() });
}

function mailboxRow(over: Partial<Mailbox> = {}): Mailbox {
  return { id: "mbx1", merchantId: "m1", provider: "microsoft", email: "team@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "mailbox:mbx1:creds", ...over };
}

async function seedSendable(ctx: AppContext, mailboxId: string | null): Promise<string> {
  await ctx.db.campaigns.insert({ id: "c1", merchantId: "m1", mailboxId, sendingDomainId: null, name: "c", sequence: [{ step: 1, delayDays: 0, kind: "initial", subject: "Partnering with {{merchant}}", body: "Hi {{name}} — I came across your reviews and think you would be a strong fit for our partner program. Open to hearing the details?" }], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active" });
  await ctx.db.prospects.insert({ id: "p1", merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: null, channelUrl: null, email: "creator@site.com", state: "scored", score: 80, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  const message = await queueFirstTouch(ctx, "p1", await ctx.db.campaigns.require("c1"));
  return message!.id;
}

/** Replace global fetch with a scripted handler; returns the recorded calls. */
function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const res = await handler(url, init);
    return { status: res.status ?? 200, ok: (res.status ?? 200) < 300, async json() { return res.json; }, async text() { return JSON.stringify(res.json); } };
  });
  return calls;
}

beforeEach(async () => {
  db = createMemoryDatabase();
  await seedMerchant();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("O4 — in production nothing falls back to the mock sender", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {})); // boot warnings

  it("the default mailer is a sender that fails, not one that says `sent`", async () => {
    const ctx = createContext({ db, config: productionConfig });
    const res = await ctx.mailer.send({ fromName: "Lumen", fromEmail: "team@lumen.com", toEmail: "creator@site.com", subject: "Hi", body: "Hello there." });
    expect(res.status).toBe("failed");
    expect(res.reason).toBeTruthy();
    // Outside production it is still the mock, so dev and the demo run without a mailbox.
    expect((await createContext({ db }).mailer.send({ fromName: "L", fromEmail: "a@b.co", toEmail: "c@d.co", subject: "s", body: "b" })).status).toBe("sent");
  });

  it.each([
    ["a campaign with no mailbox", null as string | null, async () => {}],
    ["a mailbox whose credentials are gone from the secret store", "mbx1", async () => void (await db.mailboxes.insert(mailboxRow()))],
    ["a mailbox with incomplete SMTP credentials", "mbx1", async (ctx: AppContext) => {
      await db.mailboxes.insert(mailboxRow({ provider: "smtp" }));
      await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify({ kind: "smtp", host: "smtp.lumen.com" } satisfies MailboxCredentials));
    }],
  ])("%s: the send fails with a reason and is never recorded as sent", async (_name, mailboxId, arrange) => {
    const ctx = createContext({ db, config: productionConfig, clock: { now: () => NOW } });
    await arrange(ctx);
    const messageId = await seedSendable(ctx, mailboxId);

    const out = await send(ctx, messageId);

    expect(out.status).toBe("failed");
    expect(out.sentAt).toBeNull();
    expect(out.blockedReason).toMatch(/send failed/);
    expect(await db.usageEvents.count((u) => u.kind === "send")).toBe(0);
    expect((await db.prospects.require("p1")).state).toBe("scored");
  });
});

describe("O13 — the activation email", () => {
  class RecordingMailer implements TransactionalMailer {
    readonly provider = "recording";
    readonly sent: TransactionalEmail[] = [];
    constructor(private readonly delayMs = 0) {}
    async send(email: TransactionalEmail): Promise<TransactionalResult> {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      this.sent.push(email);
      return { id: "r1", status: "sent" };
    }
  }

  async function seedRelationship(): Promise<void> {
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
    await db.affiliates.insert({ id: "aff1", name: "Trail Geek", primaryEmail: "recruit@site.com", country: "US", audienceProfile: null, status: "active", createdAt: NOW.toISOString() });
    await db.relationships.insert({ id: "rel1", affiliateId: "aff1", merchantId: "m1", programId: "prog1", status: "active", joinedAt: NOW.toISOString(), role: "seller", commissionTerms: null, source: "inbound_apply", ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null });
  }

  it("in production with no ESP configured it is NOT reported sent and nothing is stamped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
    await seedRelationship();
    const ctx = createContext({ db, config: productionConfig });

    const res = await sendActivationEmail(ctx, "rel1");

    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/no transactional ESP configured/);
    expect((await db.relationships.require("rel1")).activationEmailSentAt ?? null).toBeNull();
    expect(await db.auditLogs.count((a) => a.action === "affiliate.activation_email_sent")).toBe(0);
    vi.unstubAllEnvs();
  });

  it("is sent from the deployment's own identity under the merchant's name — no hard-coded domain", async () => {
    await seedRelationship();
    const mailer = new RecordingMailer();
    await sendActivationEmail(createContext({ db, transactionalMailer: mailer }), "rel1");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.from).toBeUndefined(); // the mailer's configured TRANSACTIONAL_FROM applies
    expect(mailer.sent[0]!.fromName).toBe("Lumen Skincare");
    expect(JSON.stringify(mailer.sent[0])).not.toContain("vantage.dev");
  });

  it("is not sent to a suppressed address (anyone can type an address into the public join form)", async () => {
    await seedRelationship();
    const mailer = new RecordingMailer();
    const ctx = createContext({ db, transactionalMailer: mailer });
    // A platform-wide row, as the signed unsubscribe link writes it.
    await db.suppressions.insert({ id: "supp_unsub", merchantId: null, email: "recruit@site.com", domain: null, reason: "unsubscribe", scope: "global", origin: "system", ts: new Date().toISOString() });

    const res = await sendActivationEmail(ctx, "rel1");

    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/suppressed/);
    expect(mailer.sent).toHaveLength(0);
    expect((await db.relationships.require("rel1")).activationEmailSentAt ?? null).toBeNull();
  });

  it("two overlapping calls send one email", async () => {
    await seedRelationship();
    const mailer = new RecordingMailer(5);
    const ctx = createContext({ db, transactionalMailer: mailer });
    const results = await Promise.all([sendActivationEmail(ctx, "rel1"), sendActivationEmail(ctx, "rel1")]);
    expect(mailer.sent).toHaveLength(1);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
  });
});

describe("O15 — OAuth access-token refresh is serialized and its failure is reported", () => {
  const expired: MailboxCredentials = { kind: "microsoft", accessToken: "stale-token", refreshToken: "rt-1", expiresAt: new Date(Date.now() - 60_000).toISOString() };
  const email = { fromName: "Lumen", fromEmail: "team@lumen.com", toEmail: "creator@site.com", subject: "Hi", body: "Hello there." };

  async function connectedMicrosoftMailbox(ctx: AppContext, creds: MailboxCredentials = expired): Promise<void> {
    await db.mailboxes.insert(mailboxRow());
    await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify(creds));
  }

  it("two sends racing on an expired token refresh it ONCE, and both use the new token", async () => {
    const calls = stubFetch(async (url) => {
      if (url.includes("login.microsoftonline.com")) {
        await new Promise((r) => setTimeout(r, 5)); // a real token endpoint takes a moment
        return { json: { access_token: "fresh-token", refresh_token: "rt-2", expires_in: 3600 } };
      }
      return { status: 202, json: {} };
    });
    const ctx = createContext({ db, config: oauthConfig });
    await connectedMicrosoftMailbox(ctx);

    const [a, b] = await Promise.all([ctx.mailboxResolver("mbx1"), ctx.mailboxResolver("mbx1")]);
    expect((await a.send(email)).status).toBe("sent");
    expect((await b.send(email)).status).toBe("sent");

    expect(calls.filter((c) => c.url.includes("login.microsoftonline.com"))).toHaveLength(1); // the refresh token was used once
    const graph = calls.filter((c) => c.url.includes("graph.microsoft.com"));
    expect(graph).toHaveLength(2);
    for (const c of graph) expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
    // The rotated refresh token is what is stored now.
    expect(JSON.parse((await ctx.secrets.get("mailbox:mbx1:creds"))!)).toMatchObject({ accessToken: "fresh-token", refreshToken: "rt-2" });
  });

  it("a refresh that fails fails the send with that reason — it does not send with the stale token", async () => {
    const calls = stubFetch((url) => (url.includes("login.microsoftonline.com") ? { status: 400, json: { error: "invalid_grant", error_description: "The refresh token has expired." } } : { status: 202, json: {} }));
    const ctx = createContext({ db, config: oauthConfig });
    await connectedMicrosoftMailbox(ctx);

    const res = await (await ctx.mailboxResolver("mbx1")).send(email);

    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/could not be refreshed/);
    expect(res.reason).toMatch(/reconnect/);
    expect(calls.some((c) => c.url.includes("graph.microsoft.com"))).toBe(false); // nothing was attempted with the dead token
  });

  it("a token that is still valid is used as is", async () => {
    const calls = stubFetch(() => ({ status: 202, json: {} }));
    const ctx = createContext({ db, config: oauthConfig });
    await connectedMicrosoftMailbox(ctx, { ...expired, accessToken: "good-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await (await ctx.mailboxResolver("mbx1")).send(email)).status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("graph.microsoft.com");
  });
});

describe("O5 — the reply poller says when a mailbox cannot be read, and reads Microsoft through Graph", () => {
  const valid = { accessToken: "good-token", refreshToken: "rt", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

  it("Gmail connected with Google sign-in → unavailable (not an empty list that looks like 'no replies')", async () => {
    const ctx = createContext({ db, config: oauthConfig });
    await db.mailboxes.insert(mailboxRow({ provider: "gmail" }));
    await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify({ kind: "gmail_oauth", ...valid }));
    const out = await ctx.replyPoller(await db.mailboxes.require("mbx1"));
    expect(out).toEqual({ unavailable: expect.stringMatching(/Gmail/) });
  });

  it("SMTP without an IMAP server → unavailable", async () => {
    const ctx = createContext({ db });
    await db.mailboxes.insert(mailboxRow({ provider: "smtp" }));
    await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify({ kind: "smtp", host: "smtp.lumen.com", port: 587, user: "team@lumen.com", pass: "x" }));
    expect(await ctx.replyPoller(await db.mailboxes.require("mbx1"))).toEqual({ unavailable: expect.stringMatching(/IMAP/) });
  });

  it("credentials that cannot be loaded → the read throws (the path exists but is broken)", async () => {
    const ctx = createContext({ db });
    await db.mailboxes.insert(mailboxRow());
    await expect(ctx.replyPoller(await db.mailboxes.require("mbx1"))).rejects.toThrow(/credentials/);
  });

  it("Microsoft → reads the Inbox through Graph from the stored cursor and returns the next one", async () => {
    const calls = stubFetch(() => ({
      json: {
        value: [
          {
            internetMessageId: "<reply-1@site.com>",
            subject: "Re: Partnering with Lumen Skincare",
            from: { emailAddress: { address: "creator@site.com" } },
            toRecipients: [{ emailAddress: { address: "team@lumen.com" } }],
            receivedDateTime: "2026-07-02T14:05:00Z",
            uniqueBody: { content: "STOP" },
            body: { content: "STOP" },
            internetMessageHeaders: [{ name: "In-Reply-To", value: "<first@lumen.com>" }],
          },
        ],
      },
    }));
    const ctx = createContext({ db, config: oauthConfig });
    await db.mailboxes.insert(mailboxRow({ inboundCursor: "graph:2026-07-02T14:00:00.000Z" }));
    await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify({ kind: "microsoft", ...valid }));

    const out = await ctx.replyPoller(await db.mailboxes.require("mbx1"));

    expect(out).toMatchObject({ cursor: "graph:2026-07-02T14:05:00.000Z", replies: [{ fromEmail: "creator@site.com", body: "STOP", messageId: "reply-1@site.com", inReplyTo: "<first@lumen.com>" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
    expect(decodeURIComponent(calls[0]!.url)).toContain("receivedDateTime ge 2026-07-02T14:00:00.000Z");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer good-token");
    expect(calls[0]!.init.method ?? "GET").toBe("GET"); // read-only
  });

  it("end to end: a STOP read through Graph suppresses the prospect and marks the mailbox readable", async () => {
    stubFetch(() => ({
      json: { value: [{ internetMessageId: "<reply-1@site.com>", subject: "Re: hi", from: { emailAddress: { address: "creator@site.com" } }, receivedDateTime: "2026-07-02T14:05:00Z", uniqueBody: { content: "STOP" }, internetMessageHeaders: [{ name: "In-Reply-To", value: "<first@lumen.com>" }] }] },
    }));
    const ctx = createContext({ db, config: oauthConfig, clock: { now: () => NOW } });
    await db.mailboxes.insert(mailboxRow({ inboundCursor: "graph:2026-07-02T14:00:00.000Z" }));
    await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify({ kind: "microsoft", ...valid }));
    await db.campaigns.insert({ id: "c1", merchantId: "m1", mailboxId: "mbx1", sendingDomainId: null, name: "c", sequence: [], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active" });
    await db.prospects.insert({ id: "p1", merchantId: "m1", source: "x", identity: "Trail Geek", siteUrl: null, channelUrl: null, email: "creator@site.com", state: "contacted", score: 80, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    await db.outreachMessages.insert({ id: "om1", prospectId: "p1", campaignId: "c1", step: 1, variant: null, subject: "hi", body: "b", sentAt: NOW.toISOString(), status: "sent", providerMessageId: "<first@lumen.com>" });

    const res = await ingestReplies(ctx, { merchantId: "m1" });

    expect(res).toMatchObject({ mailboxes: 1, polled: 1, matched: 1 });
    expect((await db.prospects.require("p1")).state).toBe("suppressed");
    const mailbox = await db.mailboxes.require("mbx1");
    expect(mailbox.inboundStatus).toBe("ok");
    expect(mailbox.inboundCursor).toBe("graph:2026-07-02T14:05:00.000Z");
  });

  it("a Graph read that is refused marks the mailbox's inbound path broken", async () => {
    stubFetch(() => ({ status: 403, json: { error: { code: "ErrorAccessDenied" } } }));
    const logger = { warn: vi.fn(), error: vi.fn() };
    const ctx = { ...createContext({ db, config: oauthConfig }), logger };
    await db.mailboxes.insert(mailboxRow());
    await ctx.secrets.put("mailbox:mbx1:creds", JSON.stringify({ kind: "microsoft", ...valid }));

    await ingestReplies(ctx, { merchantId: "m1" });

    const mailbox = await db.mailboxes.require("mbx1");
    expect(mailbox.inboundStatus).toBe("error");
    expect(mailbox.inboundError).toMatch(/Mail\.Read/);
    expect(logger.warn).toHaveBeenCalled();
  });
});
