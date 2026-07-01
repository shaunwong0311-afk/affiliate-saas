import { newId, type Tier } from "@affiliate/core";
import type { AutomationState, OutreachCampaign, Prospect } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";
import { runSourcing, processBacklog } from "./service.js";
import { expandFrontier } from "./frontier.js";
import { queueFirstTouch, send } from "./pipeline.js";
import { nextStep, isWithinSendWindow, personalizationDepth } from "./sequencing.js";
import { renderTemplate } from "@affiliate/integrations";
import { deliverabilityHealth, pickSendableMailbox, monitorDeliverability } from "./deliverability.js";
import { lowYieldSources } from "./learning.js";

/**
 * The autonomous "from-scratch" engine (the agreed L4-with-gates target). One
 * cycle: source the open web → enrich → score → auto-advance high-confidence
 * prospects to outreach (A-tier and borderline held for the human gate) → send
 * first touches and follow-ups within send windows + caps → all gated by the
 * deliverability circuit breaker. A scheduler runs this per merchant on a cadence;
 * the operator's job becomes approve-and-monitor, not find-and-write.
 */

const tierRank: Record<Tier, number> = { A: 3, B: 2, C: 1 };

export async function getAutomationState(deps: RecruitmentDeps, merchantId: string): Promise<AutomationState> {
  const existing = await deps.db.automationStates.get(merchantId);
  if (existing) return existing;
  const now = deps.clock.now().toISOString();
  const state: AutomationState = {
    id: merchantId,
    merchantId,
    status: "off",
    autoSendMinScore: 70,
    hitlTier: "A", // A-tier always needs a human before the first send
    meetingTier: "A",
    aiSdrMode: "hitl", // AI-SDR drafts; a human approves — until the merchant graduates to autopilot
    sourcingLimitPerCycle: 20,
    lastCycleAt: null,
    updatedAt: now,
  };
  await deps.db.automationStates.insert(state);
  return state;
}

export async function setAutomationState(deps: RecruitmentDeps, merchantId: string, patch: Partial<AutomationState>): Promise<AutomationState> {
  await getAutomationState(deps, merchantId);
  return deps.db.automationStates.update(merchantId, { ...patch, updatedAt: deps.clock.now().toISOString() });
}

export interface CycleSummary {
  status: string;
  sourced: number;
  scored: number;
  /** Of `sourced`, how many came from real vs synthetic (demo) sources. */
  real: number;
  synthetic: number;
  autoSent: number;
  followUpsSent: number;
  heldForReview: number;
  circuitOpen: boolean;
  prunedSources: string[];
  /** Recursive frontier: new competitor seeds promoted this cycle + frontier backlog. */
  frontierPromoted: number;
  frontierPending: number;
  /** Deliverability monitor: mailboxes auto-paused (bounce breach) + graduated warmup this cycle. */
  mailboxesPaused: number;
  mailboxesWarmed: number;
}

