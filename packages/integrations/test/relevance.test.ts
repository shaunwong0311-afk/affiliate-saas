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
  it("returns null — UNKNOWN, not zero — when the model returns nothing parseable (D8)", async () => {
    // It used to return 0, which scoring read as "this creator is irrelevant" (−20 points)
    // when the truth was "we did not get an answer".
    expect(await new LlmRelevanceScorer(fakeLlm("no idea")).score({ prospect: "p", merchant: "m" })).toBeNull();
  });
  it("still returns a real 0 when the model actually SAYS zero", async () => {
    expect(await new LlmRelevanceScorer(fakeLlm("0.00")).score({ prospect: "p", merchant: "m" })).toBe(0);
  });
  it("caches per (prospect, merchant) so it doesn't re-pay", async () => {
    const llm = fakeLlm("0.5");
    const s = new LlmRelevanceScorer(llm);
    await s.score({ prospect: "p", merchant: "m" });
    await s.score({ prospect: "p", merchant: "m" });
    expect(llm.calls()).toBe(1);
  });

  it("keys the cache on the PAIR — two pairs whose texts merely concatenate the same never share an entry", async () => {
    let n = 0;
    const llm: LlmClient = { model: "counting", async complete() { return ++n === 1 ? "0.9" : "0.1"; } };
    const s = new LlmRelevanceScorer(llm);
    expect(await s.score({ merchant: "skincare brand", prospect: "review site" })).toBeCloseTo(0.9);
    // Same words, split differently between merchant and prospect: a different question.
    expect(await s.score({ merchant: "skincare", prospect: "brand review site" })).toBeCloseTo(0.1);
    expect(n).toBe(2);
  });

  it("does NOT cache a transport failure — the next call re-attempts (and can succeed)", async () => {
    let calls = 0;
    const llm: LlmClient = {
      model: "flaky",
      async complete() {
        calls++;
        if (calls === 1) throw new Error("upstream 503");
        return "0.7";
      },
    };
    const s = new LlmRelevanceScorer(llm);
    expect(await s.score({ prospect: "p", merchant: "m" })).toBeNull(); // outage → unknown (not 0), uncached
    expect(await s.score({ prospect: "p", merchant: "m" })).toBeCloseTo(0.7); // retried → real score
    expect(calls).toBe(2);
  });
});
