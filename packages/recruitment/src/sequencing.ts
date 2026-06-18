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

export function nextStep(campaign: OutreachCampaign, currentStep: number): SequenceStep | null {
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
