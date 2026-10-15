import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { buildProfile, systemClock, type Profile } from "@affiliate/core";
import {
  HashingEmbedder,
  DeterministicLlm,
  StubEmailFinder,
  NullEmailFinder,
  MockMailboxSender,
  extractHrefs,
  discoverContactUrls,
  type AccountEnricher,
  type AccountMetrics,
  type DiscoverySource,
  type EmailCandidate,
  type EmailFinder,
  type EmailVerifier,
  type FetchResult,
  type HttpFetcher,
  type RawCandidate,
} from "@affiliate/integrations";
import { runSourcing, enrich, ingestCandidate, importProspects, processBacklog, resolveContact, contactRejection, screenContacts, type RecruitmentDeps } from "../src/index.js";

/**
 * AUDIT-2026-10 D1 (critical) and D2 — the contact a prospect ends up with.
 *  D1: a real prospect never receives a GUESSED address, and a guess is never "verified".
 *  D2: an address is only taken from a surface the creator demonstrably owns, and never at
 *      a competitor's or the merchant's own domain.
 */

const pad = (body: string) => `<html><body>${body}</body></html>`.padEnd(400, " ");
function site(pages: Record<string, string>): HttpFetcher & { hits: string[] } {
  const hits: string[] = [];
  return {
    kind: "mock",
    hits,
    async get(url: string): Promise<FetchResult> {
      hits.push(url);
      const body = pages[url] ?? pages[url.replace(/\/$/, "")];
      return body == null ? { status: 404, url, html: "" } : { status: 200, url, html: pad(body) };
    },
  };
}
/** Like the production MX check: passes any address whose domain "has a mail server". */
const mxPassesEverything: EmailVerifier = { kind: "mx", async verify(e: string) { return { deliverable: /@/.test(e), reason: "mx record present" }; } };
const everythingDelivers = async () => ({ deliverable: true });

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
const source = (cands: RawCandidate[]): DiscoverySource => ({ sourceType: "serp_mining", async discover() { return cands; } });

let db: Database;
beforeEach(async () => {
  db = createMemoryDatabase();
  await db.merchants.insert({
    id: "m1", name: "Lumen", status: "active", niche: "skincare", competitors: ["glowrival.com"], billingStatus: "active",
    defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString(),
  });
});
function deps(sources: DiscoverySource[], extra: Partial<RecruitmentDeps> = {}): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: sources, clock: systemClock, ...extra };
}
async function prospects() {
  const out = [];
  for (const p of await db.prospects.find((x) => x.merchantId === "m1")) {
    const sig = (await db.prospectSignals.findOne((s) => s.prospectId === p.id))!;
    const note = (p.scoreBreakdown as { breakdown?: { factor: string; note: string }[] } | null)?.breakdown?.find((b) => b.factor === "contactability")?.note;
    out.push({ p, sig, note });
  }
  return out;
}