/** Run one autonomous cycle for a merchant. Idempotent and safe to call repeatedly. */
export async function autonomousCycle(deps: RecruitmentDeps, merchantId: string): Promise<CycleSummary> {
  const state = await getAutomationState(deps, merchantId);
  const now = deps.clock.now();
  const empty: CycleSummary = { status: state.status, sourced: 0, scored: 0, real: 0, synthetic: 0, autoSent: 0, followUpsSent: 0, heldForReview: 0, circuitOpen: false, prunedSources: [], frontierPromoted: 0, frontierPending: 0, mailboxesPaused: 0, mailboxesWarmed: 0 };
  if (state.status !== "running") return empty;

  const pruned = await lowYieldSources(deps, merchantId);
  // Per-mailbox deliverability monitor FIRST — auto-pause any burning mailbox + advance warmup
  // before we pick a sender, so a breaching mailbox drops out of this cycle's rotation.
  const monitor = await monitorDeliverability(deps, merchantId, now);
  const health = await deliverabilityHealth(deps, merchantId);

  // 1) Source + enrich + score (skip pruned low-yield sources).
  const sourcing = await runSourcing(deps, merchantId, { limit: state.sourcingLimitPerCycle, excludeSourceTypes: [...pruned] });

  // 1b) Recursive expansion: mine the frontier (competitor → their affiliates → the
  // merchants those affiliates ALSO promote → next seeds). Hard-capped per cycle so it
  // can't run away; enrich+score anything it surfaced.
  const expansion = await expandFrontier(deps, merchantId, { maxSeedsPerCycle: 2, maxNewSeeds: 5 }).catch(() => null);
  if (expansion && expansion.discovered > 0) await processBacklog(deps, merchantId);

  // 2) Auto-advance scored prospects; hold A-tier / borderline for the human gate.
  const campaign = await activeCampaign(deps, merchantId);
  let autoSent = 0;
  let heldForReview = 0;
  if (campaign && !health.circuitOpen) {
    const scored = await deps.db.prospects.find((p) => p.merchantId === merchantId && p.state === "scored" && !!p.email);
    for (const p of scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
      const requiresHuman = p.tier != null && tierRank[p.tier] >= tierRank[state.hitlTier];
      const autoEligible = !requiresHuman && (p.score ?? 0) >= state.autoSendMinScore;
      if (!autoEligible) {
        heldForReview += 1;
        continue;
      }
      if (!(await capacityAvailable(deps, merchantId, campaign, now))) break;
      const message = await queueFirstTouch(deps, p.id, campaign);
      if (!message) continue;
      const result = await send(deps, message.id);
      if (result.status === "sent") autoSent += 1;
    }
  } else if (campaign) {
    heldForReview = await deps.db.prospects.count((p) => p.merchantId === merchantId && p.state === "scored");
  }

  // 3) Advance multi-step sequences (follow-ups / breakup) with hard stops.
  let followUpsSent = 0;
  if (campaign && !health.circuitOpen) {
    followUpsSent = await advanceSequences(deps, merchantId, campaign, now);
  }

  await setAutomationState(deps, merchantId, { lastCycleAt: now.toISOString() });
  return {
    status: state.status,
    sourced: sourcing.discovered,
    scored: sourcing.scored,
    real: sourcing.real,
    synthetic: sourcing.synthetic,
    autoSent,
    followUpsSent,
    heldForReview,
    circuitOpen: health.circuitOpen,
    prunedSources: [...pruned],
    frontierPromoted: expansion?.promoted.length ?? 0,
    frontierPending: expansion?.frontierPending ?? 0,
    mailboxesPaused: monitor.paused.length,
    mailboxesWarmed: monitor.warmed.length,
  };
}

/** Send the next sequence step to prospects mid-cadence whose delay has elapsed. */
export async function advanceSequences(deps: RecruitmentDeps, merchantId: string, campaign: OutreachCampaign, now: Date): Promise<number> {
  if (!isWithinSendWindow(campaign, now)) return 0;
  const active = await deps.db.prospects.find(
    (p) => p.merchantId === merchantId && (p.state === "contacted" || p.state === "in_sequence") && !!p.email,
  );
  let sent = 0;
  for (const p of active) {
    const msgs = (await deps.db.outreachMessages.find((m) => m.prospectId === p.id && m.campaignId === campaign.id && m.status === "sent")).sort(
      (a, b) => b.step - a.step,
    );
    const last = msgs[0];
    if (!last) continue;
    const next = nextStep(campaign, last.step);
    if (!next) continue; // sequence exhausted (breakup already sent)
    const lastSentMs = last.sentAt ? new Date(last.sentAt).getTime() : 0;
    if (now.getTime() - lastSentMs < next.delayDays * 86_400_000) continue; // not due yet
    if (!(await capacityAvailable(deps, merchantId, campaign, now))) break;

    const depth = personalizationDepth(p.tier);
    const tokens = { name: p.identity, merchant: "", offer: "", angle: depth === "deep" ? "Following up — still a strong fit." : "Circling back." };
    const message = await deps.db.outreachMessages.insert({
      id: newId("omsg"),
      prospectId: p.id,
      campaignId: campaign.id,
      step: next.step,
      variant: depth,
      subject: renderTemplate(next.subject, tokens),
      body: renderTemplate(next.body, tokens),
      sentAt: null,
      status: "queued",
    });
    const result = await send(deps, message.id);
    if (result.status === "sent") sent += 1;
  }
  return sent;
}

async function activeCampaign(deps: RecruitmentDeps, merchantId: string): Promise<OutreachCampaign | null> {
  return deps.db.campaigns.findOne((c) => c.merchantId === merchantId && c.status === "active");
}

/** True if a mailbox has remaining daily capacity and we're in the send window. */
async function capacityAvailable(deps: RecruitmentDeps, merchantId: string, campaign: OutreachCampaign, now: Date): Promise<boolean> {
  if (!isWithinSendWindow(campaign, now)) return false;
  const mailbox = await pickSendableMailbox(deps, merchantId, now);
  return mailbox != null;
}

export type { Prospect };
