import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { systemClock } from "@affiliate/core";
import type { DiscoverySource, DiscoveryQuery, RawCandidate, HttpFetcher, FetchResult } from "@affiliate/integrations";
import { expandFrontier, type RecruitmentDeps } from "../src/index.js";

// A backlink source stub: returns two affiliates for whatever competitor is queried.
const affiliate = (host: string, competitor: string): RawCandidate => ({
  identity: host,
  siteUrl: `https://${host}`,
  channelUrl: null,
  sourceType: "backlink_mining",
  evidenceUrl: `https://${host}/review`,
  evidenceSummary: `promotes ${competitor}`,
  outboundLinks: [`https://${competitor}/x?ref=joe`],
  confirmedCompetitor: competitor,
  synthetic: false,
});
const backlinkStub: DiscoverySource = {
  sourceType: "backlink_mining",
  async discover(q: DiscoveryQuery): Promise<RawCandidate[]> {
    const comp = q.competitors[0]!;
    const base = comp.split(".")[0];
    return [affiliate(`${base}-aff1.com`, comp), affiliate(`${base}-aff2.com`, comp)];
  },
};
// Every affiliate page promotes brandb + brandc (and Amazon, which must be filtered).
const fetcher: HttpFetcher = {
  kind: "mock",
  async get(url: string): Promise<FetchResult> {
    return { status: 200, url, html: `<a href="https://brandb.com/buy?ref=x">b</a><a href="https://brandc.com/?via=y">c</a><a href="https://amzn.to/3?tag=z">a</a>` };
  },
};

let db: Database;
beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({
    id: "m1", name: "Acme", status: "active", niche: "trail running", competitors: ["rival.com"],
    billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString(),
  });
});
const deps = (over: Partial<RecruitmentDeps> = {}): RecruitmentDeps =>
  ({ db, discoverySources: [backlinkStub], fetcher, clock: systemClock, ...over }) as unknown as RecruitmentDeps;

describe("expandFrontier — recursive merchant-expansion", () => {
  it("seeds the competitor, mines its affiliates, and promotes co-promoted merchants", async () => {
    const report = await expandFrontier(deps(), "m1", { minCoPromotions: 2, maxDepth: 2 });

    expect(report.mined).toContain("rival.com");
    expect(report.discovered).toBe(2);
    // brandb + brandc each promoted by both affiliates → promoted as new seeds.
    expect(report.promoted.map((p) => p.domain)).toEqual(expect.arrayContaining(["brandb.com", "brandc.com"]));
    // Amazon is a mega-retailer — never promoted.
    expect(report.promoted.map((p) => p.domain)).not.toContain("amzn.to");

    const frontier = await db.frontierMerchants.find((f) => f.merchantId === "m1");
    expect(frontier.find((f) => f.domain === "rival.com")?.status).toBe("mined");
    expect(frontier.filter((f) => f.status === "pending").map((f) => f.domain)).toEqual(expect.arrayContaining(["brandb.com", "brandc.com"]));
    expect(frontier.find((f) => f.domain === "brandb.com")?.depth).toBe(1); // one hop deeper
  });

  it("respects the depth cap (no promotion past maxDepth)", async () => {
    const report = await expandFrontier(deps(), "m1", { minCoPromotions: 2, maxDepth: 0 });
    expect(report.mined).toContain("rival.com"); // still mines the seed
    expect(report.promoted).toEqual([]); // but never goes deeper
  });

  it("does not re-seed or re-mine on a second run (visited set persists)", async () => {
    await expandFrontier(deps(), "m1", { minCoPromotions: 2, maxDepth: 2 });
    const before = await db.frontierMerchants.count((f) => f.merchantId === "m1");
    // Second run: rival is already mined; it pops brandb/brandc next (depth 1).
    await expandFrontier(deps(), "m1", { minCoPromotions: 2, maxDepth: 2 });
    const seeds = (await db.frontierMerchants.find((f) => f.merchantId === "m1" && f.domain === "rival.com")).length;
    expect(seeds).toBe(1); // rival not duplicated
    expect(await db.frontierMerchants.count((f) => f.merchantId === "m1")).toBeGreaterThanOrEqual(before);
  });
});