// ============================================================================
describe("D1 — a real prospect never receives a guessed address", () => {
  const noContactPage = site({ "https://skinblog.com": "no contact info here. ".repeat(20) });
  const real = [
    cand({ identity: "skinblog.com", siteUrl: "https://skinblog.com", sourceType: "backlink_mining", outboundLinks: ["https://glowrival.com/p?ref=skinblog"], confirmedCompetitor: "glowrival.com" }),
    cand({ identity: "Hyram Skincare", siteUrl: null, channelUrl: "https://www.youtube.com/channel/UCabc123", sourceType: "youtube_discovery" }),
  ];

  it("with the stub wired and a domain-level verifier that passes anything, a REAL prospect gets NO email", async () => {
    // Production with discovery keys and no Hunter key: this produced
    // `skinblog.com.team@skinblog.com` and `hyram.skincare@youtube.com`, both
    // verifiedEmail: true, scored "verified contact path", and sendable.
    await runSourcing(deps([source(real)], { emailVerifier: mxPassesEverything, fetcher: noContactPage }), "m1", { limit: 10 });
    const rows = await prospects();
    expect(rows).toHaveLength(2);
    for (const { p, sig, note } of rows) {
      expect(p.synthetic).toBe(false);
      expect(p.email).toBeNull();
      expect(p.evidence?.contactSource).toBeNull();
      expect(p.evidence?.contactVerified).toBe(false);
      expect(sig.verifiedEmail).toBe(false);
      expect(note).toBe("no verified contact");
      expect(p.tier).not.toBe("A"); // un-contactable can never be A-tier
    }
  });

  it("the stub is never even ASKED about a real prospect", async () => {
    const asked: string[] = [];
    const spyStub: EmailFinder = {
      name: "stub-finder",
      guesses: true,
      async find(input) { asked.push(`find:${input.domain}`); return [{ email: `info@${input.domain}`, confidence: 0.9, verified: false, source: "stub-finder" }]; },
      async verify(e) { asked.push(`verify:${e}`); return { deliverable: true, reason: "smtp ok" }; },
    };
    await runSourcing(deps([source(real)], { emailFinder: spyStub, emailVerifier: mxPassesEverything, fetcher: noContactPage }), "m1", { limit: 10 });
    expect(asked).toEqual([]);
  });

  it("any finder that DECLARES it guesses is treated the same, whatever its name", async () => {
    const renamed: EmailFinder = {
      name: "pattern-engine-v2",
      guesses: true,
      async find(input) { return [{ email: `hello@${input.domain}`, confidence: 0.9, verified: true, source: "pattern-engine-v2" }]; }, // even claiming verified
      async verify() { return { deliverable: true, reason: "ok" }; },
    };
    await runSourcing(deps([source(real)], { emailFinder: renamed, emailVerifier: mxPassesEverything, fetcher: noContactPage }), "m1", { limit: 10 });
    for (const { p, sig } of await prospects()) {
      expect(p.email).toBeNull();
      expect(sig.verifiedEmail).toBe(false);
    }
  });

  it("the demo stub is not a VERIFIER for a real address either", async () => {
    // A real address printed on a real page, but nothing real is wired to check it (no MX
    // verifier, finder = the stub, whose "verification" is a hash of the address). It must
    // not come out as a verified contact.
    const page = pad(`<a href="mailto:jane@skinblog.com">email me</a>`);
    await runSourcing(deps([source([cand({ siteUrl: "https://skinblog.com", pageHtml: page })])]), "m1", { limit: 5 });
    const [{ p, sig }] = await prospects();
    expect(p.evidence?.contactEmails).toEqual([{ email: "jane@skinblog.com", source: "mailto" }]); // found and kept as a candidate…
    expect(p.email).toBeNull(); // …but not adopted without a real check
    expect(sig.verifiedEmail).toBe(false);
  });

  it("with NO finder configured the honest outcome is 'no contact found'", async () => {
    await runSourcing(deps([source(real)], { emailFinder: new NullEmailFinder(), emailVerifier: mxPassesEverything, fetcher: noContactPage }), "m1", { limit: 10 });
    for (const { p } of await prospects()) expect(p.email).toBeNull();
  });

  it("…while an address actually FOUND on the prospect's own page is still taken (the production wiring)", async () => {
    // No Hunter key → the "no finder" placeholder + the MX check. The placeholder must not
    // be consulted as a mailbox verifier (it can only say no), or nothing would ever verify.
    const page = site({ "https://skinblog.com": `<a href="mailto:jane@skinblog.com">write to me</a>` });
    await runSourcing(deps([source([real[0]!])], { emailFinder: new NullEmailFinder(), emailVerifier: mxPassesEverything, fetcher: page }), "m1", { limit: 10 });
    const [{ p, sig, note }] = await prospects();
    expect(p.email).toBe("jane@skinblog.com");
    expect(p.evidence?.contactSource).toBe("page:mailto");
    expect(p.evidence?.contactVerified).toBe(true);
    expect(sig.verifiedEmail).toBe(true);
    expect(note).toBe("verified contact path");
  });
});

