import { describe, it, expect } from "vitest";
import { detectAffiliateUrl, detectAffiliateLinksInHtml, hasProvenAffiliateSignal } from "../src/index.js";

/** AUDIT-2026-10 D10 — affiliate-link detection: host patterns honour their path/param requirement. */

const high = (url: string) => detectAffiliateUrl(url).filter((s) => s.confidence === "high");

describe("D10 — a network's own website is not an affiliate link", () => {
  it("impact.com counts only with a /c/ click path", () => {
    // `pathContains` used to be ignored for host patterns: every link to impact.com —
    // its blog, its pricing page — read as a HIGH-confidence Impact affiliate link.
    expect(high("https://impact.com/")).toEqual([]);
    expect(high("https://impact.com/blog/what-is-affiliate-marketing/")).toEqual([]);
    expect(high("https://impact.com/c/123/456/789")).toHaveLength(1);
  });

  it("partnerstack.com counts only with a /c/ click path", () => {
    expect(high("https://partnerstack.com/")).toEqual([]);
    expect(high("https://partnerstack.com/resources/guides")).toEqual([]);
    expect(high("https://partnerstack.com/c/acme/xyz")).toHaveLength(1);
  });

  it("a host pattern with params still requires one (Amazon needs ?tag=)", () => {
    expect(high("https://www.amazon.com/dp/B0ABC123")).toEqual([]);
    expect(high("https://www.amazon.com/dp/B0ABC123?tag=site-20")).toHaveLength(1);
  });
});

describe("D10 — real tracking links that used to be missed", () => {
  it("detects Impact brand tracking domains (*.pxf.io, *.sjv.io)", () => {
    const [long] = high("https://acme.pxf.io/c/123456/789/1011");
    expect(long).toMatchObject({ network: "Impact", confidence: "high" });
    expect(high("https://acme.pxf.io/AbC12")).toHaveLength(1); // short vanity link
    expect(high("https://brand.sjv.io/c/1/2/3")).toHaveLength(1);
    expect(high("https://pxf.io/")).toEqual([]); // the bare tracking apex is not a link
  });

  it("detects ShareASale short links (shrsl.com)", () => {
    expect(high("https://shrsl.com/3abcd")[0]).toMatchObject({ network: "ShareASale" });
  });

  it("detects Partnerize click links (prf.hn)", () => {
    expect(high("https://prf.hn/click/camref:1101l9abc/destination:https%3A%2F%2Fbrand.com")[0]).toMatchObject({ network: "Partnerize" });
  });

  it("detects PartnerStack link domains (*.partnerlinks.io)", () => {
    expect(high("https://acme.partnerlinks.io/xyz")[0]).toMatchObject({ network: "PartnerStack" });
  });

  it("counts them as proven affiliate signals", () => {
    expect(hasProvenAffiliateSignal(detectAffiliateUrl("https://acme.pxf.io/c/1/2/3"))).toBe(true);
    expect(hasProvenAffiliateSignal(detectAffiliateUrl("https://impact.com/blog"))).toBe(false);
  });
});

describe("detectAffiliateLinksInHtml — relative links come back absolute when the page URL is given", () => {
  it("absolutizes a cloaked /go/ link so it can be followed", () => {
    const html = `<a href="/go/brandx">get it</a><a href="mailto:a@b.com">mail</a><a href="#top">top</a>`;
    const withBase = detectAffiliateLinksInHtml(html, "https://blog.com/best-serums");
    expect(withBase.map((s) => s.url)).toEqual(["https://blog.com/go/brandx"]);
    expect(withBase[0]).toMatchObject({ confidence: "low", targetHost: "blog.com" });
    // Without a base the href is classified exactly as written (unchanged behaviour).
    expect(detectAffiliateLinksInHtml(html).map((s) => s.url)).toEqual(["/go/brandx"]);
  });
});
