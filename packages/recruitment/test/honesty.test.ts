import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  MockMailboxSender,
  type DiscoverySource,
  type DiscoveryQuery,
  type RawCandidate,
  type RedirectResolver,
  type EmailVerifier,
} from "@affiliate/integrations";
import { systemClock } from "@affiliate/core";
import { runSourcing, type RecruitmentDeps } from "../src/index.js";

/**
 * End-to-end honesty checks for the discovery pipeline: the synthetic flag is
 * carried through, provider-backed signals stay UNKNOWN (null) until a provider is
 * wired, third-party redirects are not assumed to land on a competitor, and contact
 * emails come from the page (verified) rather than being guessed.
 */

class StaticSource implements DiscoverySource {
  readonly sourceType = "serp_mining";
  constructor(private readonly cands: RawCandidate[]) {}
  async discover(_q: DiscoveryQuery): Promise<RawCandidate[]> {
    void _q;
    return this.cands;
  }
}

const cand = (over: Partial<RawCandidate>): RawCandidate => ({
  identity: "Prospect",
  siteUrl: "https://prospect.com",
  channelUrl: null,
  sourceType: "serp_mining",
  evidenceUrl: "https://prospect.com/best",
  evidenceSummary: "review",
  outboundLinks: [],
  synthetic: false,
  ...over,
});

let db: Database;
beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({
    id: "m1",
    name: "PeakGear",
    status: "active",
    niche: "trail running",
    competitors: ["competitor.com"],
    billingStatus: "active",
    defaultCurrency: "USD",
    postbackSecret: "s",
    physicalAddress: null,
    createdAt: new Date().toISOString(),
  });
});

function deps(sources: DiscoverySource[], extra: Partial<RecruitmentDeps> = {}): RecruitmentDeps {
  return {
    db,
    embedder: new HashingEmbedder(),
    llm: new DeterministicLlm(),
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: sources,
    clock: systemClock,
    ...extra,
  };
}

describe("discovery honesty (pipeline)", () => {
  it("carries the synthetic flag and counts real vs synthetic separately", async () => {
    const real = cand({ identity: "Real Blog", siteUrl: "https://realblog.com", outboundLinks: ["https://amzn.to/3x?tag=real-20"], synthetic: false });
    const demo = cand({ identity: "Demo Creator", siteUrl: "https://demo.com", sourceType: "creator_discovery", synthetic: true });
    const summary = await runSourcing(deps([new StaticSource([real, demo])]), "m1", { limit: 10 });

    expect(summary.real).toBe(1);
    expect(summary.synthetic).toBe(1);

    const prospects = await db.prospects.find((p) => p.merchantId === "m1");
    const realP = prospects.find((p) => p.identity === "Real Blog")!;
    expect(realP.synthetic).toBe(false);
    expect(realP.evidence?.affiliateLinks?.length).toBeGreaterThan(0); // proven Amazon link
  });

  it("keeps provider-backed signals UNKNOWN (null) at discovery — never invented", async () => {
    await runSourcing(deps([new StaticSource([cand({})])]), "m1", { limit: 5 });
    const sig = (await db.prospectSignals.all())[0]!;
    expect(sig.da).toBeNull();
    expect(sig.engagement).toBeNull();
    expect(sig.audienceOverlap).toBeNull();
  });

  it("does NOT count a third-party redirect as competitor promotion without a resolver", async () => {
    await runSourcing(deps([new StaticSource([cand({ outboundLinks: ["https://track.io/go?ref=abc"] })])]), "m1", { limit: 5 });
    const sig = (await db.prospectSignals.all())[0]!;
    expect(sig.promotesCompetitor).toBe(false);
  });

  it("DOES count it once a redirect resolver confirms the competitor host", async () => {
    const resolver: RedirectResolver = {
      kind: "mock",
      async resolve() {
        return { finalUrl: "https://competitor.com/p", finalHost: "competitor.com" };
      },
    };
    await runSourcing(deps([new StaticSource([cand({ outboundLinks: ["https://track.io/go?ref=abc"] })])], { redirectResolver: resolver }), "m1", { limit: 5 });
    const sig = (await db.prospectSignals.all())[0]!;
    expect(sig.promotesCompetitor).toBe(true);
    const p = (await db.prospects.find((x) => x.merchantId === "m1"))[0]!;
    expect(p.evidence?.competitorPromoted).toBe("competitor.com");
  });

  it("extracts a REAL contact email from page HTML and verifies it", async () => {
    const verifier: EmailVerifier = { kind: "mock", async verify() { return { deliverable: true, reason: "ok" }; } };
    const html = `<p>reach the editor at <a href="mailto:editor@realblog.com">email</a></p>`;
    await runSourcing(deps([new StaticSource([cand({ identity: "Editor", pageHtml: html })])], { emailVerifier: verifier }), "m1", { limit: 5 });
    const p = (await db.prospects.find((x) => x.merchantId === "m1"))[0]!;
    expect(p.email).toBe("editor@realblog.com");
    expect(p.evidence?.contactSource).toBe("page:mailto");
  });
});