describe("D1 — a guess is confined to demo data and is never 'verified'", () => {
  const demo = [
    cand({ identity: "skincare reviewer 1", siteUrl: "https://skincarecreator1.com", sourceType: "competitor_affiliate_mining", outboundLinks: ["https://glowrival.com/buy?ref=x"], synthetic: true }),
    cand({ identity: "skincare channel 1", siteUrl: null, channelUrl: "https://youtube.com/@skincaretube1", sourceType: "creator_discovery", synthetic: true }),
  ];

  it("a SYNTHETIC prospect still gets a pattern-guess — labelled, and not verified", async () => {
    await runSourcing(deps([source(demo)]), "m1", { limit: 10 });
    const rows = await prospects();
    expect(rows).toHaveLength(2);
    for (const { p, sig, note } of rows) {
      expect(p.synthetic).toBe(true);
      expect(p.email).toBeTruthy();
      expect(p.evidence?.contactSource).toBe("pattern-guess");
      expect(p.evidence?.contactVerified).toBe(false);
      expect(sig.verifiedEmail).toBe(false); // was true
      expect(note).toMatch(/NOT verified/); // was "verified contact path"
    }
  });

  it("a demo guess is never at a platform's real domain (it used to be …@youtube.com)", async () => {
    await runSourcing(deps([source(demo)]), "m1", { limit: 10 });
    const channel = (await prospects()).find((r) => r.p.channelUrl)!;
    expect(channel.p.email).toMatch(/@example\.com$/); // the reserved domain, not a real mailbox provider
  });

  it("where synthetic discovery is off (no stub wired) even a synthetic prospect gets nothing", async () => {
    await runSourcing(deps([source(demo)], { emailFinder: new NullEmailFinder() }), "m1", { limit: 10 });
    for (const { p } of await prospects()) expect(p.email).toBeNull();
  });
});

describe("D1 — a real finder is asked only about the prospect's OWN domain", () => {
  function hunter(answers: Record<string, EmailCandidate[]>): EmailFinder & { asked: string[] } {
    const asked: string[] = [];
    return {
      name: "hunter",
      asked,
      async find(input) { asked.push(String(input.domain)); return answers[String(input.domain)] ?? []; },
      async verify() { return { deliverable: true, reason: "valid" }; },
    };
  }
  const found = (email: string): EmailCandidate => ({ email, confidence: 0.9, verified: true, source: "hunter" });

  it("never asks about youtube.com for a channel, or about a hosted-platform apex", async () => {
    const finder = hunter({ "youtube.com": [found("press@youtube.com")], "substack.com": [found("legal@substack.com")] });
    const cands = [
      cand({ identity: "Channel", siteUrl: null, channelUrl: "https://www.youtube.com/channel/UCabc123" }),
      cand({ identity: "Letter", siteUrl: "https://jane.substack.com" }),
      cand({ identity: "Blog", siteUrl: "https://skinblog.com" }),
    ];
    await runSourcing(deps([source(cands)], { emailFinder: finder, emailVerifier: mxPassesEverything }), "m1", { limit: 10 });
    expect(finder.asked).toEqual(["skinblog.com"]);
    for (const { p } of await prospects()) expect(p.email).toBeNull();
  });

  it("accepts a verified hit at the prospect's domain, and refuses one at a competitor's or a stranger's", async () => {
    const finder = hunter({
      "good.com": [found("jane@good.com")],
      "odd.com": [found("sales@glowrival.com"), found("someone@unrelated.io")],
    });
    await runSourcing(deps([source([cand({ identity: "Good", siteUrl: "https://good.com" }), cand({ identity: "Odd", siteUrl: "https://odd.com" })])], { emailFinder: finder, emailVerifier: mxPassesEverything }), "m1", { limit: 10 });
    const rows = await prospects();
    const good = rows.find((r) => r.p.identity === "Good")!;
    const odd = rows.find((r) => r.p.identity === "Odd")!;
    expect(good.p.email).toBe("jane@good.com");
    expect(good.p.evidence?.contactSource).toBe("hunter");
    expect(good.sig.verifiedEmail).toBe(true);
    expect(good.note).toBe("verified contact path");
    expect(odd.p.email).toBeNull();
    expect(odd.p.evidence?.contactRejected?.map((r) => r.email).sort()).toEqual(["sales@glowrival.com", "someone@unrelated.io"]);
  });
});

