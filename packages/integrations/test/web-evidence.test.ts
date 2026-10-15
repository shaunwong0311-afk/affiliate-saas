import { describe, it, expect } from "vitest";
import {
  extractEmailsFromHtml,
  discoverContactUrls,
  detectsContactForm,
  FetchRedirectResolver,
  MxEmailVerifier,
  SerpDiscoverySource,
  type SerpProvider,
  type SerpHit,
  type HttpFetcher,
  type FetchResult,
} from "../src/index.js";

/**
 * These tests pin the honesty guarantees of the real data-acquisition path: contact
 * extraction reads what's on the page (never guesses), the redirect resolver only
 * reports a destination it actually reached, and the SERP source never fabricates
 * affiliate links on a failed/short fetch.
 */

describe("extractEmailsFromHtml", () => {
  it("pulls mailto: addresses first and dedupes", () => {
    const html = `<a href="mailto:hi@creator.com">email</a> contact hi@creator.com or team@creator.com`;
    const out = extractEmailsFromHtml(html);
    expect(out[0]).toEqual({ email: "hi@creator.com", source: "mailto" });
    expect(out.some((e) => e.email === "team@creator.com")).toBe(true);
    expect(out.filter((e) => e.email === "hi@creator.com").length).toBe(1); // deduped
  });

  it("rejects asset / noreply / example junk (no false contacts)", () => {
    const html = `logo@2x.png noreply@brand.com hello@example.com real@creator.com`;
    const emails = extractEmailsFromHtml(html).map((e) => e.email);
    expect(emails).toContain("real@creator.com");
    expect(emails).not.toContain("noreply@brand.com");
    expect(emails).not.toContain("hello@example.com");
    expect(emails.some((e) => e.endsWith(".png"))).toBe(false);
  });

  it("returns nothing for a page with no contact info — never invents one", () => {
    expect(extractEmailsFromHtml("<html><body><h1>Welcome</h1></body></html>")).toEqual([]);
  });
});

describe("extractEmailsFromHtml — obfuscation handling", () => {
  const emailsIn = (html: string) => extractEmailsFromHtml(html).map((e) => e.email);

  it("reads bracketed at/dot obfuscation", () => {
    expect(emailsIn("contact me: joe [at] gmail [dot] com")).toContain("joe@gmail.com");
    expect(emailsIn("partnerships (at) brandsite (dot) co")).toContain("partnerships@brandsite.co");
  });

  it("reads UPPERCASE bare at/dot obfuscation", () => {
    expect(emailsIn("reach jane AT creator DOT co")).toContain("jane@creator.co");
  });

  it("reads the single-obfuscation `name [at] domain.com` form (obfuscated at, literal dot)", () => {
    expect(emailsIn("email me: john [at] gmail.com")).toContain("john@gmail.com");
    // literal dots + a two-level TLD reconstruct correctly (domain avoids the "example" junk filter).
    expect(emailsIn("jane (at) brandstudio.co.uk for press")).toContain("jane@brandstudio.co.uk");
  });

  it("does NOT match prose 'sit at the dot' (bare at/dot stay uppercase-only)", () => {
    expect(emailsIn("please sit at the dot on the floor")).toEqual([]);
  });

  it("reads spaced-punctuation obfuscation", () => {
    expect(emailsIn("hello @ brandsite . com for inquiries")).toContain("hello@brandsite.com");
  });

  it("reconstructs multi-part domains", () => {
    expect(emailsIn("team [at] mail.brand [dot] co")).toContain("team@mail.brand.co");
  });

  it("decodes HTML-entity-encoded addresses", () => {
    // j o e @ creator . com, fully numeric-entity encoded
    expect(emailsIn("&#106;&#111;&#101;&#64;creator&#46;com")).toContain("joe@creator.com");
  });

  it("decodes Cloudflare data-cfemail protection", () => {
    const html = `<a class="__cf_email__" data-cfemail="403225212c0023322521342f326e232f2d">[email protected]</a>`;
    const found = extractEmailsFromHtml(html);
    expect(found).toEqual([{ email: "real@creator.com", source: "cfemail" }]);
  });

  it("does NOT false-positive on ordinary prose (lowercase at/dot)", () => {
    expect(emailsIn("Look at the best dot com sites and meet me at the cafe.")).toEqual([]);
  });

  it("does NOT read 'me @ instagram.com/jane' as an address (AUDIT-2026-10 D11)", () => {
    // A spaced `@` in front of a URL is a sentence about a social profile. It used to
    // yield `me@instagram.com` — and that became the prospect's contact.
    expect(emailsIn("Follow me @ instagram.com/jane for daily routines")).toEqual([]);
    expect(emailsIn("Find us @ twitter.com and say hi")).toEqual([]);
    expect(emailsIn("DM us @ linktr.ee/brand")).toEqual([]);
    expect(emailsIn("more @ mysite.com/shop today")).toEqual([]); // a spaced @ before a plain URL
  });

  it("drops an 'obfuscated' match that is really a URL or a platform's domain", () => {
    expect(emailsIn("write to jane [at] instagram.com")).toEqual([]); // nobody's mailbox is @instagram.com
    expect(emailsIn("see john [at] mysite.com/contact")).toEqual([]); // runs into a path → a URL in prose
    expect(emailsIn("write to jane [at] mysite.com today")).toContain("jane@mysite.com"); // the real thing still reads
  });
});

