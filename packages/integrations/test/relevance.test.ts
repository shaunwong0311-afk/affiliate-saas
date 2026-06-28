import { describe, it, expect } from "vitest";
import { EmbeddingRelevanceScorer, LlmRelevanceScorer, HashingEmbedder } from "../src/index.js";
import type { LlmClient } from "../src/index.js";

describe("EmbeddingRelevanceScorer", () => {
  it("scores shared-token overlap via the embedder (0..1)", async () => {
    const s = new EmbeddingRelevanceScorer(new HashingEmbedder());
    const hi = await s.score({ prospect: "best skincare serum review", merchant: "skincare serum brand" });
    const lo = await s.score({ prospect: "diesel truck parts", merchant: "skincare serum brand" });
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});

function fakeLlm(reply: string): LlmClient & { calls: () => number } {
  let calls = 0;
  return {
    model: "fake",
    calls: () => calls,
    async complete() {
      calls++;
      return reply;
    },
  };
}

describe("LlmRelevanceScorer", () => {
  it("parses a 0..1 number from the model", async () => {
    expect(await new LlmRelevanceScorer(fakeLlm("0.87")).score({ prospect: "p", merchant: "m" })).toBeCloseTo(0.87);
  });
  it("tolerates a 0-100 style answer and clamps", async () => {
    expect(await new LlmRelevanceScorer(fakeLlm("Score: 92")).score({ prospect: "p", merchant: "m" })).toBeCloseTo(0.92);
    expect(await new LlmRelevanceScorer(fakeLlm("1.5")).score({ prospect: "p", merchant: "m" })).toBe(1);
  });
  it("returns 0 (no invented credit) when the model returns nothing parseable", async () => {
    expect(await new LlmRelevanceScorer(fakeLlm("no idea")).score({ prospect: "p", merchant: "m" })).toBe(0);
  });
  it("caches per (prospect, merchant) so it doesn't re-pay", async () => {
    const llm = fakeLlm("0.5");
    const s = new LlmRelevanceScorer(llm);
    await s.score({ prospect: "p", merchant: "m" });
    await s.score({ prospect: "p", merchant: "m" });
    expect(llm.calls()).toBe(1);
  });
});
