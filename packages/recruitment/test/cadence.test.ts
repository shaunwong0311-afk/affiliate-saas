import { describe, it, expect } from "vitest";
import { followupCapReached, recommendedSequence, nextStep, MAX_FOLLOWUPS } from "../src/sequencing.js";
import type { OutreachCampaign } from "@affiliate/db";

describe("cadence discipline", () => {
  it("caps at 1 initial + 3 follow-ups", () => {
    expect(followupCapReached(1)).toBe(false); // after initial → follow-up 1 allowed
    expect(followupCapReached(3)).toBe(false); // follow-up 2 → follow-up 3 allowed
    expect(followupCapReached(4)).toBe(true); // after follow-up 3 → stop
  });

  it("recommendedSequence spaces follow-ups and respects the cap", () => {
    const seq = recommendedSequence(Array.from({ length: 8 }, (_, i) => ({ subject: `s${i}`, body: `b${i}` })));
    expect(seq).toHaveLength(MAX_FOLLOWUPS + 1); // never more than 4 touches
    expect(seq[0]!.delayDays).toBe(0); // initial sends immediately
    expect(seq[1]!.delayDays).toBeGreaterThan(0); // follow-ups are spaced
  });

  it("nextStep stops once the cap is reached even if more steps exist", () => {
    const campaign = { sequence: recommendedSequence(Array.from({ length: 6 }, (_, i) => ({ subject: `s${i}`, body: `b${i}` }))) } as OutreachCampaign;
    expect(nextStep(campaign, 4)).toBeNull(); // would be a 4th follow-up → blocked
    expect(nextStep(campaign, 1)).not.toBeNull(); // follow-up 1 is fine
  });
});
