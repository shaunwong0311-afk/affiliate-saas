import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import type { DiscoverySource } from "@affiliate/integrations";
import { planDiscovery, type RecruitmentDeps } from "../src/index.js";

const stub = (sourceType: string): DiscoverySource => ({ sourceType, async discover() { return []; } });

let db: Database;
beforeEach(() => {
  db = createMemoryDatabase();
});
async function merchant(competitors: string[]) {
  await db.merchants.insert({
    id: "m1",
    name: "Acme",
    status: "active",
    niche: "trail running",
    competitors,
    billingStatus: "active",
    defaultCurrency: "USD",
    postbackSecret: "s",
    physicalAddress: null,
    createdAt: new Date().toISOString(),
  });
}
const deps = (sources: DiscoverySource[]): RecruitmentDeps => ({ db, discoverySources: sources }) as unknown as RecruitmentDeps;

describe("planDiscovery — the orchestration brain", () => {
  it("runs competitor backlink mining first (warmest) and skips customer mining (hashed emails — no contact path)", async () => {
    await merchant(["rival.com"]);
    const plan = await planDiscovery(deps([stub("serp_mining"), stub("backlink_mining"), stub("customer_mining")]), "m1");
    expect(plan.steps[0]!.sourceType).toBe("backlink_mining"); // warmest first, not array order
    expect(plan.steps.map((s) => s.sourceType)).toContain("serp_mining");
    // #30 behavior flip: customer mining is ALWAYS skipped by the plan (even with orders
    // on file) — Customer stores only emailHash, so its prospects are uncontactable.
    expect(plan.skipped.find((s) => s.sourceType === "customer_mining")?.reason).toMatch(/hashed emails only/i);
    expect(plan.steps[0]!.rationale).toBeTruthy();
  });

  it("skips customer mining even when orders exist (the source stays registered for dev/demo)", async () => {
    await merchant(["rival.com"]);
    await db.orders.insert({
      id: "o1", merchantId: "m1", customerId: "c1", amountCents: 5000, currency: "USD",
      txnId: "t1", ts: new Date().toISOString(), lineItems: [], couponCodes: [],
      isNewCustomer: true, isRebill: false, subtotalCents: 5000, discountCents: 0,
      taxCents: 0, shippingCents: 0, country: null,
    });
    const plan = await planDiscovery(deps([stub("backlink_mining"), stub("customer_mining")]), "m1");
    expect(plan.steps.map((s) => s.sourceType)).not.toContain("customer_mining");
    expect(plan.skipped.find((s) => s.sourceType === "customer_mining")?.reason).toMatch(/no contact path/i);
  });

  it("skips competitor mining when no competitors are set, with a guiding note", async () => {
    await merchant([]);
    const plan = await planDiscovery(deps([stub("serp_mining"), stub("backlink_mining")]), "m1");
    expect(plan.skipped.find((s) => s.sourceType === "backlink_mining")?.reason).toMatch(/no competitors/i);
    expect(plan.notes.join(" ")).toMatch(/competitors/i);
    expect(plan.steps.map((s) => s.sourceType)).toEqual(["serp_mining"]);
  });

  it("honors source-yield pruning (excludeSourceTypes)", async () => {
    await merchant(["rival.com"]);
    const plan = await planDiscovery(deps([stub("serp_mining"), stub("backlink_mining")]), "m1", { excludeSourceTypes: ["serp_mining"] });
    expect(plan.skipped.find((s) => s.sourceType === "serp_mining")?.reason).toMatch(/pruned/i);
    expect(plan.steps.map((s) => s.sourceType)).toEqual(["backlink_mining"]);
  });
});
