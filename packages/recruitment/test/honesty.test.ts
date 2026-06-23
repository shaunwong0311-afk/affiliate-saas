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
  type HttpFetcher,
  type FetchResult,
  type AccountEnricher,
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

  it("follows a linked Linktree page to find an email the homepage didn't expose", async () => {
    // Homepage has NO email but links a Linktree; the fetcher returns a Linktree
    // page carrying the contact email → enrichment should find + verify it.
    const homepage = `<html><body><a href="https://linktr.ee/creator">my links</a></body></html>`;
    const fetcher: HttpFetcher = {
      kind: "mock",
      async get(url: string): Promise<FetchResult> {
        const html = url.includes("linktr.ee")
          ? `<a href="mailto:business@creator.com">contact</a>`.padEnd(260, " ")
          : "<html></html>";
        return { status: 200, url, html };
      },
    };
    const verifier: EmailVerifier = { kind: "mock", async verify() { return { deliverable: true, reason: "ok" }; } };
    await runSourcing(
      deps([new StaticSource([cand({ identity: "BioCreator", siteUrl: "https://creator.com", pageHtml: homepage })])], { fetcher, emailVerifier: verifier }),
      "m1",
      { limit: 5 },
    );
    const p = (await db.prospects.find((x) => x.merchantId === "m1"))[0]!;
    expect(p.evidence?.contactUrls?.some((u) => u.kind === "bio_aggregator")).toBe(true);
    expect(p.email).toBe("business@creator.com");
    expect(p.evidence?.contactSource).toBe("bio_aggregator:mailto");
  });

  it("builds a cross-platform identity graph from a linked Linktree", async () => {
    const homepage = `<html><body><a href="https://linktr.ee/creator">all my links</a></body></html>`;
    const linktree = `<a href="https://youtube.com/@creator">yt</a><a href="https://x.com/creator">x</a><a href="https://creator.substack.com">news</a>`.padEnd(
      300,
      " ",
    );
    const fetcher: HttpFetcher = {
      kind: "mock",
      async get(url: string): Promise<FetchResult> {
        return { status: 200, url, html: url.includes("linktr.ee") ? linktree : "<html></html>" };
      },
    };
    await runSourcing(
      deps([new StaticSource([cand({ identity: "GraphCreator", siteUrl: "https://creator.com", pageHtml: homepage })])], { fetcher }),
      "m1",
      { limit: 5 },
    );
    const p = (await db.prospects.find((x) => x.merchantId === "m1"))[0]!;
    const profile = p.evidence?.profile;
    expect(profile).toBeTruthy();
    const platforms = profile!.accounts.map((a) => a.platform);
    expect(platforms).toEqual(expect.arrayContaining(["website", "youtube", "twitter", "substack"]));
    // Accounts enumerated on the creator's own Linktree are high-confidence.
    expect(profile!.accounts.find((a) => a.platform === "youtube")!.provenance).toBe("bio_aggregator");
    expect(profile!.identityConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("fills REAL reach + engagement from the enricher (was null without a provider)", async () => {
    const enricher: AccountEnricher = {
      kind: "mock",
      supports: (p) => p === "youtube",
      async enrich() {
        return { reach: 200000, engagementRate: 0.05, primaryGeo: "US", language: "en", source: "api" };
      },
    };
    await runSourcing(
      deps([new StaticSource([cand({ identity: "YTCreator", siteUrl: null, channelUrl: "https://youtube.com/@creator" })])], { enricher }),
      "m1",
      { limit: 5 },
    );
    const sig = (await db.prospectSignals.all())[0]!;
    expect(sig.reach).toBe(200000);
    expect(sig.engagement).toBe(0.05);
    const p = (await db.prospects.find((x) => x.merchantId === "m1"))[0]!;
    expect(p.evidence?.profile?.audience.reach).toBe(200000);
    expect(p.evidence?.profile?.audience.source).toBe("api");
  });

  it("leaves reach + engagement null when no enricher is wired (never invented)", async () => {
    await runSourcing(deps([new StaticSource([cand({ identity: "NoProv2", channelUrl: "https://youtube.com/@x" })])]), "m1", { limit: 5 });
    const sig = (await db.prospectSignals.all())[0]!;
    expect(sig.reach).toBeNull();
    expect(sig.engagement).toBeNull();
  });

  it("flags a contact-form-only prospect for the human gate (no email invented)", async () => {
    // No email on page, no finder hits → the prospect must be flagged form-only, not
    // assigned a fabricated address.
    const emptyFinder = { name: "none", async find() { return []; }, async verify() { return { deliverable: false, reason: "n/a" }; } };
    const formPage = `<html><body><form class="contact-form"><input type="email"/><textarea name="message"></textarea></form></body></html>`;
    await runSourcing(
      deps([new StaticSource([cand({ identity: "FormOnly", evidenceUrl: "https://formonly.com/contact", pageHtml: formPage })])], { emailFinder: emptyFinder }),
      "m1",
      { limit: 5 },
    );
    const p = (await db.prospects.find((x) => x.merchantId === "m1"))[0]!;
    expect(p.evidence?.contactForm).toBe(true);
    expect(p.evidence?.contactFormUrl).toBe("https://formonly.com/contact");
    expect(p.email).toBeNull(); // never fabricated
  });
});
