import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { systemClock } from "@affiliate/core";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  MockMailboxSender,
  ProviderError,
  type DiscoveryHooks,
  type DiscoveryQuery,
  type DiscoverySource,
  type RawCandidate,
  type RedirectResolver,
  type RelevanceScorer,
} from "@affiliate/integrations";
import {
  runSourcing,
  processBacklog,
  discover,
  score,
  ingestCandidate,
  importProspects,
  importAffiliateRoster,
  isExistingAffiliate,
  existingAffiliateIndex,
  ingestExclusionsFor,
  ingestExclusionReason,
  merchantOwnDomains,
  type RecruitmentDeps,
} from "../src/index.js";

/**
 * AUDIT-2026-10 — what may become a prospect at all (D5), which prospects are the same
 * creator (D6, through the pipeline), how many links are followed per page (D9), what a
 * failed source looks like (D13), the roster guard (D15) and unknown relevance (D8).
 */

const cand = (over: Partial<RawCandidate>): RawCandidate => ({
  identity: "Prospect",
  siteUrl: "https://prospect.com",
  channelUrl: null,
  sourceType: "serp_mining",
  evidenceUrl: null,
  evidenceSummary: "skincare review",
  outboundLinks: [],
  synthetic: false,
  ...over,
});
const page = (body: string) => `<html><body>${"text ".repeat(60)}${body}</body></html>`;

let db: Database;
let deps: RecruitmentDeps;
beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({
    id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: ["glowrival.com", "https://www.DewDrop.com/"], billingStatus: "active",
    defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString(),
  });
  await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
  deps = { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: [], clock: systemClock };
});
const merchant = () => db.merchants.require("m1");
const ingest = async (c: Partial<RawCandidate>) => ingestCandidate(deps, await merchant(), cand(c));
const all = () => db.prospects.find((p) => p.merchantId === "m1");

