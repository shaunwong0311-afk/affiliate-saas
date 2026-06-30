import { blendWeights, defaultWeights, newId, preScoreProspect, type PreScoreResult } from "@affiliate/core";
import type { OutreachCampaign, Prospect, ProspectOutcome } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";
import { discover, enrich, score, queueFirstTouch, send } from "./pipeline.js";
import { planDiscovery, type DiscoveryPlan } from "./discovery-planner.js";
import { routeReply, type ReplyOutcome } from "./reply-router.js";
import { isGoodLocalSendTime } from "./send-timing.js";
import { isSuppressed } from "./suppression.js";
import { existingAffiliateEmails } from "./guards.js";

/**
 * High-level recruitment orchestration used by the API routes. Composes the
 * pipeline stages into operator-facing actions and instruments the closed loop.
 */

export interface SourcingSummary {
  discovered: number;
  enriched: number;
  scored: number;
  byTier: Record<string, number>;
  /** Triage band counts (pre-score): how the discovered prospects split hot/warm/cold. */
  byBand: Record<string, number>;
  /** Prospects left un-enriched this run because the enrichment budget was hit (the
   * coldest tail — they stay `discovered` for a later pass). */
  deferred: number;
  /** Prospects skipped by a guard (already an affiliate / suppressed) — never enriched. */
  guarded: number;
  /** Of the discovered prospects, how many came from REAL sources vs synthetic demo
   * generators. `synthetic` prospects must be labeled "demo data" in the UI. */
  real: number;
  synthetic: number;
  /** The plan the orchestrator chose — which sources ran (warmest first) and which
   * were skipped and why. Surfaced so the operator sees exactly what happened. */
  plan: DiscoveryPlan;
}

/** Cheap, reachable-contact heuristic from what discovery already captured. */
function hasContactPath(p: Prospect): boolean {
  const ev = (p.evidence ?? {}) as { contactEmails?: unknown[]; contactUrls?: unknown[]; contactForm?: boolean };
  return !!(p.email || ev.contactEmails?.length || ev.contactUrls?.length || ev.contactForm || p.channelUrl || p.siteUrl);
}

/** Any email we already know for a prospect at discovery time (own + page-extracted). */
function knownEmailOf(p: Prospect): string | null {
  if (p.email) return p.email;
  const ev = (p.evidence ?? {}) as { contactEmails?: { email?: string }[] };
  return ev.contactEmails?.[0]?.email ?? null;
}

/**
 * Run sourcing → enrich → score for a merchant (the discovery half of the wedge).
 *
 * Triage: enrichment is the expensive stage, so rather than enrich every prospect
 * identically we PRE-SCORE each on cheap discovery-time signals, enrich the most
 * promising FIRST, and tier the enrichment DEPTH by band (deep on hot, shallow on
 * cold). With `maxEnrich` set, the coldest tail is deferred (left `discovered`) so a
 * run on a huge candidate set still spends its budget on the best prospects.
 */
export async function runSourcing(
  deps: RecruitmentDeps,
  merchantId: string,
  opts?: { limit?: number; excludeSourceTypes?: string[]; maxEnrich?: number },
): Promise<SourcingSummary> {
  // Plan first: decide which methods to run, warmest-first, skipping the inapplicable.
  const plan = await planDiscovery(deps, merchantId, { excludeSourceTypes: opts?.excludeSourceTypes });
  const created = await discover(deps, merchantId, { ...opts, plan });

  // Pre-score every prospect on cheap signals, then process best-first.
  const triaged: Array<{ prospect: Prospect; pre: PreScoreResult }> = [];
  for (const prospect of created) {
    const sig = await deps.db.prospectSignals.findOne((s) => s.prospectId === prospect.id);
    const pre = preScoreProspect({
      runsAffiliateLinks: sig?.isAffiliate ?? false,
      promotesCompetitor: sig?.promotesCompetitor ?? false,
      domainAuthority: sig?.da ?? null,
      commercialIntent: sig?.intent ?? 0,
      hasContactPath: hasContactPath(prospect),
    });
    triaged.push({ prospect, pre });
  }
  triaged.sort((a, b) => b.pre.preScore - a.pre.preScore);

  // Guard set: people we already have as affiliates (computed once for the whole run).
  const affiliateEmails = await existingAffiliateEmails(deps, merchantId);

  let enriched = 0;
  let scored = 0;
  let synthetic = 0;
  let processed = 0;
  let guarded = 0;
  const byTier: Record<string, number> = { A: 0, B: 0, C: 0 };
  const byBand: Record<string, number> = { hot: 0, warm: 0, cold: 0 };

  for (const { prospect, pre } of triaged) {
    byBand[pre.band] = (byBand[pre.band] ?? 0) + 1;
    if (prospect.synthetic) synthetic++;

    // Guard: if we already know a contact email for this prospect and it's an existing
    // affiliate or a suppressed/opted-out address, kill it now — never waste enrichment
    // (or risk outreach) on someone we already have or can't email.
    const email = knownEmailOf(prospect);
    if (email && (affiliateEmails.has(email.toLowerCase()) || (await isSuppressed(deps, merchantId, email)))) {
      await deps.db.prospects.update(prospect.id, { state: "dead", updatedAt: deps.clock.now().toISOString() });
      guarded++;
      continue;
    }

    // Enrichment budget: defer the coldest tail (stays `discovered` for a later pass).
    if (opts?.maxEnrich != null && processed >= opts.maxEnrich) continue;
    processed++;
    // Tier only the PAID enrichment depth; contact-finding fetches always run (they're
    // cheap + cached, and they're what make the prospect contactable).
    await enrich(deps, prospect.id, { maxAccounts: pre.enrichDepth });
    enriched++;
    const finished = await score(deps, prospect.id);
    if (finished.tier) {
      scored++;
      byTier[finished.tier] = (byTier[finished.tier] ?? 0) + 1;
    }
  }
  return {
    discovered: created.length,
    enriched,
    scored,
    byTier,
    byBand,
    deferred: created.length - processed - guarded,
    guarded,
    real: created.length - synthetic,
    synthetic,
    plan,
  };
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
  /** Held back because it wasn't a good local send time for the recipient (try next run). */
  deferred: number;
}

