import { newId, type Tier } from "@affiliate/core";
import type { AutomationState, Merchant, OutreachCampaign, OutreachMessage, Prospect, SequenceStep } from "@affiliate/db";
import { loggerOf, type RecruitmentDeps } from "./deps.js";
import { runSourcing, processBacklog, type SourcingSummary } from "./service.js";
import { expandFrontier, type ExpansionReport } from "./frontier.js";
import { queueFirstTouch, send, outreachBlockedReason, retryNotDue } from "./pipeline.js";
import { nextStep, firstStep, isWithinSendWindow, personalizationDepth, pickVariant, stepFingerprint } from "./sequencing.js";
import { deliverabilityHealth, capacityAvailable, monitorDeliverability, inboundState } from "./deliverability.js";
import { lowYieldSources } from "./learning.js";
import { draftDm } from "./dm.js";
import { evidenceSummary, personalizeOutreach } from "./personalization.js";
import { localTimeDeferral } from "./send-timing.js";
import { ingestReplies } from "./reply-router.js";
import { withMerchantLock, withSourcingLock } from "./merchant-lock.js";
import type { DmTask } from "@affiliate/db";

/**
 * The autonomous "from-scratch" engine (the agreed L4-with-gates target). One
 * cycle: read the inbox → (when due) source the open web → enrich → score →
 * auto-advance high-confidence prospects to outreach (A-tier and borderline held
 * for the human gate) → send first touches and follow-ups within send windows +
 * caps → all gated by the deliverability circuit breaker. A scheduler runs this per
 * merchant on a cadence; the operator's job becomes approve-and-monitor, not
 * find-and-write.
 */

const tierRank: Record<Tier, number> = { A: 3, B: 2, C: 1 };

/** Sourcing cadence when the merchant has not set one: once a day. */
export const DEFAULT_SOURCING_INTERVAL_HOURS = 24;

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
    sourcingIntervalHours: DEFAULT_SOURCING_INTERVAL_HOURS,
    lastSourcedAt: null,
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

/** When sourcing is next due for a merchant (null = now: it has never run). */
export function nextSourcingAt(state: Pick<AutomationState, "lastSourcedAt" | "sourcingIntervalHours">): Date | null {
  if (!state.lastSourcedAt) return null;
  const hours = state.sourcingIntervalHours && state.sourcingIntervalHours > 0 ? state.sourcingIntervalHours : DEFAULT_SOURCING_INTERVAL_HOURS;
  return new Date(new Date(state.lastSourcedAt).getTime() + hours * 3_600_000);
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
  /** Whether the (paid) sourcing run happened in this cycle — it only runs when its interval
   *  has elapsed — and when it is next due. Sends and follow-ups run on every cycle. */
  sourcingRan: boolean;
  nextSourcingAt: string | null;
  /** Why nothing could be SENT this cycle (missing postal address, breaker open, no active
   *  campaign). Null when sending was allowed. */
  sendBlockedReason: string | null;
  /** Why FOLLOW-UPS were held this cycle (the mailbox cannot read replies). Null when allowed. */
  followUpsBlockedReason: string | null;
  /** Prospects skipped because it is not a good local time to email them (retried next cycle). */
  deferredLocalTime: number;
  /** Why this cycle's sourcing run failed, when it did. Sending still ran. Null otherwise. */
  sourcingError: string | null;
}

/**
 * Run one autonomous cycle for a merchant. Idempotent and safe to call repeatedly — and
 * concurrently: every step that queues or sends runs under the merchant's send lock.
 *
 * Three things run at different rates (AUDIT-2026-10 O14). Reply ingestion and sending run on
 * EVERY cycle. Sourcing — the part that costs money per query — runs only when
 * `sourcingIntervalHours` (default 24) has elapsed since `lastSourcedAt`, or when the caller
 * forces it (the operator's "Run one cycle" button).
 */
