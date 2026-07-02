import { newId, type Tier } from "@affiliate/core";
import type { AutomationState, OutreachCampaign, Prospect } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";
import { runSourcing, processBacklog } from "./service.js";
import { expandFrontier } from "./frontier.js";
import { queueFirstTouch, send } from "./pipeline.js";
import { nextStep, isWithinSendWindow, personalizationDepth, pickVariant } from "./sequencing.js";
import { deliverabilityHealth, capacityAvailable, monitorDeliverability } from "./deliverability.js";
import { lowYieldSources } from "./learning.js";
import { draftDm } from "./dm.js";
import { evidenceSummary, personalizeOutreach } from "./personalization.js";
import type { DmTask } from "@affiliate/db";

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
  /** DM sequence steps that auto-created a prepared DM task for the operator this cycle. */
  dmTasksCreated: number;
}

/** Run one autonomous cycle for a merchant. Idempotent and safe to call repeatedly. */
export async function autonomousCycle(deps: RecruitmentDeps, merchantId: string): Promise<CycleSummary> {
  const state = await getAutomationState(deps, merchantId);
  const now = deps.clock.now();
  const empty: CycleSummary = { status: state.status, sourced: 0, scored: 0, real: 0, synthetic: 0, autoSent: 0, followUpsSent: 0, heldForReview: 0, circuitOpen: false, prunedSources: [], frontierPromoted: 0, frontierPending: 0, mailboxesPaused: 0, mailboxesWarmed: 0, dmTasksCreated: 0 };
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

  // 3) Advance multi-step sequences (follow-ups / breakup / DM steps) with hard stops.
  let followUpsSent = 0;
  let dmTasksCreated = 0;
  if (campaign && !health.circuitOpen) {
    const adv = await advanceSequences(deps, merchantId, campaign, now);
    followUpsSent = adv.emailsSent;
    dmTasksCreated = adv.dmTasksCreated;
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
    dmTasksCreated,
  };
}

/**
 * Advance mid-cadence prospects whose delay has elapsed. Email steps send as the merchant;
 * `channel:"dm"` steps auto-create a fully-prepared DM task (draft + best handle + deep link)
 * for the operator to send by hand — NEVER auto-DM (ToS). The cadence pointer advances across
 * BOTH channels, so an email→DM→email sequence flows; a DM step with no DM-able handle records
 * a "skipped" task so the prospect doesn't get stuck on it.
 */
