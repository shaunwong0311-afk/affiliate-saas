import { createMemoryDatabase, type Database, type Mailbox, type Merchant, type OutreachCampaign, type OutreachMessage, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, type InboundReply, type MailboxSender, type OutboundEmail, type SendResult } from "@affiliate/integrations";
import { newId } from "@affiliate/core";
import type { RecruitmentDeps } from "../../src/index.js";

/**
 * Shared fixtures for the outreach regression tests (AUDIT-2026-10, section O). Everything is
 * offline: an in-memory database, a controllable clock, and fake transports — no test here
 * talks to a mail server or any external service.
 */

/** Thursday 15:00 UTC — a weekday business hour in UTC and for US recipients (09:00 Central). */
export const NOW = new Date("2026-07-02T15:00:00.000Z");

/** A clock the test can move. */
export function movableClock(start: Date = NOW): { now: () => Date; set: (d: Date) => void; advance: (ms: number) => void } {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (d) => (current = new Date(d)),
    advance: (ms) => (current = new Date(current.getTime() + ms)),
  };
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function merchantRow(over: Partial<Merchant> = {}): Merchant {
  return { id: "m1", name: "Lumen Skincare", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Market St, San Francisco, CA", createdAt: NOW.toISOString(), ...over };
}

/** A CONNECTED mailbox: credentials on file, warmed, and replies being read (`inboundStatus: ok`). */
export function mailboxRow(over: Partial<Mailbox> = {}): Mailbox {
  return { id: "mbx1", merchantId: "m1", provider: "smtp", email: "team@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "mailbox:mbx1:creds", inboundStatus: "ok", ...over };
}

const CLEAN_BODY = "Hi {{name}} — I came across your reviews and think you would be a strong fit for the {{merchant}} partner program. Open to hearing the details?";

export function campaignRow(over: Partial<OutreachCampaign> = {}): OutreachCampaign {
  return {
    id: "c1",
    merchantId: "m1",
    mailboxId: "mbx1",
    sendingDomainId: null,
    name: "Q3",
    sequence: [
      { step: 1, delayDays: 0, subject: "Partnering with {{merchant}}", body: CLEAN_BODY, kind: "initial" },
      { step: 2, delayDays: 3, subject: "Following up", body: "Circling back on my note about the {{merchant}} partner program, {{name}} — happy to send the details whenever suits you.", kind: "follow_up" },
    ],
    sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" },
    dailyCap: 50,
    status: "active",
    ...over,
  };
}

export function prospectRow(over: Partial<Prospect> = {}): Prospect {
  const id = over.id ?? newId("prosp");
  return {
    id,
    merchantId: "m1",
    source: "backlink_mining",
    identity: "Trail Geek",
    siteUrl: "https://trailgeek.com",
    channelUrl: null,
    email: `${id}@creator.test`,
    state: "scored",
    score: 60,
    tier: "B",
    country: "US",
    language: "en",
    suppressionStatus: "none",
    scoreBreakdown: null,
    synthetic: false,
    confidence: 0.6,
    evidence: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  } as Prospect;
}

/** A message we already transmitted (the "first touch went out" starting point). */
export function sentMessage(over: Partial<OutreachMessage> & { prospectId: string }): OutreachMessage {
  return { id: newId("omsg"), campaignId: "c1", step: 1, variant: null, subject: "Partnering with Lumen Skincare", body: "Hi — partner with us?", sentAt: NOW.toISOString(), status: "sent", providerMessageId: `<${newId("mid")}@lumen.com>`, ...over };
}

/**
 * A fake transport that records what it was asked to send and answers from a script: a fixed
 * result, a queue of results, or a function. `delayMs` makes every send yield to the event
 * loop the way a real network call does — which is what lets overlapping runs interleave.
 */
export class FakeSender implements MailboxSender {
  readonly provider = "fake";
  readonly sent: OutboundEmail[] = [];
  /** Every attempt, including the ones that did not go out. */
  readonly attempts: OutboundEmail[] = [];
  constructor(
    private readonly script: SendResult | SendResult[] | ((email: OutboundEmail, attempt: number) => SendResult | Promise<SendResult>) = { messageId: "", status: "sent" },
    private readonly delayMs = 0,
  ) {}
  async send(email: OutboundEmail): Promise<SendResult> {
    this.attempts.push(email);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const n = this.attempts.length - 1;
    const result = typeof this.script === "function" ? await this.script(email, n) : Array.isArray(this.script) ? (this.script[Math.min(n, this.script.length - 1)] as SendResult) : this.script;
    if (result.status === "sent") this.sent.push(email);
    // Like a real rail: report the Message-Id that went out (the one the pipeline stamped).
    return result.status === "sent" && !result.messageId ? { ...result, messageId: email.messageId ?? "" } : result;
  }
}

/** A logger that keeps what it was told, so tests can assert failures are reported. */
export function recordingLogger(): { warn: (m: string, meta?: Record<string, unknown>) => void; error: (m: string, meta?: Record<string, unknown>) => void; entries: Array<{ level: "warn" | "error"; message: string; meta?: Record<string, unknown> }> } {
  const entries: Array<{ level: "warn" | "error"; message: string; meta?: Record<string, unknown> }> = [];
  return {
    entries,
    warn: (message, meta) => void entries.push({ level: "warn", message, meta }),
    error: (message, meta) => void entries.push({ level: "error", message, meta }),
  };
}

export function makeDeps(db: Database, over: Partial<RecruitmentDeps> = {}): RecruitmentDeps {
  return {
    db,
    embedder: new HashingEmbedder(),
    llm: new DeterministicLlm(),
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: [],
    clock: { now: () => NOW },
    logger: recordingLogger(),
    ...over,
  };
}

/** A database with one merchant, its connected mailbox and an active two-step campaign. */
export async function seededDb(opts: { merchant?: Partial<Merchant>; mailbox?: Partial<Mailbox>; campaign?: Partial<OutreachCampaign> } = {}): Promise<Database> {
  const db = createMemoryDatabase();
  await db.merchants.insert(merchantRow(opts.merchant));
  await db.mailboxes.insert(mailboxRow(opts.mailbox));
  await db.campaigns.insert(campaignRow(opts.campaign));
  return db;
}

export function inboundMail(over: Partial<InboundReply> = {}): InboundReply {
  return { toEmail: "team@lumen.com", fromEmail: "creator@site.com", subject: "Re: Partnering with Lumen Skincare", body: "This sounds great, sign me up!", messageId: newId("in"), receivedAt: NOW.toISOString(), ...over };
}
