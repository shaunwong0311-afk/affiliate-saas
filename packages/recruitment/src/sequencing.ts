import { createHash } from "node:crypto";
import type { OutreachCampaign, SequenceStep } from "@affiliate/db";

/**
 * Cadence + deliverability scheduling (Section 8.4). Multi-step sequences with
 * hard stops on reply/conversion, respecting send windows and per-mailbox daily
 * caps. Pure helpers so the scheduling logic is unit-testable.
 */

/** True when `timeZone` is an IANA zone this runtime knows (validated on campaign create/patch). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock hour (0–23) at `at` in an IANA time zone, DST included. An unknown or empty
 *  zone reads as UTC rather than throwing mid-cycle. */
export function hourInTimeZone(at: Date, timeZone: string | null | undefined): number {
  if (timeZone && timeZone.toUpperCase() !== "UTC") {
    try {
      const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(at).find((p) => p.type === "hour")?.value;
      const h = Number(hour);
      if (Number.isInteger(h)) return h % 24;
    } catch {
      /* unknown zone → UTC */
    }
  }
  return at.getUTCHours();
}

/**
 * Whether `at` falls inside the campaign's send window, measured in the campaign's OWN time
 * zone. (It used to compare against the UTC hour and ignore the stored zone, so a 9–17 Los
 * Angeles window sent at 03:00 local.)
 */
export function isWithinSendWindow(campaign: OutreachCampaign, at: Date): boolean {
  const { startHour, endHour, timezone } = campaign.sendWindow;
  const hour = hourInTimeZone(at, timezone);
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // window wraps midnight
}

/**
 * A fingerprint of the copy a step renders from (subject, body, variants). Stamped on each
 * queued message, so a content-gate block can be told apart from "the operator has since
 * fixed the copy" — the block is held only while the fingerprint is unchanged.
 */
export function stepFingerprint(step: SequenceStep): string {
  return createHash("sha1")
    .update(JSON.stringify([step.subject, step.body, (step.variants ?? []).map((v) => [v.subject, v.body])]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Cadence discipline (research-backed): 1 initial + at most 3 follow-ups, spaced ~5-7
 * days. Reply rate peaks at follow-up #2 and craters by #4 — past ~3 follow-ups you burn
 * sender reputation faster than you generate replies (Pitchbox data). So we hard-cap.
 */
export const MAX_FOLLOWUPS = 3;
export const RECOMMENDED_FOLLOWUP_DELAY_DAYS = [3, 5, 7];

/** True once the cadence cap is reached — stop sending further follow-ups. */
export function followupCapReached(currentStep: number): boolean {
  return currentStep >= MAX_FOLLOWUPS + 1; // initial (step 1) + 3 follow-ups
}

/** Build a disciplined default sequence from per-step templates (capped + spaced). */
export function recommendedSequence(steps: Array<{ subject: string; body: string }>): SequenceStep[] {
  return steps.slice(0, MAX_FOLLOWUPS + 1).map(
    (s, i) =>
      ({ step: i + 1, subject: s.subject, body: s.body, delayDays: i === 0 ? 0 : RECOMMENDED_FOLLOWUP_DELAY_DAYS[i - 1] ?? 7 }) as SequenceStep,
  );
}

export function nextStep(campaign: OutreachCampaign, currentStep: number): SequenceStep | null {
  if (followupCapReached(currentStep)) return null; // cadence discipline — never over-send
  return campaign.sequence.find((s) => s.step === currentStep + 1) ?? null;
}

export function firstStep(campaign: OutreachCampaign): SequenceStep | null {
  return [...campaign.sequence].sort((a, b) => a.step - b.step)[0] ?? null;
}

/** Deterministic even A/B split: pick a variant by hashing a stable key (the prospect id). */
export function pickVariant<T>(variants: T[], key: string): { index: number; value: T } {
  if (variants.length === 1) return { index: 0, value: variants[0]! };
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const index = h % variants.length;
  return { index, value: variants[index]! };
}

/** Delay in ms before a follow-up step should send. */
export function delayForStep(step: SequenceStep): number {
  return step.delayDays * 86_400_000;
}

/** Tier-aware personalization depth (Section 8.4). */
export function personalizationDepth(tier: "A" | "B" | "C" | null): "deep" | "medium" | "light" {
  if (tier === "A") return "deep";
  if (tier === "B") return "medium";
  return "light";
}

export interface DailyCapState {
  sentToday: number;
  cap: number;
}

export function capRemaining(state: DailyCapState): number {
  return Math.max(0, state.cap - state.sentToday);
}