describe("discoverContactUrls", () => {
  const base = "https://creator.com/blog";

  it("finds bio aggregators (Linktree/Beacons)", () => {
    const html = `<a href="https://linktr.ee/creator">links</a><a href="https://beacons.ai/creator">bio</a>`;
    const kinds = discoverContactUrls(html, base);
    expect(kinds.every((c) => c.kind === "bio_aggregator")).toBe(true);
    expect(kinds.map((c) => c.url)).toContain("https://linktr.ee/creator");
  });

  it("finds same-site contact / work-with-me pages and resolves relative links", () => {
    const html = `<a href="/work-with-me">collab</a><a href="/about">about</a><a href="/random">x</a>`;
    const urls = discoverContactUrls(html, base).map((c) => c.url);
    expect(urls).toContain("https://creator.com/work-with-me");
    expect(urls).toContain("https://creator.com/about");
    expect(urls).not.toContain("https://creator.com/random");
  });

  it("derives the YouTube About tab from a channel link", () => {
    const html = `<a href="https://youtube.com/@creator">channel</a>`;
    const urls = discoverContactUrls(html, base);
    expect(urls).toContainEqual({ url: "https://youtube.com/@creator/about", kind: "youtube_about" });
  });

  it("ignores off-site non-contact links and mailto/tel", () => {
    const html = `<a href="https://random.com/page">x</a><a href="mailto:a@b.com">m</a><a href="tel:123">t</a>`;
    expect(discoverContactUrls(html, base)).toEqual([]);
  });
});

describe("detectsContactForm", () => {
  it("detects an explicit contact form by class/id/action", () => {
    expect(detectsContactForm(`<form class="contact-form" action="/send"><input/></form>`)).toBe(true);
    expect(detectsContactForm(`<form action="/inquiry"><input/></form>`)).toBe(true);
  });

  it("detects a form with both an email field and a message field", () => {
    expect(detectsContactForm(`<form><input type="email"/><textarea name="message"></textarea></form>`)).toBe(true);
  });

  it("does not flag a plain search/newsletter form", () => {
    expect(detectsContactForm(`<form action="/search"><input type="text" name="q"/></form>`)).toBe(false);
    expect(detectsContactForm(`<form><input type="email" name="newsletter"/></form>`)).toBe(false);
  });
});

