import type { Mailbox } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";

/**
 * Deliverability operations (Section 8.4 / Section 14 #1 risk). The silent failure
 * mode of every cold-outreach system. This is an ongoing ops function, not a setup
 * step: warmup ramps, per-mailbox daily caps, mailbox rotation, and a
 * bounce/complaint circuit breaker that pauses sending before a domain burns.
 */

/** Effective daily cap given warmup state — ramp slowly, never blast a cold mailbox. */
export function effectiveDailyCap(mailbox: Mailbox, ageDays: number): number {
  if (mailbox.warmupStatus === "ready") return mailbox.dailyCap;
  if (mailbox.warmupStatus === "not_started") return 0;
  // Warming: ramp ~5/day toward a safe cold-send cap of ~25.
  const ramp = Math.min(25, 5 + Math.floor(ageDays) * 5);
  return Math.min(mailbox.dailyCap, ramp);
}

/** Advance a warming mailbox toward ready once it has aged past the warmup window. */
export function warmupTransition(current: Mailbox["warmupStatus"], ageDays: number): Mailbox["warmupStatus"] {
  if (current === "not_started") return "warming";
  if (current === "warming" && ageDays >= 21) return "ready"; // ~3 weeks (Section 8.4 research)
  return current;
}

/** How many messages this mailbox sent today (via its campaigns). */
export async function sentTodayForMailbox(deps: RecruitmentDeps, mailboxId: string, now: Date): Promise<number> {
  const campaigns = await deps.db.campaigns.find((c) => c.mailboxId === mailboxId);
  const ids = new Set(campaigns.map((c) => c.id));
  const day = now.toISOString().slice(0, 10);
  const sent = await deps.db.outreachMessages.find(
    (m) => ids.has(m.campaignId) && m.status === "sent" && (m.sentAt ?? "").slice(0, 10) === day,
  );
  return sent.length;
}

/** Pick the least-loaded sendable mailbox under its effective cap (rotation). Excludes
 * disconnected AND auto-paused ("error") mailboxes so a burning mailbox drops out of rotation. */
export async function pickSendableMailbox(deps: RecruitmentDeps, merchantId: string, now: Date): Promise<Mailbox | null> {
  const mailboxes = await deps.db.mailboxes.find((m) => m.merchantId === merchantId && (m.status === "connected" || m.status === "warming"));
  let best: { mailbox: Mailbox; remaining: number } | null = null;
  for (const mailbox of mailboxes) {
    const cap = effectiveDailyCap(mailbox, 21); // ageDays unknown here; treat as warmed for capacity
    const sent = await sentTodayForMailbox(deps, mailbox.id, now);
    const remaining = cap - sent;
    if (remaining <= 0) continue;
    if (!best || remaining > best.remaining) best = { mailbox, remaining };
  }
  return best?.mailbox ?? null;
}

export interface DeliverabilityHealth {
  sent: number;
  bounced: number;
  bounceRate: number;
  complaintRate: number;
  /** True when bounce/complaint rates exceed the bulk-sender thresholds → pause. */
  circuitOpen: boolean;
}

/**
 * Circuit breaker on bounce/complaint rate (Google/Yahoo/Microsoft 2025 bulk-sender
 * posture: complaints < 0.3%, bounces < 2%). When open, the autonomous cycle stops
 * sending for the merchant until it recovers.
 */
export async function deliverabilityHealth(deps: RecruitmentDeps, merchantId: string): Promise<DeliverabilityHealth> {
  const campaigns = await deps.db.campaigns.find((c) => c.merchantId === merchantId);
  const ids = new Set(campaigns.map((c) => c.id));
  const messages = await deps.db.outreachMessages.find((m) => ids.has(m.campaignId) && (m.status === "sent" || m.status === "bounced"));
  const sent = messages.length;
  const bounced = messages.filter((m) => m.status === "bounced").length;
  const complaints = (await deps.db.suppressions.find((s) => s.merchantId === merchantId && s.reason === "unsubscribe")).length;
  const bounceRate = sent ? bounced / sent : 0;
  const complaintRate = sent ? complaints / sent : 0;
  const circuitOpen = sent >= 20 && (bounceRate > 0.02 || complaintRate > 0.003);
  return { sent, bounced, bounceRate, complaintRate, circuitOpen };
}

/** Minimum sends before a bounce rate is statistically meaningful enough to auto-pause. */
const MIN_SENDS_FOR_PAUSE = 20;
/** Bounce-rate ceiling (bulk-sender posture) — above this a mailbox is auto-paused. */
const BOUNCE_PAUSE_THRESHOLD = 0.02;

