import type { OutreachCampaign, SequenceStep } from "@affiliate/db";

/**
 * Cadence + deliverability scheduling (Section 8.4). Multi-step sequences with
 * hard stops on reply/conversion, respecting send windows and per-mailbox daily
 * caps. Pure helpers so the scheduling logic is unit-testable.
 */

export function isWithinSendWindow(campaign: OutreachCampaign, at: Date): boolean {
  const { startHour, endHour } = campaign.sendWindow;
  const hour = at.getUTCHours();
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // window wraps midnight
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
