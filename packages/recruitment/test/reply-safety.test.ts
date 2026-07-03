import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Merchant, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES, extractReplyText, type InboundReply } from "@affiliate/integrations";
import { newId } from "@affiliate/core";
import { handleReply, processInboundReply, type RecruitmentDeps } from "../src/index.js";

let db: Database;
const NOW = new Date("2026-07-02T12:00:00.000Z");
const clock = { now: () => NOW };

const merchant = (id: string, name: string): Merchant => ({ id, name, status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: NOW.toISOString() });

function makeDeps(): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock };
}

function prospect(over: Partial<Prospect> = {}): Prospect {
  return { id: newId("prosp"), merchantId: "m1", source: "backlink_mining", identity: "Trail Geek", siteUrl: "https://tg.com", channelUrl: null, email: "creator@site.com", state: "contacted", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over } as Prospect;
}

const inbound = (over: Partial<InboundReply> = {}): InboundReply => ({ toEmail: "team@lumen.com", fromEmail: "creator@site.com", subject: "re", body: "This sounds great, sign me up!", messageId: "mid-1", receivedAt: NOW.toISOString(), ...over });

beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert(merchant("m1", "Lumen"));
});

describe("extractReplyText (quoted-reply safety)", () => {
  it("recovers a bottom-posted reply below >-quoted history (incl. our own footer)", () => {
    const raw = ["> Hi Trail Geek — partner with us?", "> —", "> Lumen", "> Unsubscribe: reply STOP, or https://x/u", "", "I'm interested! How do I start?"].join("\n");
    expect(extractReplyText(raw)).toBe("I'm interested! How do I start?");
  });

  it("returns EMPTY (never the raw email) when there is no new text", () => {
    const raw = ["On Mon, Lumen wrote:", "> our whole email", "> Unsubscribe: reply STOP, or https://x/u"].join("\n");
    expect(extractReplyText(raw)).toBe("");
  });

  it("stops at our unprefixed footer so the STOP line never reads as the sender's words", () => {
    const raw = ["Sounds good!", "—", "Lumen", "Unsubscribe: reply STOP, or https://x/u"].join("\n");
    expect(extractReplyText(raw)).toBe("Sounds good!");
  });
});

describe("routeReply safety", () => {
  it("a bottom-posted interested reply is NOT suppressed (the old global-suppression bug)", async () => {
    const p = await db.prospects.insert(prospect());
    const body = extractReplyText(["> our email", "> Unsubscribe: reply STOP, or https://x/u", "", "I'm interested, sounds good!"].join("\n"));
    const out = await handleReply(makeDeps(), p.id, body);
    expect(out.action).not.toBe("suppress");
    expect((await db.prospects.require(p.id)).suppressionStatus).toBe("none");
  });

  it("an empty extraction routes to human review, never classified off boilerplate", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "");
    expect(out.action).toBe("review");
    expect((await db.prospects.require(p.id)).suppressionStatus).toBe("none");
  });

  it("a bare STOP reply is honored as an unsubscribe (the advertised opt-out)", async () => {
    const p = await db.prospects.insert(prospect());
    const out = await handleReply(makeDeps(), p.id, "STOP");
    expect(out.action).toBe("suppress");
    expect(await db.suppressions.count(() => true)).toBe(1);
  });

  it("out-of-office actually snoozes the prospect", async () => {
    const p = await db.prospects.insert(prospect());
    await handleReply(makeDeps(), p.id, "I'm out of office until further notice, back next week.");
    const snoozed = (await db.prospects.require(p.id)).snoozedUntil;
    expect(snoozed).toBeTruthy();
    expect(new Date(snoozed!).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("A-tier meeting booking link", () => {
  it("uses the merchant's OWN scheduling link verbatim — never a fabricated stub URL", async () => {
    await db.merchants.update("m1", { bookingUrl: "https://cal.com/lumen/intro" });
    const p = await db.prospects.insert(prospect({ tier: "A" }));
    const out = await handleReply(makeDeps(), p.id, "This sounds great, let's talk!", { meetingTier: "A" });
    expect(out.action).toBe("meeting_booked");
    expect(out.meeting?.bookingUrl).toBe("https://cal.com/lumen/intro");
  });

  it("leaves the booking link null (honest) when no real calendar is wired — no cal.vantage.dev", async () => {
    const p = await db.prospects.insert(prospect({ tier: "A" }));
    const out = await handleReply(makeDeps(), p.id, "Very interested — let's chat!", { meetingTier: "A" });
    expect(out.action).toBe("meeting_booked");
    expect(out.meeting?.bookingUrl ?? null).toBeNull(); // never a fabricated URL
  });
});

describe("processInboundReply guards", () => {
  it("scopes prospect matching to the mailbox's merchant (no cross-tenant routing)", async () => {
    await db.merchants.insert(merchant("m2", "Rival"));
    // Same creator is a prospect of BOTH merchants; m2's row is more recently updated.
    const p1 = await db.prospects.insert(prospect({ merchantId: "m1", updatedAt: "2026-07-01T00:00:00.000Z" }));
    await db.prospects.insert(prospect({ id: newId("prosp"), merchantId: "m2", updatedAt: "2026-07-02T00:00:00.000Z" }));

    const res = await processInboundReply(makeDeps(), inbound(), { merchantId: "m1" });
    expect(res.matched).toBe(true);
    expect(res.prospectId).toBe(p1.id); // m1's prospect, despite m2's being fresher
  });

  it("ignores mail from a prospect we never contacted (inbox noise, e.g. their newsletter)", async () => {
    await db.prospects.insert(prospect({ state: "scored" }));
    const res = await processInboundReply(makeDeps(), inbound({ body: "New post + unsubscribe link at the bottom" }));
    expect(res.matched).toBe(false);
    expect(res.ignoredReason).toContain("never contacted");
    expect(await db.replies.count(() => true)).toBe(0);
  });

  it("routes an uncontacted sender's mail when it references OUR sent message id", async () => {
    const p = await db.prospects.insert(prospect({ state: "scored" }));
    await db.campaigns.insert({ id: "c1", merchantId: "m1", mailboxId: null, sendingDomainId: null, name: "c", sequence: [], sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" }, dailyCap: 50, status: "active" });
    await db.outreachMessages.insert({ id: newId("om"), prospectId: p.id, campaignId: "c1", step: 1, variant: null, subject: "s", body: "b", sentAt: NOW.toISOString(), status: "sent", providerMessageId: "<orig-123@lumen>" });

    const res = await processInboundReply(makeDeps(), inbound({ inReplyTo: "<orig-123@lumen>" }));
    expect(res.matched).toBe(true);
  });

  it("dedups by Message-Id on EVERY path (webhook retries can't double-route)", async () => {
    await db.prospects.insert(prospect());
    const first = await processInboundReply(makeDeps(), inbound());
    const retry = await processInboundReply(makeDeps(), inbound());
    expect(first.matched).toBe(true);
    expect(retry.matched).toBe(false);
    expect(retry.ignoredReason).toContain("duplicate");
    expect(await db.replies.count(() => true)).toBe(1);
  });
});
