import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Prospect } from "@affiliate/db";
import { newId, type Clock, type ProspectState } from "@affiliate/core";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  MockMailboxSender,
  SerpDiscoverySource,
  CompetitorAffiliateSource,
  BacklinkDiscoverySource,
  DeterministicBacklinkProvider,
  type DiscoverySource,
} from "@affiliate/integrations";
import { lowYieldSources, sourceYield, autonomousCycle, setAutomationState, SOURCE_MATURITY_DAYS, type RecruitmentDeps } from "../src/index.js";

/**
 * AUDIT-2026-10 D4 — source pruning. A source with ≥20 prospects and <2% producing was
 * excluded — which is true of EVERY source one cycle after it first works (nothing has
 * even been emailed yet), so from cycle 2 the real sources were pruned and sourcing was
 * zero. Pruning now judges only prospects that were actually contacted, long enough ago
 * to have had a chance to produce, and never removes the last runnable source.
 */

const NOW = new Date("2026-10-12T12:00:00.000Z");
const DAY = 86_400_000;
const clock: Clock = { now: () => NOW };
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const stub = (sourceType: string): DiscoverySource => ({ sourceType, async discover() { return []; } });

let db: Database;
let deps: RecruitmentDeps;
beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({
    id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: ["glowrival.com"], billingStatus: "active",
    defaultCurrency: "USD", postbackSecret: "s", physicalAddress: "1 Market St", createdAt: daysAgo(400),
  });
  deps = {
    db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(),
    discoverySources: [stub("serp_mining"), stub("backlink_mining"), stub("youtube_discovery")], clock,
  };
});

/** Insert `n` prospects from one source; optionally contacted `contactedDaysAgo` days ago; optionally producing. */
async function seed(source: string, n: number, opts: { state?: ProspectState; contactedDaysAgo?: number; producing?: number } = {}): Promise<Prospect[]> {
  const out: Prospect[] = [];
  for (let i = 0; i < n; i++) {
    const p: Prospect = {
      id: newId("prosp"), merchantId: "m1", source, identity: `${source}-${i}`, siteUrl: `https://${source}-${i}.com`, channelUrl: null,
      email: `x@${source}-${i}.com`, state: opts.state ?? "scored", score: 60, tier: "B", country: null, language: null, suppressionStatus: "none",
      scoreBreakdown: null, synthetic: false, confidence: null, evidence: null, createdAt: daysAgo(200), updatedAt: daysAgo(opts.contactedDaysAgo ?? 0),
    };
    await db.prospects.insert(p);
    if (opts.contactedDaysAgo != null) {
      await db.outreachMessages.insert({ id: newId("omsg"), prospectId: p.id, campaignId: "camp1", step: 1, variant: null, subject: "s", body: "b", sentAt: daysAgo(opts.contactedDaysAgo), status: "sent" });
    }
    if (i < (opts.producing ?? 0)) {
      await db.prospectOutcomes.insert({ id: newId("pout"), merchantId: "m1", prospectId: p.id, relationshipId: null, sourceType: source, label: "produced_sales", producedRevenueCents: 10_000, ts: daysAgo(1) });
    }
    out.push(p);
  }
  return out;
}

describe("lowYieldSources — maturity window", () => {
  it("does NOT prune a source whose prospects were merely discovered (the cold-start prune)", async () => {
    await seed("serp_mining", 40); // 40 found, none contacted, none producing: yield 0% on volume ≥ 20
    await seed("backlink_mining", 25);
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual([]); // was ["serp_mining", "backlink_mining"]
  });

  it("does NOT prune on prospects contacted too recently to have produced anything", async () => {
    await seed("serp_mining", 40, { state: "contacted", contactedDaysAgo: 3 });
    await seed("backlink_mining", 30, { state: "in_sequence", contactedDaysAgo: SOURCE_MATURITY_DAYS - 1 });
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual([]);
  });

  it("DOES prune a source that had a fair chance and produced nothing", async () => {
    await seed("serp_mining", 25, { state: "contacted", contactedDaysAgo: SOURCE_MATURITY_DAYS + 5 });
    await seed("backlink_mining", 25, { state: "contacted", contactedDaysAgo: SOURCE_MATURITY_DAYS + 5, producing: 2 }); // 8% — healthy
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual(["serp_mining"]);
  });

  it("counts only contacted prospects towards the volume threshold", async () => {
    // 200 discovered but only 10 ever emailed (a month and more ago): not enough evidence to judge.
    await seed("serp_mining", 190);
    await seed("serp_mining", 10, { state: "contacted", contactedDaysAgo: 60 });
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual([]);
    const y = (await sourceYield(deps, "m1")).find((s) => s.sourceType === "serp_mining")!;
    expect(y).toMatchObject({ sourced: 200, contacted: 10, matureContacted: 10, matureProducing: 0 });
  });

  it("an early producer counts at once — good news does not have to mature", async () => {
    // 19 mature non-producers + 1 prospect contacted yesterday that already produced.
    await seed("serp_mining", 19, { state: "contacted", contactedDaysAgo: 45 });
    await seed("serp_mining", 1, { state: "converted", contactedDaysAgo: 1, producing: 1 });
    const y = (await sourceYield(deps, "m1")).find((s) => s.sourceType === "serp_mining")!;
    expect(y).toMatchObject({ matureContacted: 20, matureProducing: 1 }); // 5% ≥ the 2% floor
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual([]);
  });

  it("uses the FIRST send as the start of the clock, and the row's last change when no send is on record", async () => {
    const [p] = await seed("serp_mining", 1, { state: "in_sequence", contactedDaysAgo: 40 });
    await db.outreachMessages.insert({ id: newId("omsg"), prospectId: p!.id, campaignId: "camp1", step: 2, variant: null, subject: "s", body: "b", sentAt: daysAgo(2), status: "sent" }); // a recent follow-up
    await db.prospects.update(p!.id, { updatedAt: daysAgo(2) });
    await seed("backlink_mining", 1, { state: "converted" }); // no message rows; updatedAt = now
    const yields = await sourceYield(deps, "m1");
    expect(yields.find((s) => s.sourceType === "serp_mining")!.matureContacted).toBe(1); // 40 days since first contact
    expect(yields.find((s) => s.sourceType === "backlink_mining")!.matureContacted).toBe(0); // unknown → not yet mature
  });

  it("respects a custom maturity window, volume and floor", async () => {
    await seed("serp_mining", 6, { state: "contacted", contactedDaysAgo: 10 });
    expect([...(await lowYieldSources(deps, "m1", { maturityDays: 7, minVolume: 5 }))]).toEqual(["serp_mining"]);
    expect([...(await lowYieldSources(deps, "m1", { maturityDays: 14, minVolume: 5 }))]).toEqual([]);
  });
});