/**
 * Launch a campaign: queue + send the first touch to scored, contactable
 * prospects at or above a minimum tier. Sends happen as the merchant.
 */
export async function launchCampaign(
  deps: RecruitmentDeps,
  campaignId: string,
  opts?: { minTier?: "A" | "B" | "C"; max?: number; respectLocalTime?: boolean },
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
  let deferred = 0;
  const now = deps.clock.now();
  for (const p of ordered) {
    // Send-time optimization: hold prospects whose local time isn't a good send window
    // (picked up on the next run). Unknown geo never defers.
    if (opts?.respectLocalTime && !isGoodLocalSendTime(p.country, now)) {
      deferred++;
      continue;
    }
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
  return { queued, sent, bounced, skipped, deferred };
}

export interface AbVariantResult {
  variant: string;
  sent: number;
  replied: number;
  replyRate: number;
}

/** Reply-rate by A/B variant for a campaign (only template-variant sends are comparable). */
export async function abResults(deps: RecruitmentDeps, campaignId: string): Promise<AbVariantResult[]> {
  const messages = await deps.db.outreachMessages.find((m) => m.campaignId === campaignId && (m.variant ?? "").startsWith("ab:"));
  const byVariant = new Map<string, { sent: number; replied: number }>();
  for (const m of messages) {
    if (m.status !== "sent" && m.status !== "replied") continue;
    const cur = byVariant.get(m.variant!) ?? { sent: 0, replied: 0 };
    cur.sent++;
    const replies = await deps.db.replies.find((r) => r.prospectId === m.prospectId);
    if (replies.length) cur.replied++;
    byVariant.set(m.variant!, cur);
  }
  return [...byVariant.entries()]
    .map(([variant, s]) => ({ variant, sent: s.sent, replied: s.replied, replyRate: s.sent ? s.replied / s.sent : 0 }))
    .sort((a, b) => a.variant.localeCompare(b.variant));
}

/** A reply (operator-entered or webhook-delivered) → classify + two-track route. */
export async function handleReply(
  deps: RecruitmentDeps,
  prospectId: string,
  raw: string,
  opts?: { meetingTier?: "A" | "B" | "C"; signupBaseUrl?: string },
): Promise<ReplyOutcome> {
  return routeReply(deps, prospectId, raw, opts);
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
export async function recordOutcome(
  deps: RecruitmentDeps,
  prospectId: string,
  label: OutcomeLabel,
  extra?: { relationshipId?: string; producedRevenueCents?: number },
): Promise<void> {
  const prospect = await deps.db.prospects.require(prospectId);
  const now = deps.clock.now().toISOString();

  // Append an immutable outcome event — the durable substrate for source-yield,
  // cost-per-producing-affiliate, and the learned-weights loop.
  const outcome: ProspectOutcome = {
    id: newId("pout"),
    merchantId: prospect.merchantId,
    prospectId,
    relationshipId: extra?.relationshipId ?? null,
    sourceType: prospect.source,
    label,
    producedRevenueCents: extra?.producedRevenueCents ?? 0,
    ts: now,
  };
  await deps.db.prospectOutcomes.insert(outcome);

  const breakdown = (prospect.scoreBreakdown as Record<string, unknown> | null) ?? {};
  await deps.db.prospects.update(prospectId, {
    scoreBreakdown: { ...breakdown, outcome: label, outcomeAt: now },
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
