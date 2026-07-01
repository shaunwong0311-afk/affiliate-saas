import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Mailbox, type Merchant, type Prospect } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES, type InboundReply } from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { ingestReplies, type RecruitmentDeps } from "../src/index.js";

let db: Database;

const merchant: Merchant = {
  id: "m1",
  name: "Lumen Skincare",
  status: "active",
  niche: "skincare",
  competitors: [],
  billingStatus: "active",
  defaultCurrency: "USD",
  postbackSecret: "s",
  physicalAddress: null,
  createdAt: new Date().toISOString(),
};

function mailbox(over: Partial<Mailbox> = {}): Mailbox {
  return { id: "mbx1", merchantId: "m1", provider: "smtp", email: "brand@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "mailbox:mbx1:creds", ...over };
}

function prospect(over: Partial<Prospect> = {}): Prospect {
  return {
    id: newId("prosp"),
    merchantId: "m1",
    source: "backlink_mining",
    identity: "Trail Geek",
    siteUrl: "https://trailgeek.com",
    channelUrl: null,
    email: "creator@site.com",
    state: "contacted",
    score: 60,
    tier: "B",
    country: "US",
    language: "en",
    suppressionStatus: "none",
    scoreBreakdown: null,
    synthetic: false,
    confidence: 0.6,
    evidence: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as Prospect;
}

function makeDeps(replyPoller?: RecruitmentDeps["replyPoller"]): RecruitmentDeps {
  return {
    db,
    embedder: new HashingEmbedder(),
    llm: new DeterministicLlm(),
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: DEFAULT_DISCOVERY_SOURCES,
    replyPoller,
    clock: systemClock,
  };
}

const inbound = (over: Partial<InboundReply> = {}): InboundReply => ({
  toEmail: "brand@lumen.com",
  fromEmail: "creator@site.com",
  subject: "re: partner",
  body: "This sounds great, how does it work?",
  messageId: "imap-msg-1",
  receivedAt: new Date().toISOString(),
  ...over,
});

beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert(merchant);
  await db.mailboxes.insert(mailbox());
});

describe("ingestReplies", () => {
  it("no-ops when no replyPoller is wired", async () => {
    expect(await ingestReplies(makeDeps())).toEqual({ mailboxes: 0, polled: 0, matched: 0 });
  });

  it("polls a mailbox, routes a matched reply, stamps the dedup id, and advances the cursor", async () => {
    const p = await db.prospects.insert(prospect());
    const deps = makeDeps(async () => [inbound()]);
    const res = await ingestReplies(deps);

    expect(res).toMatchObject({ mailboxes: 1, polled: 1, matched: 1 });
    const replies = await db.replies.find((r) => r.prospectId === p.id);
    expect(replies).toHaveLength(1);
    expect(replies[0].inboundMessageId).toBe("imap-msg-1"); // stamped for cross-tick dedup
    const mbx = await db.mailboxes.require("mbx1");
    expect(mbx.lastPolledAt).toBeTruthy(); // cursor advanced
  });

  it("dedups by Message-Id across polls (day-granular IMAP window can't double-route)", async () => {
    const p = await db.prospects.insert(prospect());
    const deps = makeDeps(async () => [inbound()]);
    await ingestReplies(deps);
    const second = await ingestReplies(deps); // same message id returned again

    expect(second.matched).toBe(0); // already ingested → skipped
    expect(await db.replies.count((r) => r.prospectId === p.id)).toBe(1);
  });

  it("skips mailboxes that are disconnected or have no credentials", async () => {
    await db.mailboxes.update("mbx1", { status: "disconnected" });
    const res = await ingestReplies(makeDeps(async () => [inbound()]));
    expect(res.mailboxes).toBe(0);
  });

  it("isolates a single mailbox's transport failure (one bad poll doesn't abort the rest)", async () => {
    await db.mailboxes.insert(mailbox({ id: "mbx2", email: "b2@lumen.com", credentialsRef: "mailbox:mbx2:creds" }));
    await db.prospects.insert(prospect());
    const deps = makeDeps(async (m) => {
      if (m.id === "mbx1") throw new Error("imap auth failed");
      return [inbound()];
    });
    const res = await ingestReplies(deps);
    expect(res.mailboxes).toBe(1); // mbx2 still polled
    expect(res.matched).toBe(1);
  });
});