export interface MailboxHealth {
  mailboxId: string;
  email: string;
  status: Mailbox["status"];
  warmupStatus: Mailbox["warmupStatus"];
  /** Today's effective send cap given warmup ramp. */
  effectiveCap: number;
  sentToday: number;
  /** Sends + bounces observed in the health window. */
  sent: number;
  bounced: number;
  bounceRate: number;
  /** True when the mailbox breaches the bounce ceiling with enough volume → pause. */
  circuitOpen: boolean;
  autoPausedReason: string | null;
}

/**
 * Per-mailbox deliverability health (OUTREACH-SPEC §16 #6). Bounces attribute to the
 * mailbox that sent them (message → campaign → mailbox); complaints stay merchant-level
 * (unsubscribes don't carry a mailbox). This is the per-client dashboard row + the input
 * to the auto-pause decision.
 */
export async function mailboxHealth(deps: RecruitmentDeps, mailbox: Mailbox, now: Date, windowDays = 30): Promise<MailboxHealth> {
  const campaigns = await deps.db.campaigns.find((c) => c.mailboxId === mailbox.id);
  const ids = new Set(campaigns.map((c) => c.id));
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const messages = await deps.db.outreachMessages.find(
    (m) => ids.has(m.campaignId) && (m.status === "sent" || m.status === "bounced") && (m.sentAt ?? "") >= since,
  );
  const sent = messages.length;
  const bounced = messages.filter((m) => m.status === "bounced").length;
  const bounceRate = sent ? bounced / sent : 0;
  const ageDays = mailbox.warmupStartedAt ? (now.getTime() - new Date(mailbox.warmupStartedAt).getTime()) / 86_400_000 : 21;
  return {
    mailboxId: mailbox.id,
    email: mailbox.email,
    status: mailbox.status,
    warmupStatus: mailbox.warmupStatus,
    effectiveCap: effectiveDailyCap(mailbox, ageDays),
    sentToday: await sentTodayForMailbox(deps, mailbox.id, now),
    sent,
    bounced,
    bounceRate,
    circuitOpen: sent >= MIN_SENDS_FOR_PAUSE && bounceRate > BOUNCE_PAUSE_THRESHOLD,
    autoPausedReason: mailbox.autoPausedReason ?? null,
  };
}

export interface DeliverabilityMonitorResult {
  mailboxes: MailboxHealth[];
  /** Mailbox ids auto-paused this run (bounce breach). */
  paused: string[];
  /** Mailbox ids that graduated warmup → ready this run. */
  warmed: string[];
}

/**
 * Per-client deliverability monitor (OUTREACH-SPEC §16 #6): run on a schedule (from the
 * autonomous cycle). For each mailbox it (a) advances the warmup schedule (starts the clock
 * for a warming mailbox, graduates warming→ready after ~21 days) and (b) AUTO-PAUSES a mailbox
 * whose bounce rate breaches the ceiling — dropping it out of send rotation before it burns the
 * sending domain. Auto-pause is one-way (status→error); a human resumes after fixing the list.
 */
export async function monitorDeliverability(deps: RecruitmentDeps, merchantId: string, now: Date): Promise<DeliverabilityMonitorResult> {
  const mailboxes = await deps.db.mailboxes.find((m) => m.merchantId === merchantId && m.status !== "disconnected");
  const report: MailboxHealth[] = [];
  const paused: string[] = [];
  const warmed: string[] = [];
  for (const mailbox of mailboxes) {
    let current = mailbox;
    // Warmup-on-a-schedule: start the clock for a warming mailbox, then graduate on time.
    if (current.warmupStatus === "warming") {
      if (!current.warmupStartedAt) {
        current = await deps.db.mailboxes.update(current.id, { warmupStartedAt: now.toISOString() });
      } else {
        const ageDays = (now.getTime() - new Date(current.warmupStartedAt).getTime()) / 86_400_000;
        const next = warmupTransition("warming", ageDays);
        if (next !== current.warmupStatus) {
          current = await deps.db.mailboxes.update(current.id, { warmupStatus: next });
          warmed.push(current.id);
        }
      }
    }

    const health = await mailboxHealth(deps, current, now);
    // Auto-pause on a bounce breach (only from a live state — don't thrash an already-paused box).
    if (health.circuitOpen && current.status !== "error") {
      const reason = `auto-paused ${now.toISOString().slice(0, 10)}: bounce ${(health.bounceRate * 100).toFixed(1)}% over ${health.sent} sends`;
      await deps.db.mailboxes.update(current.id, { status: "error", autoPausedReason: reason });
      paused.push(current.id);
      health.status = "error";
      health.autoPausedReason = reason;
    }
    report.push(health);
  }
  return { mailboxes: report, paused, warmed };
}
