import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock } from "@affiliate/core";
import { importProspects, importAffiliateRoster, isExistingAffiliate, type RecruitmentDeps } from "../src/index.js";

let db: Database;
let deps: RecruitmentDeps;

beforeEach(async () => {
  db = createMemoryDatabase();
  deps = { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: systemClock };
  await db.merchants.insert({ id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString() });
  await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
});

describe("importProspects", () => {
  it("creates real (non-synthetic) prospects with a contactable email + import source", async () => {
    const res = await importProspects(deps, "m1", [
      { name: "Trail Geek", email: "hi@trailgeek.com", siteUrl: "https://trailgeek.com" },
      { name: "Peak Pursuits", email: "team@peakpursuits.com" },
    ]);
    expect(res.imported).toBe(2);
    const prospects = await db.prospects.find((p) => p.merchantId === "m1");
    expect(prospects).toHaveLength(2);
    expect(prospects.every((p) => p.synthetic === false && p.source === "import")).toBe(true);
    expect(prospects.find((p) => p.identity === "Trail Geek")?.email).toBe("hi@trailgeek.com"); // contactable
  });

  it("skips rows with no usable identifier", async () => {
    const res = await importProspects(deps, "m1", [{ name: "Nameless" } as any, { name: "", email: "x@y.com" } as any]);
    expect(res.skipped).toBe(2);
    expect(res.imported).toBe(0);
  });

  it("merges a row that matches an existing prospect instead of duplicating", async () => {
    await importProspects(deps, "m1", [{ name: "Trail Geek", siteUrl: "https://trailgeek.com" }]);
    const res = await importProspects(deps, "m1", [{ name: "Trail Geek", siteUrl: "https://trailgeek.com", email: "hi@trailgeek.com" }]);
    expect(res.imported).toBe(0);
    expect(res.merged).toBe(1);
    expect(await db.prospects.count((p) => p.merchantId === "m1")).toBe(1);
    expect((await db.prospects.findOne((p) => p.identity === "Trail Geek"))?.email).toBe("hi@trailgeek.com"); // email backfilled on merge
  });
});

describe("importAffiliateRoster", () => {
  it("creates affiliates + active relationships, and guards them from cold email", async () => {
    const res = await importAffiliateRoster(deps, "m1", [{ name: "Star Creator", email: "star@creator.com", producedRevenueCents: 500_00 }]);
    expect(res.created).toBe(1);
    expect(await db.affiliates.count(() => true)).toBe(1);
    expect(await db.relationships.count((r) => r.merchantId === "m1" && r.status === "active")).toBe(1);

    // The discovery guard now catches this address — an imported affiliate can't be cold-emailed.
    const guarded = await isExistingAffiliate(deps, "m1", { id: "px", email: "star@creator.com" });
    expect(guarded).toBe(true);
  });

  it("warm-starts the learning loop with a produced_sales outcome from historical revenue", async () => {
    await importAffiliateRoster(deps, "m1", [{ name: "Star", email: "star@creator.com", producedRevenueCents: 250_00 }]);
    const outcomes = await db.prospectOutcomes.find((o) => o.merchantId === "m1" && o.label === "produced_sales");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.producedRevenueCents).toBe(250_00);
  });

  it("is idempotent by email (re-import doesn't duplicate relationships or outcomes)", async () => {
    await importAffiliateRoster(deps, "m1", [{ name: "Star", email: "star@creator.com", producedRevenueCents: 250_00 }]);
    const again = await importAffiliateRoster(deps, "m1", [{ name: "Star", email: "STAR@creator.com", producedRevenueCents: 250_00 }]);
    expect(again.existing).toBe(1);
    expect(again.created).toBe(0);
    expect(await db.relationships.count(() => true)).toBe(1);
    expect(await db.prospectOutcomes.count(() => true)).toBe(1);
  });
});
