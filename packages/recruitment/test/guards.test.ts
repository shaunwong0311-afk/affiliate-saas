import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  MockMailboxSender,
  DEFAULT_DISCOVERY_SOURCES,
} from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { isExistingAffiliate, existingAffiliateEmails, queueFirstTouch, type RecruitmentDeps } from "../src/index.js";

let db: Database;
let deps: RecruitmentDeps;

beforeEach(async () => {
  db = createMemoryDatabase();
  deps = {
    db,
    embedder: new HashingEmbedder(),
    llm: new DeterministicLlm(),
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: DEFAULT_DISCOVERY_SOURCES,
    clock: systemClock,
  };
  await db.merchants.insert({
    id: "m1", name: "PeakGear", status: "active", niche: "trail running", competitors: [],
    billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null,
    createdAt: new Date().toISOString(),
  });
});

async function makeAffiliate(email: string) {
  const aff = await db.affiliates.insert({
    id: newId("aff"), name: "Existing Partner", primaryEmail: email, country: null,
    audienceProfile: null, status: "active", createdAt: new Date().toISOString(),
  } as any);
  await db.relationships.insert({
    id: newId("rel"), affiliateId: aff.id, merchantId: "m1", programId: "p1", status: "active",
    joinedAt: new Date().toISOString(), role: "affiliate", commissionTerms: null, source: "inbound",
    ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null,
  } as any);
  return aff;
}

function prospectRow(over: Record<string, unknown> = {}) {
  return {
    id: newId("prosp"), merchantId: "m1", source: "x", identity: "Someone", siteUrl: null, channelUrl: null,
    email: null, state: "scored", score: 60, tier: "B", country: null, language: null,
    suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: null, evidence: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  } as any;
}

describe("isExistingAffiliate", () => {
  it("matches a prospect whose email is already an affiliate of the merchant", async () => {
    await makeAffiliate("partner@known.com");
    expect(await isExistingAffiliate(deps, "m1", { id: "x", email: "Partner@Known.com" })).toBe(true);
    expect(await isExistingAffiliate(deps, "m1", { id: "x", email: "stranger@new.com" })).toBe(false);
  });

  it("collects existing affiliate emails (lowercased) once per run", async () => {
    await makeAffiliate("A@known.com");
    const set = await existingAffiliateEmails(deps, "m1");
    expect(set.has("a@known.com")).toBe(true);
  });
});

describe("queueFirstTouch guard", () => {
  it("refuses to queue outreach to an existing affiliate (marks prospect dead)", async () => {
    await makeAffiliate("partner@known.com");
    const prospect = await db.prospects.insert(prospectRow({ email: "partner@known.com" }));
    const campaign = await db.campaigns.insert(campaignRow());

    const msg = await queueFirstTouch(deps, prospect.id, campaign);
    expect(msg).toBeNull(); // guarded — not queued
    const after = await db.prospects.require(prospect.id);
    expect(after.state).toBe("dead");
  });

  it("still queues a genuine new prospect", async () => {
    const prospect = await db.prospects.insert(prospectRow({ email: "fresh@creator.com" }));
    const campaign = await db.campaigns.insert(campaignRow());
    const msg = await queueFirstTouch(deps, prospect.id, campaign);
    expect(msg).not.toBeNull();
  });
});

function campaignRow() {
  return {
    id: newId("camp"), merchantId: "m1", mailboxId: null, sendingDomainId: null, name: "c",
    sequence: [{ step: 1, delayDays: 0, subject: "Hi {{name}}", body: "Join {{merchant}}", kind: "initial" }],
    sendWindow: { startHour: 9, endHour: 17, timezone: "UTC" }, dailyCap: 50, status: "active",
  } as any;
}