// ============================================================================
describe("D2 — contactRejection: which addresses may be a prospect's contact", () => {
  const policy = { ownDomains: ["janeskin.com"], excludedDomains: ["glowrival.com", "lumen-skincare.com"] };

  it("accepts the prospect's own domain (and its sub/parent domains) and personal mailboxes", () => {
    for (const email of ["jane@janeskin.com", "hi@mail.janeskin.com", "jane.skin@gmail.com", "jane@yahoo.co.uk", "j@proton.me"]) {
      expect(contactRejection(email, policy), email).toBeNull();
    }
    expect(contactRejection("jane@janeskin.com", { ...policy, ownDomains: ["blog.janeskin.com"] })).toBeNull();
  });

  it("refuses a competitor's address, the merchant's own, a platform's, and — for a prospect with its own domain — a third party's", () => {
    expect(contactRejection("support@glowrival.com", policy)).toMatch(/competitor/);
    expect(contactRejection("press@eu.glowrival.com", policy)).toMatch(/competitor/);
    expect(contactRejection("dana@lumen-skincare.com", policy)).toMatch(/merchant/);
    expect(contactRejection("press@youtube.com", policy)).toMatch(/platform/);
    expect(contactRejection("hello@linktr.ee", policy)).toMatch(/platform/);
    expect(contactRejection("sales@bigadnetwork.com", policy)).toMatch(/third party/);
    expect(contactRejection("hello@pixelagency.io", policy)).toMatch(/third party/);
    expect(contactRejection("not-an-email", policy)).toMatch(/malformed/);
  });

  it("a creator with NO domain of their own may be reached at a custom-domain address on a surface they own", () => {
    const noSite = { ownDomains: [], excludedDomains: ["glowrival.com"] };
    expect(contactRejection("business@creator.com", noSite)).toBeNull();
    expect(contactRejection("support@glowrival.com", noSite)).toMatch(/competitor/); // …but still never a competitor's
    // A hosted tenant (jane.substack.com) owns no email domain, so it is treated the same.
    expect(contactRejection("jane@janemedia.co", { ownDomains: ["jane.substack.com"], excludedDomains: [] })).toBeNull();
    expect(contactRejection("jane@substack.com", { ownDomains: ["jane.substack.com"], excludedDomains: [] })).toMatch(/platform/);
  });

  it("an address the SOURCE vouched for may sit at another ordinary domain — but never an excluded one", () => {
    expect(contactRejection("shows@podnetwork.fm", policy, { vouched: true })).toBeNull();
    expect(contactRejection("pr@glowrival.com", policy, { vouched: true })).toMatch(/competitor/);
  });

  it("screenContacts ranks: vouched, then own domain, then personal, and reports the refused", () => {
    const { usable, rejected } = screenContacts(
      [
        { email: "sales@bigadnetwork.com", source: "mailto" },
        { email: "jane.skin@gmail.com", source: "page" },
        { email: "hi@janeskin.com", source: "page" },
        { email: "owner@janeskin-network.fm", source: "feed_owner" },
      ],
      policy,
    );
    expect(usable.map((u) => u.email)).toEqual(["owner@janeskin-network.fm", "hi@janeskin.com", "jane.skin@gmail.com"]);
    expect(rejected).toEqual([{ email: "sales@bigadnetwork.com", reason: expect.stringMatching(/third party/) }]);
  });
});