export async function advanceSequences(
  deps: RecruitmentDeps,
  merchantId: string,
  campaign: OutreachCampaign,
  now: Date,
): Promise<{ emailsSent: number; dmTasksCreated: number }> {
  if (!isWithinSendWindow(campaign, now)) return { emailsSent: 0, dmTasksCreated: 0 };
  const active = await deps.db.prospects.find(
    (p) => p.merchantId === merchantId && (p.state === "contacted" || p.state === "in_sequence") && !!p.email,
  );
  let emailsSent = 0;
  let dmTasksCreated = 0;
  for (const p of active) {
    const sentMsgs = (await deps.db.outreachMessages.find((m) => m.prospectId === p.id && m.campaignId === campaign.id && m.status === "sent")).sort((a, b) => b.step - a.step);
    const dmTasks = (await deps.db.dmTasks.find((t) => t.prospectId === p.id && t.campaignId === campaign.id)).sort((a, b) => b.step - a.step);
    // Cadence position = the furthest step reached on EITHER channel.
    const lastStep = Math.max(sentMsgs[0]?.step ?? 0, dmTasks[0]?.step ?? 0);
    if (lastStep === 0) continue; // never first-touched
    const next = nextStep(campaign, lastStep);
    if (!next) continue; // sequence exhausted

    const lastActivityMs = Math.max(
      sentMsgs[0]?.sentAt ? new Date(sentMsgs[0].sentAt).getTime() : 0,
      dmTasks[0]?.createdAt ? new Date(dmTasks[0].createdAt).getTime() : 0,
    );
    if (now.getTime() - lastActivityMs < next.delayDays * 86_400_000) continue; // not due yet

    if (next.channel === "dm") {
      if (dmTasks.some((t) => t.step === next.step)) continue; // already prepared (idempotent)
      const merchant = await deps.db.merchants.require(merchantId);
      const draft = await draftDm(deps, merchant, p);
      const base = { id: newId("dmt"), merchantId, prospectId: p.id, campaignId: campaign.id, step: next.step, createdAt: now.toISOString(), sentAt: null };
      const task: DmTask = draft
        ? { ...base, platform: draft.target.platform, handle: draft.target.handle, deepLink: draft.target.deepLink, opensComposer: draft.target.opensComposer, message: draft.message, context: evidenceSummary(merchant, p), status: "pending" }
        : { ...base, platform: "", handle: "", deepLink: null, opensComposer: false, message: "", context: "no DM-able handle in the profile graph", status: "skipped" };
      await deps.db.dmTasks.insert(task);
      if (draft) dmTasksCreated += 1;
      continue;
    }

    // Email step.
    if (!(await capacityAvailable(deps, merchantId, campaign, now))) break;
    // Retry-not-duplicate: if a message already exists at this step, re-send THAT row instead
    // of inserting a new one every cycle. Content-gate blocks are deterministic → skip forever
    // (the failed message + blockedReason are the operator's fix-it surface).
    const existing = (await deps.db.outreachMessages.find((m) => m.prospectId === p.id && m.campaignId === campaign.id && m.step === next.step))[0];
    if (existing) {
      if ((existing.blockedReason ?? "").startsWith("content gate")) continue;
      if (existing.status === "queued" || existing.status === "failed") {
        const retried = await send(deps, existing.id);
        if (retried.status === "sent") emailsSent += 1;
      }
      continue;
    }

    const merchant = await deps.db.merchants.require(merchantId);
    const depth = personalizationDepth(p.tier);
    const tokens = {
      name: p.identity,
      merchant: merchant.name,
      offer: merchant.niche ?? "our products",
      angle: depth === "deep" ? "Following up — still a strong fit." : "Circling back.",
    };
    // Follow-ups get the SAME quality as the first touch: step variants (A/B) + the merchant's
    // personalization plan — not a bare token render with blank {{merchant}}/{{offer}}.
    let effectiveStep = next;
    let abLabel: string | null = null;
    if (next.variants?.length) {
      const picked = pickVariant(next.variants, p.id);
      effectiveStep = { ...next, subject: picked.value.subject, body: picked.value.body };
      abLabel = `ab:v${picked.index}`;
    }
    const personalized = await personalizeOutreach(deps, { merchant, prospect: p, step: effectiveStep, tokens });
    // Same-thread follow-up: when the prior step's provider Message-Id is known, land in the
    // same conversation ("Re: <original subject>"); send() threads via In-Reply-To.
    const priorThreaded = sentMsgs.find((m) => !!m.providerMessageId);
    const subject = priorThreaded ? `Re: ${priorThreaded.subject.replace(/^(re|fwd):\s*/i, "")}` : personalized.subject;

    const message = await deps.db.outreachMessages.insert({
      id: newId("omsg"),
      prospectId: p.id,
      campaignId: campaign.id,
      step: next.step,
      variant: personalized.mode === "llm" ? "llm" : abLabel ?? depth,
      subject,
      body: personalized.body,
      sentAt: null,
      status: "queued",
    });
    if (personalized.mode === "llm") {
      await deps.db.usageEvents.insert({ id: newId("use"), merchantId, kind: "personalization", quantity: 1, sourceId: message.id, ts: now.toISOString() });
    }
    const result = await send(deps, message.id);
    if (result.status === "sent") emailsSent += 1;
  }
  return { emailsSent, dmTasksCreated };
}

async function activeCampaign(deps: RecruitmentDeps, merchantId: string): Promise<OutreachCampaign | null> {
  return deps.db.campaigns.findOne((c) => c.merchantId === merchantId && c.status === "active");
}


export type { Prospect };