export async function autonomousCycle(
  deps: RecruitmentDeps,
  merchantId: string,
  opts: { forceSourcing?: boolean; skipReplyIngestion?: boolean } = {},
): Promise<CycleSummary> {
  const state = await getAutomationState(deps, merchantId);
  const now = deps.clock.now();
  const empty: CycleSummary = { status: state.status, sourced: 0, scored: 0, real: 0, synthetic: 0, autoSent: 0, followUpsSent: 0, heldForReview: 0, circuitOpen: false, prunedSources: [], frontierPromoted: 0, frontierPending: 0, mailboxesPaused: 0, mailboxesWarmed: 0, dmTasksCreated: 0, sourcingRan: false, nextSourcingAt: nextSourcingAt(state)?.toISOString() ?? null, sendBlockedReason: null, followUpsBlockedReason: null, deferredLocalTime: 0, sourcingError: null };
  if (state.status !== "running") return empty;

  // 0) Read the inbox FIRST, outside the send lock: a STOP, a reply or a bounce that has
  //    already arrived must be processed before this cycle decides whom to email, and the read
  //    is what tells us whether each mailbox can see replies at all. (The scheduler tick has
  //    just done this for every mailbox and says so.)
  if (!opts.skipReplyIngestion) {
    await ingestReplies(deps, { merchantId }).catch((e) => loggerOf(deps).error("reply ingestion failed", { merchantId, error: errorMessage(e) }));
  }

  const pruned = await lowYieldSources(deps, merchantId);

  // 1) Source + enrich + score — only when due. Under its own lock (a run takes minutes; two
  //    overlapping runs would pay for every query twice) and never under the send lock.
  // (Held on an object: the run happens inside the lock callback.)
  const ran: { sourcing: SourcingSummary | null; expansion: ExpansionReport | null } = { sourcing: null, expansion: null };
  const due = (s: AutomationState) => opts.forceSourcing || (nextSourcingAt(s)?.getTime() ?? 0) <= now.getTime();
  let sourcingError: string | null = null;
  if (due(state)) {
    // A sourcing failure (a provider outage, a bad key) is reported — logged, on the summary
    // and on the automation state — but it must not cost the merchant this cycle's sends,
    // follow-ups or reply handling: those do not depend on finding new prospects today.
    sourcingError = await withSourcingLock(deps, merchantId, async () => {
      // Re-check inside the lock: a run we waited behind has just sourced.
      if (!due(await getAutomationState(deps, merchantId))) return;
      // Stamp the clock BEFORE running: a sourcing run that throws must not retry every tick.
      await setAutomationState(deps, merchantId, { lastSourcedAt: now.toISOString() });
      // (skip pruned low-yield sources)
      ran.sourcing = await runSourcing(deps, merchantId, { limit: state.sourcingLimitPerCycle, excludeSourceTypes: [...pruned] });
      // 1b) Recursive expansion: mine the frontier (competitor → their affiliates → the
      // merchants those affiliates ALSO promote → next seeds). Hard-capped per cycle so it
      // can't run away; enrich+score anything it surfaced.
      ran.expansion = await expandFrontier(deps, merchantId, { maxSeedsPerCycle: 2, maxNewSeeds: 5 }).catch((e) => {
        loggerOf(deps).warn("frontier expansion failed", { merchantId, error: errorMessage(e) });
        return null;
      });
      if (ran.expansion && ran.expansion.discovered > 0) await processBacklog(deps, merchantId);
    }).then(
      () => null,
      (e) => {
        loggerOf(deps).error("sourcing failed", { merchantId, error: errorMessage(e) });
        return `sourcing failed: ${errorMessage(e)}`.slice(0, 300);
      },
    );
  }
  const sourced = ran.sourcing;
  const expanded = ran.expansion;

  // 2+3) Everything that queues or sends, under the merchant's send lock.
  const sends = await withMerchantLock(deps, merchantId, () => sendPhase(deps, merchantId, now));

  const after = await setAutomationState(deps, merchantId, { lastCycleAt: now.toISOString(), lastError: sourcingError, lastErrorAt: sourcingError ? now.toISOString() : null });
  return {
    status: state.status,
    sourced: sourced?.discovered ?? 0,
    scored: sourced?.scored ?? 0,
    real: sourced?.real ?? 0,
    synthetic: sourced?.synthetic ?? 0,
    ...sends,
    prunedSources: [...pruned],
    frontierPromoted: expanded?.promoted.length ?? 0,
    frontierPending: expanded?.frontierPending ?? 0,
    sourcingRan: sourced != null,
    nextSourcingAt: nextSourcingAt(after)?.toISOString() ?? null,
    sourcingError,
  };
}

