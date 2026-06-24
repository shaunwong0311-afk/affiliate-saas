import type { RecruitmentDeps } from "./deps.js";

/**
 * Discovery planner (Section 8.1). We now have a TOOLBOX of discovery methods, each
 * with a different cost, warmth, and applicability. Rather than blindly run them all
 * in a fixed order, the planner inspects the merchant's situation (competitors set?
 * orders on file? which sources exist?) and produces an explicit, PRIORITIZED plan:
 * warmest/highest-intent sources first, clearly-inapplicable ones skipped with a
 * reason. It's the "what to do" brain — inspectable, so the operator can see exactly
 * which methods ran and why, and the closed loop can learn from per-source yield.
 */

export interface PlannedSource {
  sourceType: string;
  label: string;
  /** 1 = warmest/run first. */
  priority: number;
  rationale: string;
}
export interface SkippedSource {
  sourceType: string;
  reason: string;
}
export interface DiscoveryPlan {
  steps: PlannedSource[];
  skipped: SkippedSource[];
  notes: string[];
}

// Warmth ranking + human labels. Warmer = stronger intent signal, run first so the
// limit budget is spent on the best candidates.
const SOURCE_META: Record<string, { label: string; priority: number }> = {
  backlink_mining: { label: "Competitor-affiliate mining (backlinks)", priority: 1 },
  customer_mining: { label: "First-party customer mining", priority: 1 },
  competitor_affiliate_mining: { label: "Competitor-affiliate (demo generator)", priority: 2 },
  serp_mining: { label: "Buyer-intent SERP mining", priority: 3 },
  creator_discovery: { label: "Creator discovery (demo generator)", priority: 4 },
};

function rationaleFor(type: string, hasCompetitors: boolean, orderCount: number): string {
  switch (type) {
    case "backlink_mining":
      return "Competitors already have affiliates — backlink mining surfaces proven promoters in your exact niche (warmest).";
    case "customer_mining":
      return `Your ${orderCount} buyers are the warmest, lowest-bounce source — repeat/high-AOV customers who already love the product.`;
    case "competitor_affiliate_mining":
      return "Generates competitor-promoter prospects (demo data unless a backlink provider is wired).";
    case "serp_mining":
      return "Broad coverage: buyer-intent + platform-targeted queries surface creators across the web.";
    case "creator_discovery":
      return "Generic creator prospects (demo data).";
    default:
      return "Custom discovery source.";
  }
}

/** Build the prioritized discovery plan for a merchant. */
export async function planDiscovery(
  deps: RecruitmentDeps,
  merchantId: string,
  opts?: { excludeSourceTypes?: string[] },
): Promise<DiscoveryPlan> {
  const merchant = await deps.db.merchants.require(merchantId);
  const hasCompetitors = merchant.competitors.filter(Boolean).length > 0;
  const orderCount = await deps.db.orders.count((o) => o.merchantId === merchantId).catch(() => 0);
  const excluded = new Set(opts?.excludeSourceTypes ?? []);

  const steps: PlannedSource[] = [];
  const skipped: SkippedSource[] = [];
  const notes: string[] = [];

  for (const source of deps.discoverySources) {
    const type = source.sourceType;
    const meta = SOURCE_META[type] ?? { label: type, priority: 5 };
    if (excluded.has(type)) {
      skipped.push({ sourceType: type, reason: "pruned — low yield in this merchant's history" });
      continue;
    }
    if ((type === "backlink_mining" || type === "competitor_affiliate_mining") && !hasCompetitors) {
      skipped.push({ sourceType: type, reason: "no competitors set in the ICP" });
      continue;
    }
    if (type === "customer_mining" && orderCount === 0) {
      skipped.push({ sourceType: type, reason: "no orders on file yet" });
      continue;
    }
    steps.push({ sourceType: type, label: meta.label, priority: meta.priority, rationale: rationaleFor(type, hasCompetitors, orderCount) });
  }

  steps.sort((a, b) => a.priority - b.priority);
  if (!hasCompetitors) {
    notes.push("No competitors set — add them to the ICP to unlock competitor-affiliate mining (the warmest source).");
  }
  if (steps.length === 0) notes.push("No applicable discovery sources for this merchant yet.");
  return { steps, skipped, notes };
}