describe("lowYieldSources — never the last usable source", () => {
  it("keeps the best source when every runnable one is below the floor", async () => {
    await seed("serp_mining", 100, { state: "contacted", contactedDaysAgo: 60, producing: 1 }); // 1%
    await seed("backlink_mining", 100, { state: "contacted", contactedDaysAgo: 60 }); // 0%
    await seed("youtube_discovery", 100, { state: "contacted", contactedDaysAgo: 60 }); // 0%
    const pruned = await lowYieldSources(deps, "m1");
    expect([...pruned].sort()).toEqual(["backlink_mining", "youtube_discovery"]); // serp_mining (the best of a bad lot) survives
  });

  it("keeps the only source a merchant can run", async () => {
    // No competitors → backlink mining is skipped by the planner; SERP is all there is.
    await db.merchants.update("m1", { competitors: [] });
    deps.discoverySources = [stub("serp_mining"), stub("backlink_mining")];
    await seed("serp_mining", 50, { state: "contacted", contactedDaysAgo: 60 });
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual([]);
  });

  it("still prunes a bad source while a good one remains", async () => {
    await seed("serp_mining", 50, { state: "contacted", contactedDaysAgo: 60 });
    await seed("backlink_mining", 50, { state: "contacted", contactedDaysAgo: 60, producing: 5 });
    expect([...(await lowYieldSources(deps, "m1"))]).toEqual(["serp_mining"]);
  });

  it("ignores source types that are not registered (old data, imports)", async () => {
    await seed("import", 50, { state: "contacted", contactedDaysAgo: 60 });
    await seed("serp_mining", 50, { state: "contacted", contactedDaysAgo: 60, producing: 5 });
    const pruned = await lowYieldSources(deps, "m1");
    expect(pruned.has("serp_mining")).toBe(false);
    // "import" may be listed (it is below the floor) but it is not a runnable source, so it
    // can never be the reason the last runnable one is pruned.
    expect([...pruned].filter((s) => s !== "import")).toEqual([]);
  });
});

describe("the autonomous cycle keeps sourcing after its first cycle", () => {
  it("cycle 2 and 3 still call the real sources (they used to be pruned from cycle 2 on)", async () => {
    const calls: Record<string, number> = {};
    const counted = (s: DiscoverySource): DiscoverySource => ({
      sourceType: s.sourceType,
      async discover(q, h) {
        calls[s.sourceType] = (calls[s.sourceType] ?? 0) + 1;
        return s.discover(q, h);
      },
    });
    const live: RecruitmentDeps = {
      ...deps,
      clock: { now: () => new Date() },
      discoverySources: [counted(new SerpDiscoverySource()), counted(new CompetitorAffiliateSource()), counted(new BacklinkDiscoverySource(new DeterministicBacklinkProvider()))],
    };
    await setAutomationState(live, "m1", { status: "running", sourcingLimitPerCycle: 20 });
    const summaries = [];
    // Sourcing now runs on its own interval (daily by default), so three back-to-back cycles are
    // each made a sourcing cycle explicitly — this test is about pruning, not cadence.
    for (let i = 0; i < 3; i++) summaries.push(await autonomousCycle(live, "m1", { forceSourcing: true }));

    expect(summaries[0]!.sourced).toBeGreaterThanOrEqual(20); // enough volume to have tripped the old rule
    expect(summaries.map((s) => s.prunedSources)).toEqual([[], [], []]);
    expect(calls.serp_mining).toBe(3); // was 1
    expect(calls.backlink_mining).toBeGreaterThanOrEqual(3); // was stuck at its cycle-1 count
  });
});
