import { describe, it, expect } from "vitest";
import { buildProfile } from "@affiliate/core";
import type { HttpFetcher, FetchResult, AccountEnricher, AccountMetrics } from "@affiliate/integrations";
import { resolveContact } from "../src/index.js";

function fetcherFrom(pages: Record<string, string>): HttpFetcher & { hits: () => string[] } {
  const hits: string[] = [];
  return {
    kind: "mock",
    hits: () => hits,
    async get(url: string): Promise<FetchResult> {
      hits.push(url);
      const html = pages[url] ?? pages[url.replace(/\/$/, "")];
      return html ? { status: 200, url, html: `<html><body>${html}</body></html>`.padEnd(320, " ") } : { status: 404, url, html: "" };
    },
  };
}

function youtubeEnricher(out: { emails?: string[]; links?: string[] }): AccountEnricher {
  return {
    kind: "mock-yt",
    supports: (p) => p === "youtube",
    async enrich(): Promise<AccountMetrics> {
      return { reach: null, engagementRate: null, primaryGeo: null, language: null, source: "api", ...out };
    },
  };
}

const verify = (deliverable: string[]) => {
  const set = new Set(deliverable.map((e) => e.toLowerCase()));
  return async (email: string) => ({ deliverable: set.has(email.toLowerCase()) });
};

describe("resolveContact — graph traversal", () => {
  it("tries already-extracted page emails first (no fetch needed)", async () => {
    const fetcher = fetcherFrom({});
    const res = await resolveContact(
      { fetcher, verify: verify(["a@site.com"]) },
      { profile: buildProfile("https://site.com", []), seedUrl: "https://site.com", canFetch: true, knownEmails: [{ email: "a@site.com", source: "mailto" }], knownContactUrls: [] },
    );
    expect(res.email).toBe("a@site.com");
    expect(res.source).toBe("page:mailto");
    expect(fetcher.hits()).toHaveLength(0); // resolved without any network
  });

  it("YouTube-only creator: pulls the business email from the channel description (free API)", async () => {
    const res = await resolveContact(
      { fetcher: fetcherFrom({}), enricher: youtubeEnricher({ emails: ["business@creator.com"] }), verify: verify(["business@creator.com"]) },
      { profile: buildProfile("https://youtube.com/@creator", []), seedUrl: "https://youtube.com/@creator", canFetch: true, knownEmails: [], knownContactUrls: [] },
    );
    expect(res.email).toBe("business@creator.com");
    expect(res.source).toBe("youtube_api:description");
  });

  it("CHAIN: YouTube description has no email but links a website → follows it to its /contact page", async () => {
    const fetcher = fetcherFrom({
      "https://creatorsite.com": `<a href="/contact">Work with me</a>`,
      "https://creatorsite.com/contact": `<a href="mailto:hi@creatorsite.com">email me</a>`,
    });
    const res = await resolveContact(
      { fetcher, enricher: youtubeEnricher({ links: ["https://creatorsite.com"] }), verify: verify(["hi@creatorsite.com"]) },
      { profile: buildProfile("https://youtube.com/@creator", []), seedUrl: "https://youtube.com/@creator", canFetch: true, knownEmails: [], knownContactUrls: [] },
    );
    expect(res.email).toBe("hi@creatorsite.com"); // youtube → website → /contact → email
    expect(res.source).toMatch(/contact_page/);
  });

  it("follows a linked bio aggregator (Linktree) to its email", async () => {
    const fetcher = fetcherFrom({ "https://linktr.ee/creator": `<a href="mailto:team@creator.com">contact</a>` });
    const res = await resolveContact(
      { fetcher, verify: verify(["team@creator.com"]) },
      { profile: buildProfile("https://creator.com", []), seedUrl: "https://creator.com", canFetch: true, knownEmails: [], knownContactUrls: [{ url: "https://linktr.ee/creator", kind: "bio_aggregator" }] },
    );
    expect(res.email).toBe("team@creator.com");
    expect(res.source).toBe("bio_aggregator:mailto");
  });

  it("returns null (honest miss) when no property yields a deliverable email", async () => {
    const res = await resolveContact(
      { fetcher: fetcherFrom({}), verify: verify([]) },
      { profile: buildProfile("https://nowhere.com", []), seedUrl: "https://nowhere.com", canFetch: true, knownEmails: [], knownContactUrls: [] },
    );
    expect(res.email).toBeNull();
  });

  it("does no network traversal for synthetic/dev prospects (canFetch=false)", async () => {
    const fetcher = fetcherFrom({ "https://linktr.ee/x": `<a href="mailto:x@x.com">e</a>` });
    const res = await resolveContact(
      { fetcher, verify: verify(["x@x.com"]) },
      { profile: buildProfile("https://x.com", []), seedUrl: "https://x.com", canFetch: false, knownEmails: [], knownContactUrls: [{ url: "https://linktr.ee/x", kind: "bio_aggregator" }] },
    );
    expect(res.email).toBeNull();
    expect(fetcher.hits()).toHaveLength(0);
  });
});