type SendPhaseSummary = Pick<
  CycleSummary,
  "autoSent" | "followUpsSent" | "heldForReview" | "circuitOpen" | "mailboxesPaused" | "mailboxesWarmed" | "dmTasksCreated" | "sendBlockedReason" | "followUpsBlockedReason" | "deferredLocalTime"
>;

/** The sending half of a cycle. The caller holds the merchant's send lock. */
async function sendPhase(deps: RecruitmentDeps, merchantId: string, now: Date): Promise<SendPhaseSummary> {
  const out: SendPhaseSummary = { autoSent: 0, followUpsSent: 0, heldForReview: 0, circuitOpen: false, mailboxesPaused: 0, mailboxesWarmed: 0, dmTasksCreated: 0, sendBlockedReason: null, followUpsBlockedReason: null, deferredLocalTime: 0 };
  // Re-read: automation may have been paused while this cycle waited for the lock.
  const state = await getAutomationState(deps, merchantId);
  if (state.status !== "running") return out;

  // Per-mailbox deliverability monitor FIRST — auto-pause any burning mailbox + advance warmup
  // before we pick a sender, so a breaching mailbox drops out of this cycle's rotation.
  const monitor = await monitorDeliverability(deps, merchantId, now);
  out.mailboxesPaused = monitor.paused.length;
  out.mailboxesWarmed = monitor.warmed.length;
  const health = await deliverabilityHealth(deps, merchantId);
  out.circuitOpen = health.circuitOpen;

  const campaign = await activeCampaign(deps, merchantId);
  const merchant = await deps.db.merchants.require(merchantId);
  out.sendBlockedReason = !campaign ? "no active campaign" : health.circuitOpen ? "deliverability circuit breaker is open" : outreachBlockedReason(merchant);
  if (!campaign) return out;
  if (out.sendBlockedReason) {
    out.heldForReview = await deps.db.prospects.count((p) => p.merchantId === merchantId && p.state === "scored");
    return out;
  }

  // 2) Auto-advance scored prospects; hold A-tier / borderline for the human gate.
  const scored = await deps.db.prospects.find((p) => p.merchantId === merchantId && p.state === "scored" && !!p.email);
  // Best prospects first — but one whose first touch has already failed goes behind those
  // never tried, so a single undeliverable message cannot hold the head of the line.
  const first = firstStep(campaign);
  const failedAttempts = new Map<string, number>();
  if (first) {
    const failedRows = await deps.db.outreachMessages.find((m) => m.campaignId === campaign.id && m.step === first.step && m.status === "failed");
    for (const m of failedRows) failedAttempts.set(m.prospectId, Math.max(failedAttempts.get(m.prospectId) ?? 0, m.attempts ?? 0));
  }
  const ordered = scored.sort((a, b) => (failedAttempts.get(a.id) ?? 0) - (failedAttempts.get(b.id) ?? 0) || (b.score ?? 0) - (a.score ?? 0));
  const deferForLocalTime = localTimeDeferral(now, (at) => isWithinSendWindow(campaign, at));
  for (const p of ordered) {
    const requiresHuman = p.tier != null && tierRank[p.tier] >= tierRank[state.hitlTier];
    const autoEligible = !requiresHuman && (p.score ?? 0) >= state.autoSendMinScore;
    if (!autoEligible) {
      out.heldForReview += 1;
      continue;
    }
    // Window, daily cap, warmup ramp, paused mailbox, failure backoff — re-checked per send.
    if (!(await capacityAvailable(deps, merchantId, campaign, now))) break;
    // Recipient-local send time (the same gate a manual launch applies): wait for the
    // recipient's working hours when they will come up inside the campaign's window. Unknown
    // geo never defers.
    if (deferForLocalTime(p.country)) {
      out.deferredLocalTime += 1;
      continue;
    }
    const message = await queueFirstTouch(deps, p.id, campaign);
    if (!message) continue;
    const result = await send(deps, message.id);
    if (result.status === "sent") out.autoSent += 1;
  }

  // 3) Advance multi-step sequences (follow-ups / breakup / DM steps) with hard stops.
  const adv = await advanceSequences(deps, merchantId, campaign, now);
  out.followUpsSent = adv.emailsSent;
  out.dmTasksCreated = adv.dmTasksCreated;
  out.followUpsBlockedReason = adv.blockedReason ?? null;
  out.deferredLocalTime += adv.deferredLocalTime;
  return out;
}