// These two used to stub the GLOBAL fetch: the resolver made its own unguarded, direct
// request with `redirect: "follow"`. It now resolves THROUGH the page fetcher (the guarded,
// proxied path — exercised end to end in proxy-fail-closed.test.ts), so the follower is
// what gets injected here.
describe("FetchRedirectResolver", () => {
  it("returns the final host after following redirects", async () => {
    const via = { async follow() { return { status: 200, finalUrl: "https://www.competitor.com/product/123" }; } };
    const res = await new FetchRedirectResolver({ via }).resolve("https://track.io/go?ref=abc");
    expect(res).toEqual({ finalUrl: "https://www.competitor.com/product/123", finalHost: "competitor.com" });
  });

  it("returns null when the fetch fails — never guesses a destination", async () => {
    const via = { async follow(): Promise<never> { throw new Error("network down"); } };
    expect(await new FetchRedirectResolver({ via }).resolve("https://track.io/go?ref=abc")).toBeNull();
  });

  it("without a follower it still goes through the outbound guard (a private target resolves to nothing)", async () => {
    // No network is touched: the guard refuses the literal before any request.
    expect(await new FetchRedirectResolver().resolve("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(await new FetchRedirectResolver().resolve("http://localhost:8787/admin")).toBeNull();
  });
});

describe("MxEmailVerifier", () => {
  it("rejects a malformed address without a DNS call", async () => {
    expect(await new MxEmailVerifier().verify("not-an-email")).toEqual({ deliverable: false, reason: "malformed address" });
  });
});

// ---- SERP source: no fabrication on failed/short fetch -----------------------
class FakeSerp implements SerpProvider {
  readonly kind = "fake-serp"; // NOT "deterministic-serp" → treated as real
  constructor(private readonly hits: SerpHit[]) {}
  async search(): Promise<SerpHit[]> {
    return this.hits;
  }
}
class FailFetcher implements HttpFetcher {
  readonly kind = "real-ish";
  async get(): Promise<FetchResult> {
    throw new Error("blocked by origin");
  }
}
class HtmlFetcher implements HttpFetcher {
  readonly kind = "real-ish";
  constructor(private readonly html: string) {}
  async get(url: string): Promise<FetchResult> {
    return { status: 200, url, html: this.html };
  }
}

const HIT: SerpHit = { title: "Best trail shoes — review", url: "https://blog.example/best", snippet: "in-depth review" };
const query = { merchantId: "m", niche: "shoes", competitors: ["competitor.com"], keywords: [], channels: ["serp" as const], limit: 1 };

describe("SerpDiscoverySource honesty", () => {
  it("emits ZERO affiliate links when the page fetch fails (no fabrication)", async () => {
    const out = await new SerpDiscoverySource(new FakeSerp([HIT]), new FailFetcher()).discover(query);
    expect(out.length).toBe(1);
    expect(out[0]!.outboundLinks).toEqual([]);
    expect(out[0]!.synthetic).toBe(false); // real providers
    expect(out[0]!.evidenceSummary).toMatch(/not fetched/);
  });

  it("emits ZERO affiliate links when the page is too short to trust", async () => {
    const out = await new SerpDiscoverySource(new FakeSerp([HIT]), new HtmlFetcher("<html></html>")).discover(query);
    expect(out[0]!.outboundLinks).toEqual([]);
  });

  it("detects REAL affiliate links actually present on a fetched page", async () => {
    const html = `<a href="https://amzn.to/3x?tag=joe-20">buy</a>`.padEnd(260, " ");
    const out = await new SerpDiscoverySource(new FakeSerp([HIT]), new HtmlFetcher(html)).discover(query);
    expect(out[0]!.outboundLinks.length).toBeGreaterThan(0);
    expect(out[0]!.pageHtml).toBeTruthy();
    expect(out[0]!.evidenceSummary).toMatch(/affiliate link/);
  });

  it("flags synthetic when wired with the deterministic default providers", async () => {
    const out = await new SerpDiscoverySource().discover({ ...query, limit: 2 });
    expect(out.every((c) => c.synthetic)).toBe(true);
  });
});
