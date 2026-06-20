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

/** Pick the least-loaded sendable mailbox under its effective cap (rotation). */
export async function pickSendableMailbox(deps: RecruitmentDeps, merchantId: string, now: Date): Promise<Mailbox | null> {
  const mailboxes = await deps.db.mailboxes.find((m) => m.merchantId === merchantId && m.status !== "disconnected");
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