describe("D2 — resolveContact only takes an address from a surface the creator owns", () => {
  const yt = (out: Partial<AccountMetrics>): AccountEnricher => ({
    kind: "yt",
    supports: (p) => p === "youtube",
    async enrich() { return { reach: 50000, engagementRate: 0.04, primaryGeo: "US", language: "en", source: "api", ...out }; },
  });
  const resolve = (opts: { seed: string; fetcher: HttpFetcher; enricher?: AccountEnricher; profile?: Profile; contactUrls?: { url: string; kind: string }[]; emails?: { email: string; source: string }[]; excluded?: string[] }) =>
    resolveContact(
      { fetcher: opts.fetcher, enricher: opts.enricher, verify: everythingDelivers },
      { profile: opts.profile ?? buildProfile(opts.seed, []), seedUrl: opts.seed, canFetch: true, knownEmails: opts.emails ?? [], knownContactUrls: opts.contactUrls ?? [], excludedDomains: opts.excluded ?? [] },
    );

  it("a SPONSOR's link in a YouTube description does not make the sponsor's support address the creator's contact", async () => {
    const fetcher = site({ "https://glowrival.com": `<a href="mailto:support@glowrival.com">Customer support</a><a href="https://youtube.com/@glowrivalofficial">our channel</a>` });
    const r = await resolve({ seed: "https://www.youtube.com/channel/UCabc123", fetcher, enricher: yt({ links: ["https://glowrival.com/?ref=creator"] }) });
    expect(r.email).toBeNull(); // was support@glowrival.com
    expect(r.profile?.accounts.some((a) => a.url.includes("glowrival"))).toBe(false); // and the sponsor is not in their graph
  });

  it("the same holds when the linked site is NOT a listed competitor — a link alone is never ownership", async () => {
    const fetcher = site({ "https://somebrand.com": `<a href="mailto:hello@somebrand.com">hello</a><form class="contact-form"><input type="email"><textarea name="message"></textarea></form>` });
    const r = await resolve({ seed: "https://youtube.com/@creator", fetcher, enricher: yt({ links: ["https://somebrand.com/collab"] }) });
    expect(r.email).toBeNull();
    expect(r.contactForm).toBe(false); // nor is a stranger's contact form "their" contact form
    expect(r.contactFormUrl).toBeNull();
  });

  it("a linked site that links BACK to the channel is the creator's own — its address is taken", async () => {
    const fetcher = site({ "https://creatorsite.com": `<a href="https://www.youtube.com/@creator">my channel</a><a href="mailto:hi@creatorsite.com">email</a>` });
    const r = await resolve({ seed: "https://youtube.com/@creator", fetcher, enricher: yt({ links: ["https://creatorsite.com"] }) });
    expect(r.email).toBe("hi@creatorsite.com");
    expect(r.source).toBe("website:mailto");
    expect(r.profile?.accounts.find((a) => a.platform === "website")).toMatchObject({ url: "https://creatorsite.com", provenance: "reciprocal_link" });
  });

  it("recognizes the back-link when the channel is known by id and the site links its @handle", async () => {
    const fetcher = site({ "https://creatorsite.com": `<a href="https://www.youtube.com/@hyram">YouTube</a><a href="mailto:team@creatorsite.com">email</a>` });
    const enricher = yt({ links: ["https://creatorsite.com"], aliases: ["https://www.youtube.com/channel/UCabc123", "https://www.youtube.com/@hyram"] });
    const r = await resolve({ seed: "https://www.youtube.com/channel/UCabc123", fetcher, enricher });
    expect(r.email).toBe("team@creatorsite.com");
  });

  it("an AGENCY's footer credit is never followed, let alone adopted", async () => {
    const footer = `<footer><a href="https://pixelagency.io/">Site by Pixel Agency</a></footer>`;
    const home = `<a href="/contact">Contact</a>${footer}`;
    const fetcher = site({
      "https://janeskin.com/contact": `<form class="contact-form"><input type="email"><textarea name="message"></textarea></form>${footer}`,
      "https://pixelagency.io": `<a href="mailto:hello@pixelagency.io">Hire us</a>`,
    });
    const seed = "https://janeskin.com";
    const r = await resolve({ seed, fetcher, profile: buildProfile(seed, [{ url: seed, links: extractHrefs(pad(home), seed) }]), contactUrls: discoverContactUrls(pad(home), seed) });
    expect(r.email).toBeNull(); // was hello@pixelagency.io
    expect(r.contactForm).toBe(true); // her OWN contact page's form is still found
    expect(r.contactFormUrl).toBe("https://janeskin.com/contact");
    expect(fetcher.hits).toEqual(["https://janeskin.com/contact"]); // the agency's site was not even fetched
  });

  it("on the prospect's OWN page: takes the own-domain address, refuses the ad network's and the competitor's", async () => {
    const emails = [
      { email: "sales@bigadnetwork.com", source: "mailto" }, // first on the page — used to win
      { email: "pr@glowrival.com", source: "page" },
      { email: "jane@janeskin.com", source: "page" },
    ];
    const r = await resolve({ seed: "https://janeskin.com", fetcher: site({}), emails, excluded: ["glowrival.com"] });
    expect(r.email).toBe("jane@janeskin.com");
    expect(r.source).toBe("page:page");
    expect(r.rejected.map((x) => x.email).sort()).toEqual(["pr@glowrival.com", "sales@bigadnetwork.com"]);

    // …and with ONLY the third parties' addresses on the page there is no contact at all.
    const none = await resolve({ seed: "https://janeskin.com", fetcher: site({}), emails: emails.slice(0, 2), excluded: ["glowrival.com"] });
    expect(none.email).toBeNull();
  });

  it("never takes an address at the MERCHANT's own domain", async () => {
    const r = await resolve({ seed: "https://youtube.com/@creator", fetcher: site({}), enricher: yt({ emails: ["partners@lumen-skincare.com"] }), excluded: ["lumen-skincare.com"] });
    expect(r.email).toBeNull();
  });

  it("a Linktree that does not link back is not trusted: no address, no accounts from it", async () => {
    // e.g. a "top creators" article linking somebody else's bio page.
    const fetcher = site({ "https://linktr.ee/someoneelse": `<a href="mailto:someoneelse@gmail.com">email</a><a href="https://instagram.com/someoneelse">ig</a>` });
    const r = await resolve({ seed: "https://janeskin.com", fetcher, contactUrls: [{ url: "https://linktr.ee/someoneelse", kind: "bio_aggregator" }] });
    expect(r.email).toBeNull();
    expect(r.profile?.accounts.some((a) => a.platform === "instagram")).toBe(false);
  });

  it("a Linktree that lists the creator's site IS theirs: its address and its accounts are taken", async () => {
    const fetcher = site({ "https://linktr.ee/jane": `<a href="https://janeskin.com">site</a><a href="mailto:jane.skin@gmail.com">email</a><a href="https://instagram.com/janeskin">ig</a>` });
    const r = await resolve({ seed: "https://janeskin.com", fetcher, contactUrls: [{ url: "https://linktr.ee/jane", kind: "bio_aggregator" }] });
    expect(r.email).toBe("jane.skin@gmail.com");
    expect(r.source).toBe("bio_aggregator:mailto");
    expect(r.profile?.accounts.find((a) => a.platform === "instagram")?.provenance).toBe("bio_aggregator");
  });

  it("an address at the prospect's own domain is theirs even on a page not shown to be theirs", async () => {
    const fetcher = site({ "https://linktr.ee/jane": `<a href="mailto:jane@janeskin.com">email</a><a href="mailto:other@gmail.com">other</a>` });
    const r = await resolve({ seed: "https://janeskin.com", fetcher, contactUrls: [{ url: "https://linktr.ee/jane", kind: "bio_aggregator" }] });
    expect(r.email).toBe("jane@janeskin.com"); // not other@gmail.com
  });

  it("looks up only a few unproven channels — an article linking ten creators does not spend ten API lookups", async () => {
    const seed = "https://janeskin.com";
    const tenChannels = Array.from({ length: 10 }, (_, i) => `https://youtube.com/@creator${i}`);
    let lookups = 0;
    const counting: AccountEnricher = { kind: "yt", supports: (p) => p === "youtube", async enrich() { lookups++; return { reach: 1, engagementRate: null, primaryGeo: null, language: null, source: "api", emails: ["someone@gmail.com"] }; } };
    const r = await resolve({ seed, fetcher: site({}), profile: buildProfile(seed, [{ url: seed, links: tenChannels }]), enricher: counting });
    expect(r.email).toBeNull(); // none of them is hers
    expect(lookups).toBe(3);
  });

  it("a YouTube channel merely linked from the site contributes nothing unless its description links back", async () => {
    const seed = "https://janeskin.com";
    const linked = buildProfile(seed, [{ url: seed, links: ["https://youtube.com/@famouscreator"] }]);
    const stranger = await resolve({ seed, fetcher: site({}), profile: linked, enricher: yt({ emails: ["famous@gmail.com"], links: ["https://famous.com"] }) });
    expect(stranger.email).toBeNull();
    const own = await resolve({ seed, fetcher: site({}), profile: linked, enricher: yt({ emails: ["jane.skin@gmail.com"], links: ["https://janeskin.com/about"] }) });
    expect(own.email).toBe("jane.skin@gmail.com");
    expect(own.profile?.accounts.find((a) => a.platform === "youtube")?.provenance).toBe("reciprocal_link");
  });
});

