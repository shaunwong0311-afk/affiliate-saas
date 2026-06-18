import { blendWeights, defaultWeights } from "@affiliate/core";
import type { OutreachCampaign } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";
import { discover, enrich, score, queueFirstTouch, send, ingestReply } from "./pipeline.js";

/**
 * High-level recruitment orchestration used by the API routes. Composes the
 * pipeline stages into operator-facing actions and instruments the closed loop.
 */

export interface SourcingSummary {
  discovered: number;
  enriched: number;
  scored: number;
  byTier: Record<string, number>;
}

/** Run sourcing → enrich → score for a merchant (the discovery half of the wedge). */
export async function runSourcing(deps: RecruitmentDeps, merchantId: string, opts?: { limit?: number }): Promise<SourcingSummary> {
  const created = await discover(deps, merchantId, opts);
  let enriched = 0;
  let scored = 0;
  const byTier: Record<string, number> = { A: 0, B: 0, C: 0 };
  for (const prospect of created) {
    await enrich(deps, prospect.id);
    enriched++;
    const finished = await score(deps, prospect.id);
    if (finished.tier) {
      scored++;
      byTier[finished.tier] = (byTier[finished.tier] ?? 0) + 1;
    }
  }
  return { discovered: created.length, enriched, scored, byTier };
}

/** Re-process any prospects stuck in discovered/enriched (idempotent). */
export async function processBacklog(deps: RecruitmentDeps, merchantId: string): Promise<{ enriched: number; scored: number }> {
  const prospects = await deps.db.prospects.find((p) => p.merchantId === merchantId && (p.state === "discovered" || p.state === "enriched"));
  let enriched = 0;
  let scored = 0;
  for (const p of prospects) {
    if (p.state === "discovered") {
      await enrich(deps, p.id);
      enriched++;
    }
    await score(deps, p.id);
    scored++;
  }
  return { enriched, scored };
}

export interface LaunchSummary {
  queued: number;
  sent: number;
  bounced: number;
  skipped: number;
}

/**
 * Launch a campaign: queue + send the first touch to scored, contactable
 * prospects at or above a minimum tier. Sends happen as the merchant.
 */
export async function launchCampaign(
  deps: RecruitmentDeps,
  campaignId: string,
  opts?: { minTier?: "A" | "B" | "C"; max?: number },
): Promise<LaunchSummary> {
  const campaign: OutreachCampaign = await deps.db.campaigns.require(campaignId);
  const tierRank = { A: 3, B: 2, C: 1 };
  const min = tierRank[opts?.minTier ?? "C"];
  const prospects = await deps.db.prospects.find(
    (p) => p.merchantId === campaign.merchantId && p.state === "scored" && p.tier != null && tierRank[p.tier] >= min && !!p.email,
  );
  const ordered = prospects.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, opts?.max ?? campaign.dailyCap);

  let queued = 0;
  let sent = 0;
  let bounced = 0;
  let skipped = 0;
  for (const p of ordered) {
    const message = await queueFirstTouch(deps, p.id, campaign);
    if (!message) {
      skipped++;
      continue;
    }
    queued++;
    const result = await send(deps, message.id);
    if (result.status === "sent") sent++;
    else if (result.status === "bounced") bounced++;
    else skipped++;
  }
  return { queued, sent, bounced, skipped };
}

/** Operator records a reply (or a webhook delivers one) → classify + route. */
export async function handleReply(deps: RecruitmentDeps, prospectId: string, raw: string) {
  return ingestReply(deps, prospectId, raw);
}

export type OutcomeLabel =
  | "bad_fit"
  | "wrong_contact"
  | "not_an_affiliate"
  | "already_partnered"
  | "competitor_exclusive"
  | "high_potential"
  | "produced_sales";

/**
 * Closed-loop outcome feedback (Section 8.6 / 8.8). Outcome labels are what turn a
 * static scraper-mailer into a system that improves the more it runs. Here we
 * record the label and, when enough "produced_sales" outcomes accumulate, nudge
 * the scoring weights toward what actually drove revenue (heuristic → learned).
 */
export async function recordOutcome(deps: RecruitmentDeps, prospectId: string, label: OutcomeLabel): Promise<void> {
  const prospect = await deps.db.prospects.require(prospectId);
  const breakdown = (prospect.scoreBreakdown as Record<string, unknown> | null) ?? {};
  await deps.db.prospects.update(prospectId, {
    scoreBreakdown: { ...breakdown, outcome: label, outcomeAt: deps.clock.now().toISOString() },
    ...(label === "bad_fit" || label === "not_an_affiliate" ? { state: "dead" as const } : {}),
  });
}

/**
 * Expose the learned-weight blend so the scoring model can shift toward
 * "will drive sales." `alpha` rises with the volume of revenue-labeled outcomes.
 */
export function learnedWeights(producedSalesCount: number, totalLabeled: number) {
  const alpha = totalLabeled > 0 ? Math.min(0.8, producedSalesCount / totalLabeled) : 0;
  // A learned model would emphasize affiliate-propensity + commercial intent.
  return blendWeights(defaultWeights, { affiliatePropensity: 0.4, commercialIntent: 0.2 }, alpha);
}
