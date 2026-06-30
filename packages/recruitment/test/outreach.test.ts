import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock, newId, type LlmClient } from "@affiliate/core";
import {
  personalizeOutreach,
  convertProspectToAffiliate,
  processInboundReply,
  applyToJoin,
  type RecruitmentDeps,
} from "../src/index.js";
import type { Merchant, Prospect, SequenceStep } from "@affiliate/db";

let db: Database;

function makeDeps(llm: LlmClient = new DeterministicLlm()): RecruitmentDeps {
  return {
    db,
    embedder: new HashingEmbedder(),
    llm,
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: DEFAULT_DISCOVERY_SOURCES,
    clock: systemClock,
  };
}

const merchant: Merchant = {
  id: "m1",
  name: "Lumen Skincare",
  status: "active",
  niche: "skincare serums",
  competitors: ["glowrival.com"],
  billingStatus: "active",
  defaultCurrency: "USD",
  postbackSecret: "s",
  physicalAddress: null,
  createdAt: new Date().toISOString(),
};

const step: SequenceStep = { step: 1, subject: "Partner with {{merchant}}", body: "Hi {{name}}, {{angle}}", delayDays: 0 } as SequenceStep;

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    id: newId("prosp"),
    merchantId: "m1",
    source: "backlink_mining",
    identity: "Trail Geek",
    siteUrl: "https://trailgeek.com",
    channelUrl: null,
    email: "hi@trailgeek.com",
    state: "scored",
    score: 80,
    tier: "A",
    country: "US",
    language: "en",
    suppressionStatus: "none",
    scoreBreakdown: null,
    synthetic: false,
    confidence: 0.6,
    evidence: { competitorPromoted: "glowrival.com", affiliateLinks: [{ network: "ShareASale" }], profile: { accounts: [{ platform: "youtube" }], audience: { reach: 42000 } } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Prospect;
}

beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert(merchant);
});

const jsonLlm = (reply: string): LlmClient => ({ model: "fake-llm", async complete() { return reply; } });

describe("personalizeOutreach", () => {
  const tokens = { name: "Trail Geek", merchant: "Lumen Skincare", offer: "skincare serums", angle: "you'd be a great fit" };

  it("uses the token template under the 'template' plan", async () => {
    const p = prospect();
    const r = await personalizeOutreach(makeDeps(), { merchant: { ...merchant, personalizationPlan: "template" }, prospect: p, step, tokens });
    expect(r.mode).toBe("template");
    expect(r.subject).toBe("Partner with Lumen Skincare");
  });

  it("uses the LLM under the 'llm' plan when a real LLM is wired", async () => {
    const p = prospect({ tier: "C" });
    const llm = jsonLlm('{"subject":"Loved your reviews","body":"Saw your ShareASale links — partner?"}');
    const r = await personalizeOutreach(makeDeps(llm), { merchant: { ...merchant, personalizationPlan: "llm" }, prospect: p, step, tokens });
    expect(r.mode).toBe("llm");
    expect(r.subject).toBe("Loved your reviews");
  });

  it("hybrid plan: LLM only for A-tier, template for B/C", async () => {
    const llm = jsonLlm('{"subject":"x","body":"y"}');
    const a = await personalizeOutreach(makeDeps(llm), { merchant: { ...merchant, personalizationPlan: "hybrid" }, prospect: prospect({ tier: "A" }), step, tokens });
    const c = await personalizeOutreach(makeDeps(llm), { merchant: { ...merchant, personalizationPlan: "hybrid" }, prospect: prospect({ tier: "C" }), step, tokens });
    expect(a.mode).toBe("llm");
    expect(c.mode).toBe("template");
  });

  it("falls back to template when the LLM returns junk (never blocks/invents)", async () => {
    const r = await personalizeOutreach(makeDeps(jsonLlm("not json")), { merchant: { ...merchant, personalizationPlan: "llm" }, prospect: prospect(), step, tokens });
    expect(r.mode).toBe("template");
  });
});

describe("convertProspectToAffiliate", () => {
  beforeEach(async () => {
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
  });

  it("creates a portal-ready affiliate + relationship and marks the prospect converted", async () => {
    const p = await db.prospects.insert(prospect({ state: "replied" }));
    const r = await convertProspectToAffiliate(makeDeps(), p.id);
    expect(r).not.toBeNull();
    expect(r!.created).toEqual({ affiliate: true, relationship: true });
    expect(r!.relationship.prospectId).toBe(p.id);
    expect(r!.affiliate.primaryEmail).toBe("hi@trailgeek.com");
    expect((await db.prospects.require(p.id)).state).toBe("converted");
  });

  it("is idempotent (find-or-create on re-run)", async () => {
    const p = await db.prospects.insert(prospect({ state: "replied" }));
    await convertProspectToAffiliate(makeDeps(), p.id);
    const again = await convertProspectToAffiliate(makeDeps(), p.id);
    expect(again!.created).toEqual({ affiliate: false, relationship: false });
    expect(await db.affiliates.count(() => true)).toBe(1);
  });

  it("returns null when the merchant has no program", async () => {
    await db.programs.delete("prog1");
    const p = await db.prospects.insert(prospect({ state: "replied" }));
    expect(await convertProspectToAffiliate(makeDeps(), p.id)).toBeNull();
  });
});

describe("applyToJoin (inbound)", () => {
  it("auto-approval program → active affiliate immediately", async () => {
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "P", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
    const r = await applyToJoin(makeDeps(), "m1", { email: "new@creator.com", name: "New Creator", socialUrl: "https://instagram.com/new" });
    expect(r).toMatchObject({ status: "active", created: true });
    expect(await db.relationships.count(() => true)).toBe(1);
  });

  it("manual-approval program → pending for review; idempotent by email", async () => {
    await db.programs.insert({ id: "prog2", merchantId: "m1", name: "P", status: "active", termsUrl: null, approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
    const first = await applyToJoin(makeDeps(), "m1", { email: "dup@creator.com", name: "Dup" });
    const again = await applyToJoin(makeDeps(), "m1", { email: "DUP@creator.com", name: "Dup" });
    expect(first!.status).toBe("pending");
    expect(again!.relationshipId).toBe(first!.relationshipId); // no duplicate
    expect(await db.affiliates.count(() => true)).toBe(1);
  });

  it("returns null when the merchant has no program", async () => {
    expect(await applyToJoin(makeDeps(), "m1", { email: "x@y.com", name: "X" })).toBeNull();
  });
});

describe("processInboundReply", () => {
  it("matches an inbound email to a prospect and routes the reply", async () => {
    const p = await db.prospects.insert(prospect({ state: "contacted", tier: "B" }));
    const r = await processInboundReply(makeDeps(), { toEmail: "team@lumen.com", fromEmail: "hi@trailgeek.com", subject: "re", body: "This sounds great, how does it work?", messageId: "m1", receivedAt: new Date().toISOString() });
    expect(r.matched).toBe(true);
    expect(r.prospectId).toBe(p.id);
    expect(["self_serve", "ai_sdr"]).toContain(r.outcome?.action);
  });

  it("returns unmatched when no prospect owns the sender address", async () => {
    const r = await processInboundReply(makeDeps(), { toEmail: "team@lumen.com", fromEmail: "stranger@nowhere.com", subject: "re", body: "hi", messageId: "m2", receivedAt: new Date().toISOString() });
    expect(r.matched).toBe(false);
  });
});