/** Render the copy for a follow-up step (A/B variant pick + the merchant's plan + threading). */
async function renderFollowUp(
  deps: RecruitmentDeps,
  merchant: Merchant,
  prospect: Prospect,
  step: SequenceStep,
  sentMsgs: OutreachMessage[],
): Promise<{ subject: string; body: string; variant: string }> {
  const depth = personalizationDepth(prospect.tier);
  const tokens = {
    name: prospect.identity,
    merchant: merchant.name,
    offer: merchant.niche ?? "our products",
    angle: depth === "deep" ? "Following up — still a strong fit." : "Circling back.",
  };
  // Follow-ups get the SAME quality as the first touch: step variants (A/B) + the merchant's
  // personalization plan — not a bare token render with blank {{merchant}}/{{offer}}.
  let effectiveStep = step;
  let abLabel: string | null = null;
  if (step.variants?.length) {
    const picked = pickVariant(step.variants, prospect.id);
    effectiveStep = { ...step, subject: picked.value.subject, body: picked.value.body };
    abLabel = `ab:v${picked.index}`;
  }
  const personalized = await personalizeOutreach(deps, { merchant, prospect, step: effectiveStep, tokens });
  // Same-thread follow-up: when the prior step's Message-Id is known, land in the same
  // conversation ("Re: <original subject>"); send() threads via In-Reply-To/References.
  const priorThreaded = sentMsgs.find((m) => !!m.providerMessageId);
  const subject = priorThreaded ? `Re: ${priorThreaded.subject.replace(/^(re|fwd):\s*/i, "")}` : personalized.subject;
  return { subject, body: personalized.body, variant: personalized.mode === "llm" ? "llm" : abLabel ?? depth };
}

/**
 * Advance mid-cadence prospects whose delay has elapsed. Email steps send as the merchant;
 * `channel:"dm"` steps auto-create a fully-prepared DM task (draft + best handle + deep link)
 * for the operator to send by hand — NEVER auto-DM (ToS). The cadence pointer advances across
 * BOTH channels, so an email→DM→email sequence flows; a DM step with no DM-able handle records
 * a "skipped" task so the prospect doesn't get stuck on it.
 *
 * SAFETY (AUDIT-2026-10 O5): automated EMAIL follow-ups are held while the campaign's mailbox
 * has no working inbound path. Every footer says "reply STOP"; a mailbox whose replies we
 * cannot read (Gmail OAuth today, SMTP without IMAP, a failing poll) would keep emailing people
 * who already answered or opted out. `blockedReason` reports the hold. (DM steps still prepare
 * their task: a person sends those, and a person can see the inbox.)
 */
export async function advanceSequences(
  deps: RecruitmentDeps,
  merchantId: string,
  campaign: OutreachCampaign,
  now: Date,
): Promise<{ emailsSent: number; dmTasksCreated: number; deferredLocalTime: number; blockedReason?: string }> {
  return withMerchantLock(deps, merchantId, () => advanceSequencesLocked(deps, merchantId, campaign, now));
}

