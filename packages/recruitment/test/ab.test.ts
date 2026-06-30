import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { pickVariant } from "../src/sequencing.js";
import { abResults, type RecruitmentDeps } from "../src/index.js";

describe("pickVariant", () => {
  it("is deterministic per key and splits across variants", () => {
    const v = ["a", "b"];
    const k = "prosp_123";
    expect(pickVariant(v, k).index).toBe(pickVariant(v, k).index); // stable
    const counts = [0, 0];
    for (let i = 0; i < 400; i++) counts[pickVariant(v, `p${i}`).index]!++;
    // Even-ish split (each side gets a healthy share).
    expect(counts[0]).toBeGreaterThan(120);
    expect(counts[1]).toBeGreaterThan(120);
  });
});

describe("abResults", () => {
  let db: Database;
  let deps: RecruitmentDeps;
  beforeEach(() => {
    db = createMemoryDatabase();
    deps = { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: systemClock };
  });

  it("computes reply-rate per A/B variant", async () => {
    const mk = async (variant: string, prospectId: string, replied: boolean) => {
      await db.outreachMessages.insert({ id: newId("omsg"), prospectId, campaignId: "c1", step: 1, variant, subject: "s", body: "b", sentAt: new Date().toISOString(), status: "sent" });
      if (replied) await db.replies.insert({ id: newId("rep"), prospectId, raw: "interested", classification: "interested", handledBy: null, ts: new Date().toISOString() });
    };
    await mk("ab:v0", "p1", true);
    await mk("ab:v0", "p2", false);
    await mk("ab:v1", "p3", true);
    await mk("ab:v1", "p4", true);
    await mk("llm", "p5", true); // non-AB → excluded

    const r = await abResults(deps, "c1");
    expect(r.map((x) => x.variant)).toEqual(["ab:v0", "ab:v1"]); // llm excluded
    expect(r.find((x) => x.variant === "ab:v0")!.replyRate).toBeCloseTo(0.5);
    expect(r.find((x) => x.variant === "ab:v1")!.replyRate).toBeCloseTo(1);
  });
});