// ============================================================================
describe("D5 — never a prospect: the competitor, the merchant, a retailer, a bare platform", () => {
  it("excludes a competitor's own domain and its subdomains", async () => {
    // `"<competitor> review"` ranks the competitor first; it became a prospect whose contact was hello@<competitor>.
    expect(await ingest({ identity: "GlowRival", siteUrl: "https://glowrival.com", pageHtml: page(`<a href="mailto:hello@glowrival.com">hi</a>`) })).toBeNull();
    expect(await ingest({ identity: "GlowRival blog", siteUrl: "https://blog.glowrival.com/" })).toBeNull();
    expect(await ingest({ identity: "DewDrop", siteUrl: "http://dewdrop.com" })).toBeNull(); // the ICP entry was a URL with www + mixed case
    expect(await all()).toHaveLength(0);
    // A look-alike domain is NOT the competitor.
    expect(await ingest({ identity: "Fan site", siteUrl: "https://glowrival-fans.com" })).not.toBeNull();
  });

  it("excludes the merchant's own domains, derived from connected mailboxes and sending domains", async () => {
    await db.mailboxes.insert({ id: "mb1", merchantId: "m1", provider: "smtp", email: "dana@lumen-skincare.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });
    await db.mailboxes.insert({ id: "mb2", merchantId: "m1", provider: "gmail", email: "lumen.team@gmail.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });
    await db.mailboxes.insert({ id: "mbX", merchantId: "other-tenant", provider: "smtp", email: "x@someone-else.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });
    await db.sendingDomains.insert({ id: "sd1", merchantId: "m1", domain: "Mail.Lumen-Outreach.com", spfStatus: "verified", dkimStatus: "verified", dmarcStatus: "verified", warmupStatus: "ready" });

    expect((await merchantOwnDomains(deps, "m1")).sort()).toEqual(["lumen-skincare.com", "mail.lumen-outreach.com"]); // not gmail.com, not another tenant's
    expect(await ingest({ identity: "Lumen", siteUrl: "https://www.lumen-skincare.com" })).toBeNull();
    expect(await ingest({ identity: "Lumen shop", siteUrl: "https://shop.lumen-skincare.com" })).toBeNull();
    expect(await ingest({ identity: "Other tenant's site", siteUrl: "https://someone-else.com" })).not.toBeNull();
  });

  it("excludes retailers, search engines, shorteners and bare platform hosts — but not a creator's page ON a platform", async () => {
    for (const siteUrl of ["https://www.amazon.com/dp/B0ABC", "https://www.amazon.co.uk/", "https://www.walmart.com/ip/1", "https://www.google.com/search?q=x", "https://bit.ly/3abc", "https://en.wikipedia.org/wiki/Skin", "https://www.youtube.com", "https://facebook.com/", "https://medium.com"]) {
      expect(await ingest({ identity: siteUrl, siteUrl }), siteUrl).toBeNull();
    }
    expect(await all()).toHaveLength(0);
    // Still prospects: a page on a platform, a channel, a hosted tenant.
    expect(await ingest({ identity: "r/SkincareAddiction", siteUrl: "https://www.reddit.com/r/SkincareAddiction/comments/1/x" })).not.toBeNull();
    expect(await ingest({ identity: "A Medium author", siteUrl: "https://medium.com/@alice/a-post" })).not.toBeNull();
    expect(await ingest({ identity: "A channel", siteUrl: null, channelUrl: "https://www.youtube.com/@creator" })).not.toBeNull();
    expect(await ingest({ identity: "A hosted blog", siteUrl: "https://alice.wordpress.com" })).not.toBeNull();
  });

  it("ingestExclusionReason says why", async () => {
    const ex = await ingestExclusionsFor(deps, await merchant());
    expect(ex.competitorDomains).toEqual(["glowrival.com", "dewdrop.com"]);
    expect(ingestExclusionReason({ siteUrl: "https://shop.glowrival.com", channelUrl: null }, ex)).toMatch(/competitor/);
    expect(ingestExclusionReason({ siteUrl: "https://amazon.de/x", channelUrl: null }, ex)).toMatch(/retailer/);
    expect(ingestExclusionReason({ siteUrl: "https://youtube.com", channelUrl: null }, ex)).toMatch(/platform/);
    expect(ingestExclusionReason({ siteUrl: "https://skinblog.com", channelUrl: null }, ex)).toBeNull();
    // A merchant-supplied (trusted) row may list a storefront; the competitor rule still holds.
    expect(ingestExclusionReason({ siteUrl: "https://www.amazon.com/shop/creator", channelUrl: null }, ex, { trusted: true })).toBeNull();
    expect(ingestExclusionReason({ siteUrl: "https://glowrival.com", channelUrl: null }, ex, { trusted: true })).toMatch(/competitor/);
  });

  it("re-checks before enrichment: a prospect that turns out to be the merchant (mailbox connected later) is retired", async () => {
    // Usual onboarding order: source first, connect a mailbox afterwards. At ingest the
    // merchant's own domain was not yet known, so its own site got in.
    const own = await ingest({ identity: "Lumen Skincare", siteUrl: "https://lumen-skincare.com" });
    const other = await ingest({ identity: "Skin Blog", siteUrl: "https://skinblog.com" });
    expect(own).not.toBeNull();
    await db.mailboxes.insert({ id: "mb1", merchantId: "m1", provider: "smtp", email: "dana@lumen-skincare.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });

    expect(await processBacklog(deps, "m1")).toEqual({ enriched: 1, scored: 1 });
    const after = await db.prospects.require(own!.id);
    expect(after.state).toBe("dead");
    expect(after.evidence?.excludedReason).toMatch(/merchant's own domain/);
    expect(after.email).toBeNull();
    expect((await db.prospects.require(other!.id)).state).toBe("scored");
  });

  it("applies in the discovery loop: excluded candidates are not counted as sourced", async () => {
    const source: DiscoverySource = {
      sourceType: "serp_mining",
      async discover() {
        return [cand({ identity: "GlowRival", siteUrl: "https://glowrival.com" }), cand({ identity: "Amazon", siteUrl: "https://www.amazon.com/x" }), cand({ identity: "Skin Blog", siteUrl: "https://skinblog.com" })];
      },
    };
    const summary = await runSourcing({ ...deps, discoverySources: [source] }, "m1", { limit: 10 });
    expect(summary.discovered).toBe(1);
    expect((await all()).map((p) => p.identity)).toEqual(["Skin Blog"]);
  });
});

// ============================================================================
describe("D6 — distinct creators stay distinct through ingest", () => {
  it("two unrelated blogs that print the same ad network's address are two prospects", async () => {
    const footer = `<footer>Advertise with us: <a href="mailto:sales@bigadnetwork.com">ad network</a></footer>`;
    const a = await ingest({ identity: "Blog One", siteUrl: "https://blog-one.com", pageHtml: page(footer) });
    const b = await ingest({ identity: "Blog Two", siteUrl: "https://blog-two.com", pageHtml: page(`${footer}<a href="mailto:jane@blog-two.com">Jane</a>`) });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // was null — silently folded into Blog One
    const rows = await all();
    expect(rows.map((p) => p.identity).sort()).toEqual(["Blog One", "Blog Two"]);
    expect(rows.find((p) => p.identity === "Blog One")!.evidence?.contactEmails).toEqual([]); // and Jane's address did not leak onto Blog One
  });

  it("two YouTube video results are two prospects (the host is not an identity)", async () => {
    const a = await ingest({ identity: "Creator C", siteUrl: null, channelUrl: "https://www.youtube.com/watch?v=abc123" });
    const b = await ingest({ identity: "Creator D", siteUrl: null, channelUrl: "https://www.youtube.com/watch?v=def456" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // was null — both were "the website youtube.com"
  });

  it("two Instagram post results, and a blog that embeds a post, are three prospects", async () => {
    expect(await ingest({ identity: "Post A", siteUrl: null, channelUrl: "https://www.instagram.com/p/Cabc123" })).not.toBeNull();
    expect(await ingest({ identity: "Post B", siteUrl: null, channelUrl: "https://www.instagram.com/p/Cxyz789" })).not.toBeNull(); // was merged on the handle "@p"
    expect(await ingest({ identity: "Blog", siteUrl: "https://embedblog.com", pageHtml: page(`<a href="https://www.instagram.com/p/Cqqq000/">a post</a>`) })).not.toBeNull();
    expect(await all()).toHaveLength(3);
  });

  it("two authors on medium.com are two prospects", async () => {
    expect(await ingest({ identity: "Alice", siteUrl: "https://medium.com/@alice/post-1" })).not.toBeNull();
    expect(await ingest({ identity: "Bob", siteUrl: "https://medium.com/@bob/post-2" })).not.toBeNull();
  });

  it("STILL merges two real surfaces of one creator (channel, then the site that links it)", async () => {
    expect(await ingest({ identity: "Trail Geek", siteUrl: null, channelUrl: "https://youtube.com/@trailgeek" })).not.toBeNull();
    expect(await ingest({ identity: "trailgeek.com", siteUrl: "https://trailgeek.com", pageHtml: page(`<a href="https://www.youtube.com/@trailgeek/videos">My YouTube</a>`) })).toBeNull();
    const [only] = await all();
    expect(only).toMatchObject({ channelUrl: "https://youtube.com/@trailgeek", siteUrl: "https://trailgeek.com" });
  });

  it("STILL merges on an own-domain address shared by two hosts of one business", async () => {
    expect(await ingest({ identity: "Studio", siteUrl: "https://studio.com", pageHtml: page(`<a href="mailto:hi@studio.com">hi</a>`) })).not.toBeNull();
    expect(await ingest({ identity: "Studio blog", siteUrl: "https://blog.studio.com", pageHtml: page(`contact: hi@studio.com`) })).toBeNull();
    expect(await all()).toHaveLength(1);
  });
});

// ============================================================================
describe("D9 — a bounded number of links is followed per candidate", () => {
  function recordingResolver(finalHost = "elsewhere.com"): RedirectResolver & { urls: string[] } {
    const urls: string[] = [];
    return { kind: "mock", urls, async resolve(url: string) { urls.push(url); return { finalUrl: `https://${finalHost}/landing`, finalHost }; } };
  }

  it("follows at most 5 low-confidence links, however many the page carries", async () => {
    const resolver = recordingResolver();
    const links = Array.from({ length: 200 }, (_, i) => `https://tracker${i}.io/go/deal?ref=abc`);
    await ingestCandidate({ ...deps, redirectResolver: resolver }, await merchant(), cand({ siteUrl: "https://linkfarm.com", outboundLinks: links }));
    expect(resolver.urls).toHaveLength(5); // was 400: every link, once per matching pattern
    expect(new Set(resolver.urls).size).toBe(5);
  });

  it("resolves each distinct URL once, and skips links that need no resolving", async () => {
    const resolver = recordingResolver();
    await ingestCandidate(
      { ...deps, redirectResolver: resolver },
      await merchant(),
      cand({
        siteUrl: "https://picky.com",
        outboundLinks: [
          "https://track.io/go/x?ref=1", // generic param AND generic path → two signals, ONE request
          "https://track.io/go/x?ref=1",
          "/go/relative", // not an absolute URL — nothing to request
          "https://www.amazon.com/dp/B0?ref=sr_1_1", // a retailer is its own destination
          "https://twitter.com/intent/tweet?via=me", // so is a social network
          "https://glowrival.com/buy?ref=x", // already points AT the competitor
          "https://amzn.to/3abc", // high-confidence: never resolved
          "https://bit.ly/3xyz?ref=q", // a shortener IS worth following
        ],
      }),
    );
    expect(resolver.urls).toEqual(["https://track.io/go/x?ref=1", "https://bit.ly/3xyz?ref=q"]);
  });

  it("spends the budget on cloaked links, not on the candidate's own navigation", async () => {
    const resolver = recordingResolver();
    await ingestCandidate(
      { ...deps, redirectResolver: resolver },
      await merchant(),
      cand({
        siteUrl: "https://myblog.com",
        outboundLinks: [
          "https://myblog.com/category/serums?ref=nav", // own site + a bare ?ref= → navigation
          "https://www.myblog.com/tag/spf?ref=sidebar",
          "https://myblog.com/go/glowrival", // own site + /go/ → what a cloaked affiliate link looks like
          "https://myblog.com/recommends/serum?ref=post", // matches a path pattern too → followed (once)
        ],
      }),
    );
    expect(resolver.urls).toEqual(["https://myblog.com/go/glowrival", "https://myblog.com/recommends/serum?ref=post"]);
  });

  it("a followed link still counts as competitor evidence, an unfollowed one never does", async () => {
    const toCompetitor = recordingResolver("glowrival.com");
    const many = Array.from({ length: 20 }, (_, i) => `https://t${i}.io/x?ref=a`);
    const p = await ingestCandidate({ ...deps, redirectResolver: toCompetitor }, await merchant(), cand({ siteUrl: "https://aff.com", outboundLinks: many }));
    const sig = (await db.prospectSignals.findOne((s) => s.prospectId === p!.id))!;
    expect(sig.promotesCompetitor).toBe(true);
    expect(p!.evidence?.competitorPromoted).toBe("glowrival.com");
    const links = p!.evidence!.affiliateLinks!;
    expect(links.filter((l) => l.verified)).toHaveLength(5);
    expect(links.filter((l) => !l.verified)).toHaveLength(15); // left unverified, not assumed
  });
});

// ============================================================================
describe("D13 — a failed source is reported, not mistaken for an empty one", () => {
  const working: DiscoverySource = { sourceType: "serp_mining", async discover() { return [cand({ identity: "Skin Blog", siteUrl: "https://skinblog.com" })]; } };
  const refused: DiscoverySource = { sourceType: "backlink_mining", async discover() { throw new ProviderError("dataforseo-backlinks", 0, "Access denied. Visit Plans and Subscriptions to activate your subscription", "quota"); } };
  const partial: DiscoverySource = {
    sourceType: "youtube_discovery",
    async discover(_q: DiscoveryQuery, hooks?: DiscoveryHooks) {
      hooks?.onError?.({ sourceType: "youtube_discovery", message: 'search "best skincare": youtube: quota [quotaExceeded] (HTTP 403)' });
      return [cand({ identity: "A Channel", siteUrl: null, channelUrl: "https://www.youtube.com/channel/UCabc" })];
    },
  };

  it("runSourcing lists the sources that failed, with the provider's reason, and still runs the others", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => void warnings.push(m);
    try {
      const summary = await runSourcing({ ...deps, discoverySources: [refused, working, partial] }, "m1", { limit: 10 });
      expect(summary.discovered).toBe(2); // the failure did not stop the rest
      expect(summary.sourceErrors).toEqual([
        { sourceType: "backlink_mining", message: expect.stringContaining("activate your subscription") },
        { sourceType: "youtube_discovery", message: expect.stringContaining("quotaExceeded") },
      ]);
      expect(warnings.some((w) => w.includes("backlink_mining") && w.includes("m1"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it("a clean run reports no errors", async () => {
    expect((await runSourcing({ ...deps, discoverySources: [working] }, "m1", { limit: 10 })).sourceErrors).toEqual([]);
  });

  it("discover() hands failures to the caller's hook and survives a hook that throws", async () => {
    const seen: string[] = [];
    const created = await discover({ ...deps, discoverySources: [refused, working] }, "m1", {
      onSourceError: (issue) => {
        seen.push(issue.sourceType);
        throw new Error("logging is down");
      },
    });
    expect(seen).toEqual(["backlink_mining"]);
    expect(created).toHaveLength(1);
  });
});

// ============================================================================
describe("D15 — the roster guard is not exact-email only", () => {
  beforeEach(async () => {
    await importAffiliateRoster(deps, "m1", [
      { name: "Star Creator", email: "star@creator.com" },
      { name: "Jane", email: "jane.skin@gmail.com", siteUrl: "https://janeskin.com" },
      { name: "Vlogger", email: "vlog@agency-mail.net", siteUrl: "https://www.youtube.com/@thevlogger" },
    ]);
  });
  const existing = (p: { email?: string | null; siteUrl?: string | null; channelUrl?: string | null }) =>
    isExistingAffiliate(deps, "m1", { id: "px", email: p.email ?? null, siteUrl: p.siteUrl ?? null, channelUrl: p.channelUrl ?? null });

  it("recognizes an affiliate found under a different address on their own site", async () => {
    // On file: star@creator.com. Discovery turns up the site creator.com / hello@creator.com.
    expect(await existing({ email: "hello@creator.com", siteUrl: "https://creator.com" })).toBe(true);
    expect(await existing({ siteUrl: "https://www.creator.com/about" })).toBe(true);
    expect(await existing({ siteUrl: "https://blog.creator.com" })).toBe(true);
    // Jane's roster entry lists her site; her mailbox is a Gmail.
    expect(await existing({ email: "partnerships@janeskin.com" })).toBe(true);
    expect(await existing({ siteUrl: "https://janeskin.com" })).toBe(true);
    // The vlogger's roster entry is a channel.
    expect(await existing({ channelUrl: "https://youtube.com/@TheVlogger/videos" })).toBe(true);
  });

  it("still matches the exact email, and does not match strangers", async () => {
    expect(await existing({ email: "STAR@creator.com" })).toBe(true);
    expect(await existing({ email: "someone@unrelated.io", siteUrl: "https://unrelated.io" })).toBe(false);
    expect(await existing({ channelUrl: "https://youtube.com/@someoneelse" })).toBe(false);
  });

  it("does NOT treat a shared mailbox provider or a shared company domain as the same person", async () => {
    // Another Gmail user is not Jane; another client of the vlogger's agency is not the vlogger.
    expect(await existing({ email: "other.person@gmail.com" })).toBe(false);
    expect(await existing({ email: "different.creator@agency-mail.net" })).toBe(false);
    const index = await existingAffiliateIndex(deps, "m1");
    expect(index.siteDomains.has("gmail.com")).toBe(false);
    expect(index.emailDomains.has("gmail.com")).toBe(false);
  });

  it("guards the sourcing run: an existing affiliate's site is killed before enrichment", async () => {
    const source: DiscoverySource = { sourceType: "backlink_mining", async discover() { return [cand({ identity: "creator.com", siteUrl: "https://creator.com" }), cand({ identity: "new.com", siteUrl: "https://new.com" })]; } };
    const summary = await runSourcing({ ...deps, discoverySources: [source] }, "m1", { limit: 10 });
    expect(summary.guarded).toBe(1);
    const rows = await all();
    expect(rows.find((p) => p.identity === "creator.com")!.state).toBe("dead");
    expect(rows.find((p) => p.identity === "new.com")!.state).toBe("scored");
  });
});

// ============================================================================
describe("D8 — when relevance cannot be judged the score is provisional", () => {
  const down: RelevanceScorer = { kind: "llm", async score() { return null; } };
  const source: DiscoverySource = { sourceType: "serp_mining", async discover() { return [cand({ identity: "Skin Blog", siteUrl: "https://skinblog.com" })]; } };

  it("scores without relevance, reports it unknown, and does NOT release the prospect to outreach", async () => {
    await runSourcing({ ...deps, discoverySources: [source], relevanceScorer: down }, "m1", { limit: 5 });
    const [p] = await all();
    expect(p!.score).not.toBeNull();
    expect((p!.scoreBreakdown as { unknownFactors: string[] }).unknownFactors).toContain("relevance");
    expect((await db.prospectSignals.findOne((s) => s.prospectId === p!.id))!.relevance).toBeNull(); // not a stored 0
    expect(p!.state).toBe("enriched"); // outreach only picks up "scored"
  });

  it("re-scores it on the next run once the scorer answers", async () => {
    let up = false;
    const flaky: RelevanceScorer = { kind: "llm", async score() { return up ? 0.9 : null; } };
    const d = { ...deps, discoverySources: [source], relevanceScorer: flaky };
    await runSourcing(d, "m1", { limit: 5 });
    expect((await all())[0]!.state).toBe("enriched");
    up = true;
    await runSourcing(d, "m1", { limit: 5 }); // nothing new is discovered; the provisional one is retried
    const [p] = await all();
    expect(p!.state).toBe("scored");
    expect((p!.scoreBreakdown as { unknownFactors: string[] }).unknownFactors).not.toContain("relevance");
    expect((await db.prospectSignals.findOne((s) => s.prospectId === p!.id))!.relevance).toBe(0.9);
  });

  it("while the scorer is down, a backlog pass does not ask it again for every waiting prospect", async () => {
    let calls = 0;
    const counting: RelevanceScorer = { kind: "llm", async score() { calls++; return null; } };
    const many: DiscoverySource = { sourceType: "serp_mining", async discover() { return [1, 2, 3, 4, 5].map((i) => cand({ identity: `Blog ${i}`, siteUrl: `https://blog${i}.com` })); } };
    const d = { ...deps, discoverySources: [many], relevanceScorer: counting };
    await runSourcing(d, "m1", { limit: 5 }); // 5 prospects, each scored provisionally (5 calls)
    expect((await all()).every((p) => p.state === "enriched")).toBe(true);
    calls = 0;
    await processBacklog(d, "m1");
    expect(calls).toBe(1); // tried one, still unknown → stopped
    calls = 0;
    await runSourcing(d, "m1", { limit: 5 });
    expect(calls).toBe(1); // same on the next sourcing run
  });

  it("a scorer that THROWS is unknown too, not a crash and not a zero", async () => {
    const throwing: RelevanceScorer = { kind: "llm", async score() { throw new Error("upstream 503"); } };
    await runSourcing({ ...deps, discoverySources: [source], relevanceScorer: throwing }, "m1", { limit: 5 });
    expect(((await all())[0]!.scoreBreakdown as { unknownFactors: string[] }).unknownFactors).toContain("relevance");
  });

  it("re-scoring an already-scored prospect while the scorer is down keeps the fit that was measured", async () => {
    // A poor fit (0.05) that was judged must not be re-ranked as "fit unknown": an unknown
    // factor is left out of the score, which would raise this prospect and erase the measurement.
    let answer: number | null = 0.05;
    const scorer: RelevanceScorer = { kind: "llm", async score() { return answer; } };
    const d = { ...deps, discoverySources: [source], relevanceScorer: scorer };
    await runSourcing(d, "m1", { limit: 5 });
    const [before] = await all();
    expect(before!.state).toBe("scored");

    answer = null; // the model goes down
    const after = await score(d, before!.id);
    const signal = async () => (await db.prospectSignals.findOne((s) => s.prospectId === before!.id))!;
    expect(after.state).toBe("scored");
    expect(after.score).toBe(before!.score);
    expect((after.scoreBreakdown as { unknownFactors: string[] }).unknownFactors).not.toContain("relevance");
    expect((await signal()).relevance).toBe(0.05);

    // "scored" always means the fit WAS judged: with nothing on file it drops back to provisional.
    await db.prospectSignals.update((await signal()).id, { relevance: null });
    expect((await score(d, before!.id)).state).toBe("enriched");
  });
});

// ============================================================================
describe("D9 — an import row's URL is user input the engine will fetch", () => {
  it("drops URLs that are not a public web address, and keeps the row if it still identifies someone", async () => {
    const res = await importProspects(deps, "m1", [
      { name: "Metadata", email: "a@fine.com", siteUrl: "http://169.254.169.254/latest/meta-data/" },
      { name: "Localhost", email: "b@fine.com", siteUrl: "http://localhost:5432/" },
      { name: "Decimal IP", email: "c@fine.com", siteUrl: "http://2130706433/" },
      { name: "File", email: "d@fine.com", siteUrl: "file:///etc/passwd" },
      { name: "Internal name", siteUrl: "http://db.internal/" }, // nothing else identifies this row
      { name: "Creds", email: "e@fine.com", channelUrl: "https://user:pass@youtube.com/@x" },
      { name: "Fine", email: "f@fine.com", siteUrl: "skinblog.com/about" },
    ]);
    expect(res.rejectedUrls).toBe(6);
    expect(res.imported).toBe(6);
    expect(res.skipped).toBe(1);
    const rows = await all();
    expect(rows.filter((p) => p.siteUrl || p.channelUrl).map((p) => [p.identity, p.siteUrl])).toEqual([["Fine", "https://skinblog.com/about"]]);
    expect(rows.find((p) => p.identity === "Metadata")).toMatchObject({ siteUrl: null, email: "a@fine.com" });
  });

  it("refuses rows that point at a competitor's or the merchant's own domain, and malformed addresses", async () => {
    await db.mailboxes.insert({ id: "mb1", merchantId: "m1", provider: "smtp", email: "dana@lumen-skincare.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });
    const res = await importProspects(deps, "m1", [
      { name: "Rival", siteUrl: "https://glowrival.com" },
      { name: "Rival staff", email: "pr@glowrival.com" },
      { name: "Ourselves", email: "dana@lumen-skincare.com" },
      { name: "Typo", email: "not an email" },
      { name: "Storefront", email: "shop@creator.io", siteUrl: "https://www.amazon.com/shop/creator" }, // the merchant's own list: allowed
    ]);
    expect(res).toMatchObject({ imported: 1, excluded: 3, skipped: 1 });
    expect((await all()).map((p) => p.identity)).toEqual(["Storefront"]);
  });
});