async function advanceSequencesLocked(
  deps: RecruitmentDeps,
  merchantId: string,
  campaign: OutreachCampaign,
  now: Date,
): Promise<{ emailsSent: number; dmTasksCreated: number; deferredLocalTime: number; blockedReason?: string }> {
  if (!isWithinSendWindow(campaign, now)) return { emailsSent: 0, dmTasksCreated: 0, deferredLocalTime: 0 };
  const merchant = await deps.db.merchants.require(merchantId);
  const mailbox = campaign.mailboxId ? await deps.db.mailboxes.get(campaign.mailboxId) : null;
  const inbound = inboundState(mailbox);
  // What holds EMAIL follow-ups back as a whole (not any one message): compliance, or a
  // mailbox whose replies we cannot read.
  const emailHold = outreachBlockedReason(merchant) ?? (inbound.working ? null : `email follow-ups are on hold — ${inbound.reason}`);
  const firstNo = firstStep(campaign)?.step ?? 1;
  const hasEmailFollowUps = campaign.sequence.some((s) => s.step > firstNo && (s.channel ?? "email") === "email");

  const active = await deps.db.prospects.find(
    (p) => p.merchantId === merchantId && (p.state === "contacted" || p.state === "in_sequence") && !!p.email,
  );
  let emailsSent = 0;
  let dmTasksCreated = 0;
  let deferredLocalTime = 0;
  const deferForLocalTime = localTimeDeferral(now, (at) => isWithinSendWindow(campaign, at));
  for (const p of active) {
    // Out-of-office snooze: never follow up while they're away.
    if (p.snoozedUntil && new Date(p.snoozedUntil).getTime() > now.getTime()) continue;
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
    if (emailHold) continue;
    // (Capacity covers the window, the daily cap, a paused mailbox and failure backoff.)
    if (!(await capacityAvailable(deps, merchantId, campaign, now))) break;
    if (deferForLocalTime(p.country)) {
      deferredLocalTime += 1;
      continue;
    }
    const fingerprint = stepFingerprint(next);
    // Retry-not-duplicate: if a message already exists at this step, re-send THAT row instead
    // of inserting a new one every cycle.
    const existing = (await deps.db.outreachMessages.find((m) => m.prospectId === p.id && m.campaignId === campaign.id && m.step === next.step))[0];
    if (existing) {
      if (existing.status !== "queued" && existing.status !== "failed") continue;
      if (existing.status === "failed") {
        const copyChanged = existing.stepFingerprint !== fingerprint;
        const gateBlocked = (existing.blockedReason ?? "").startsWith("content gate");
        // A content-gate block holds only while the step copy is unchanged (the failed message
        // + blockedReason are the operator's fix-it surface); fix the copy and it is released.
        if (gateBlocked && !copyChanged) continue;
        if (!gateBlocked && !copyChanged && retryNotDue(existing, now)) continue;
        if (copyChanged) {
          const fresh = await renderFollowUp(deps, merchant, p, next, sentMsgs);
          await deps.db.outreachMessages.update(existing.id, { ...fresh, stepFingerprint: fingerprint, attempts: 0, nextAttemptAt: null });
        }
      }
      const retried = await send(deps, existing.id);
      if (retried.status === "sent") emailsSent += 1;
      continue;
    }

    const rendered = await renderFollowUp(deps, merchant, p, next, sentMsgs);
    const message = await deps.db.outreachMessages.insert({
      id: newId("omsg"),
      prospectId: p.id,
      campaignId: campaign.id,
      step: next.step,
      variant: rendered.variant,
      subject: rendered.subject,
      body: rendered.body,
      sentAt: null,
      status: "queued",
      stepFingerprint: fingerprint,
      attempts: 0,
    });
    // (LLM personalization is metered when the message is actually sent — see send().)
    const result = await send(deps, message.id);
    if (result.status === "sent") emailsSent += 1;
  }
  return { emailsSent, dmTasksCreated, deferredLocalTime, ...(emailHold && hasEmailFollowUps ? { blockedReason: emailHold } : {}) };
}

async function activeCampaign(deps: RecruitmentDeps, merchantId: string): Promise<OutreachCampaign | null> {
  return deps.db.campaigns.findOne((c) => c.merchantId === merchantId && c.status === "active");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type { Prospect };
