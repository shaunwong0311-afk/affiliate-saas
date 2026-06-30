import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock } from "@affiliate/core";
import { activationMetrics, type RecruitmentDeps } from "../src/index.js";

let db: Database;
let deps: RecruitmentDeps;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function rel(id: string, affiliateId: string, joinedAt: string) {
  return { id, affiliateId, merchantId: "m1", programId: "prog1", status: "active" as const, joinedAt, role: "seller" as const, commissionTerms: null, source: "backlink_mining", ownerUserId: null, tags: ["recruited"], sponsorAffiliateId: null, prospectId: `p_${affiliateId}` };
}
function click(affiliateId: string, ts: string) {
  return { clickId: `clk_${affiliateId}_${ts}`, merchantId: "m1", affiliateId, offerId: "off1", ts, ip: null, ua: null, landingUrl: null };
}
function conv(affiliateId: string, ts: string) {
  return { id: `cv_${affiliateId}_${ts}`, merchantId: "m1", clickId: null, orderId: `o_${affiliateId}`, affiliateId, offerId: "off1", codeId: null, amountCents: 5000, currency: "USD" as const, status: "approved" as const, reviewStatus: "none" as const, ts };
}

beforeEach(async () => {
  db = createMemoryDatabase();
  deps = { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: systemClock };
});

describe("activationMetrics", () => {
  it("computes activation/producing rates, fast-start, and time-to-first-sale", async () => {
    // a1 — joined 5d ago, first click 3d ago (2d after joining → fast-start earned), a sale 1d ago.
    await db.relationships.insert(rel("r1", "a1", daysAgo(5)));
    await db.clicks.insert(click("a1", daysAgo(3)));
    await db.conversions.insert(conv("a1", daysAgo(1)));
    // a2 — joined 20d ago, never drove traffic → recruited, fast-start missed.
    await db.relationships.insert(rel("r2", "a2", daysAgo(20)));
    // a3 — joined 2d ago, no click yet → still in the fast-start window.
    await db.relationships.insert(rel("r3", "a3", daysAgo(2)));

    const m = await activationMetrics(deps, "m1");
    expect(m.recruited).toBe(3);
    expect(m.activated).toBe(1); // a1
    expect(m.producing).toBe(1); // a1
    expect(m.fastStartEarned).toBe(1); // a1 clicked within 7d
    expect(m.fastStartInWindow).toBe(1); // a3 still eligible
    expect(m.activationRate).toBeCloseTo(1 / 3);
    expect(m.medianDaysToFirstSale).not.toBeNull();
    const a1 = m.recruits.find((r) => r.affiliateId === "a1")!;
    expect(a1.status).toBe("producing");
    expect(a1.daysToFirstClick).toBeCloseTo(2, 0);
  });

  it("ignores reversed/rejected conversions for producing status", async () => {
    await db.relationships.insert(rel("r1", "a1", daysAgo(10)));
    await db.clicks.insert(click("a1", daysAgo(9)));
    await db.conversions.insert({ ...conv("a1", daysAgo(2)), status: "reversed" });
    const m = await activationMetrics(deps, "m1");
    expect(m.activated).toBe(1); // clicked
    expect(m.producing).toBe(0); // the only sale was reversed
  });
});