describe("D2 — through the pipeline", () => {
  it("uses the podcast feed's owner address FIRST, ahead of anything else in the feed", async () => {
    const header = `<rss><channel><title>The Skin Hour</title><link>https://skinhour.fm</link><description>Questions? hello@skinhour.fm</description></channel></rss>`.padEnd(400, " ");
    const podcast = cand({
      identity: "The Skin Hour",
      siteUrl: "https://skinhour.fm",
      sourceType: "podcast_discovery",
      pageHtml: header,
      contactEmails: [{ email: "jane.host@gmail.com", source: "feed_owner" }],
    });
    await runSourcing(deps([source([podcast])], { emailVerifier: mxPassesEverything }), "m1", { limit: 5 });
    const [{ p, sig }] = await prospects();
    expect(p.evidence?.contactEmails?.[0]).toEqual({ email: "jane.host@gmail.com", source: "feed_owner" });
    expect(p.email).toBe("jane.host@gmail.com"); // not hello@skinhour.fm, which comes first in the document
    expect(p.evidence?.contactSource).toBe("feed_owner");
    expect(sig.verifiedEmail).toBe(true);
  });

  it("does not keep a competitor's or third party's address as a candidate contact at ingest", async () => {
    const page = pad(`<a href="mailto:hello@glowrival.com">glowrival</a> ads: sales@bigadnetwork.com — me: jane@blog-two.com`);
    await runSourcing(deps([source([cand({ siteUrl: "https://blog-two.com", pageHtml: page })])], { emailVerifier: mxPassesEverything }), "m1", { limit: 5 });
    const [{ p }] = await prospects();
    expect(p.evidence?.contactEmails).toEqual([{ email: "jane@blog-two.com", source: "page" }]);
    expect(p.email).toBe("jane@blog-two.com");
  });

  it("the merchant's OWN domain is derived from its mailboxes and sending domains — never from a consumer mailbox", async () => {
    await db.mailboxes.insert({ id: "mb1", merchantId: "m1", provider: "smtp", email: "dana@lumen-skincare.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });
    await db.mailboxes.insert({ id: "mb2", merchantId: "m1", provider: "gmail", email: "lumen.outreach@gmail.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "" });
    await db.sendingDomains.insert({ id: "sd1", merchantId: "m1", domain: "mail.lumen-mail.com", spfStatus: "verified", dkimStatus: "verified", dmarcStatus: "verified", warmupStatus: "ready" });
    const page = pad(`partners: partners@lumen-skincare.com, bounce@mail.lumen-mail.com — or me: creator.jane@gmail.com`);
    await runSourcing(deps([source([cand({ siteUrl: null, channelUrl: "https://www.tiktok.com/@janeskin", pageHtml: page })])], { emailVerifier: mxPassesEverything }), "m1", { limit: 5 });
    const [{ p }] = await prospects();
    // gmail.com is NOT "the merchant's domain" just because one of its mailboxes is a Gmail.
    expect(p.email).toBe("creator.jane@gmail.com");
    expect(p.evidence?.contactEmails?.map((e) => e.email)).toEqual(["creator.jane@gmail.com"]);
  });
});

describe("an imported address is the merchant's own data and survives enrichment", () => {
  it("is neither replaced by something found on a page nor wiped when nothing is found", async () => {
    // Before: enrich overwrote `email` with whatever resolution returned — for an imported
    // prospect that meant a pattern-guess, or null.
    const d = deps([], { emailVerifier: mxPassesEverything, fetcher: site({ "https://trailgeek.com": `<a href="mailto:webmaster@trailgeek.com">webmaster</a>` }) });
    await importProspects(d, "m1", [{ name: "Trail Geek", email: "Jane.Personal@Outlook.com", siteUrl: "trailgeek.com" }, { name: "No Site", email: "solo@creator.io" }]);
    await processBacklog(d, "m1");
    const rows = await prospects();
    const geek = rows.find((r) => r.p.identity === "Trail Geek")!;
    expect(geek.p.email).toBe("jane.personal@outlook.com");
    expect(geek.p.evidence?.contactSource).toBe("import");
    expect(geek.p.siteUrl).toBe("https://trailgeek.com"); // a bare domain gets a scheme
    expect(rows.find((r) => r.p.identity === "No Site")!.p.email).toBe("solo@creator.io");
    for (const r of rows) expect(r.p.state).toBe("scored");
  });

  it("is marked verified only if a real check confirms it — never by the demo stub", async () => {
    const d = deps([]); // stub finder, no verifier
    await importProspects(d, "m1", [{ name: "Solo", email: "solo@creator.io" }]);
    const [imported] = await db.prospects.find((x) => x.merchantId === "m1");
    const after = await enrich(d, imported!.id);
    expect(after.email).toBe("solo@creator.io"); // kept on trust
    expect((await db.prospectSignals.findOne((s) => s.prospectId === after.id))!.verifiedEmail).toBe(false);
    expect(after.evidence?.contactVerified).toBe(false);
  });
});

describe("ingestCandidate carries source-vouched addresses", () => {
  it("puts them first and labels them", async () => {
    const merchant = await db.merchants.require("m1");
    const p = await ingestCandidate(deps([]), merchant, cand({ siteUrl: "https://show.fm", pageHtml: pad("write to booking@show.fm"), contactEmails: [{ email: "Owner@Show.fm", source: "feed_owner" }] }));
    expect(p?.evidence?.contactEmails).toEqual([
      { email: "owner@show.fm", source: "feed_owner" },
      { email: "booking@show.fm", source: "page" },
    ]);
  });
});
