import { describe, it, expect } from "vitest";
import { identifyProgram, backlinkTargetsFor, competitorHostsFromLinks, merchantDomainFromLink } from "../src/index.js";

describe("identifyProgram — extracts network + merchant from an affiliate link", () => {
  it("ShareASale (m= param)", () => {
    expect(identifyProgram("https://shareasale.com/r.cfm?b=999&u=joe&m=56789&urllink=acme.com")).toMatchObject({
      network: "ShareASale",
      kind: "shared",
      merchantId: "56789",
    });
  });

  it("ShareASale join link (merchantID alt param)", () => {
    expect(identifyProgram("https://shareasale.com/shareasale.cfm?merchantID=56789")).toMatchObject({ merchantId: "56789" });
  });

  it("Awin (awinmid)", () => {
    expect(identifyProgram("https://www.awin1.com/cread.php?awinmid=12345&awinaffid=999&ued=https://acme.com")).toMatchObject({
      network: "Awin",
      merchantId: "12345",
    });
  });

  it("Rakuten (mid)", () => {
    expect(identifyProgram("https://click.linksynergy.com/deeplink?id=AFF&mid=38000&murl=https%3A%2F%2Facme.com")).toMatchObject({
      network: "Rakuten Advertising",
      merchantId: "38000",
    });
  });

  it("CJ Affiliate (legacy click-PUB-ADV path)", () => {
    expect(identifyProgram("https://www.anrdoezrs.net/click-7654321-12345678")).toMatchObject({ network: "CJ Affiliate", merchantId: "12345678" });
  });

  it("Impact vanity domain (brand = subdomain)", () => {
    expect(identifyProgram("https://acme.pxf.io/c/123/456/789")).toMatchObject({ network: "Impact", kind: "vanity", vanityHost: "acme.pxf.io" });
  });

  it("ClickBank (vendor subdomain and vendor param)", () => {
    expect(identifyProgram("https://acmestore.hop.clickbank.net/")).toMatchObject({ network: "ClickBank", merchantId: "acmestore" });
    expect(identifyProgram("https://hop.clickbank.net/?affiliate=joe&vendor=acmestore")).toMatchObject({ merchantId: "acmestore" });
  });

  it("Avantlink (mi alt param)", () => {
    expect(identifyProgram("https://www.avantlink.com/click.php?tt=cl&mi=98765&pw=aff")).toMatchObject({ network: "Avantlink", merchantId: "98765" });
  });

  it("self-hosted programs on the merchant's own domain", () => {
    expect(identifyProgram("https://acme.com/pricing?via=joe")).toMatchObject({ network: "Rewardful", kind: "self_hosted", merchantDomain: "acme.com" });
    expect(identifyProgram("https://acme.com/?rfsn=12345.abcd")).toMatchObject({ network: "Refersion", kind: "self_hosted" });
    expect(identifyProgram("https://acme.com/?fpr=joe")).toMatchObject({ network: "FirstPromoter", kind: "self_hosted" });
  });

  it("returns null for a non-affiliate URL", () => {
    expect(identifyProgram("https://acme.com/about")).toBeNull();
    expect(identifyProgram("not a url")).toBeNull();
  });
});

describe("backlinkTargetsFor — turns a program into backlink queries", () => {
  it("shared network → query the click host, filtered by merchant id (with the exact param/value for post-filtering)", () => {
    const p = identifyProgram("https://shareasale.com/r.cfm?m=56789")!;
    // param/value are explicit so callers can verify rows EXACTLY — the provider-side
    // LIKE is a substring (`%m=56789%` would also match m=567890).
    expect(backlinkTargetsFor(p)).toContainEqual({ target: "shareasale.com", urlToContains: "m=56789", param: "m", value: "56789" });
  });

  it("vanity network → query the vanity host directly (no filter)", () => {
    const p = identifyProgram("https://acme.pxf.io/c/1/2/3")!;
    expect(backlinkTargetsFor(p)).toEqual([{ target: "acme.pxf.io" }]);
  });

  it("self-hosted → query the competitor apex, filtered by the marker param", () => {
    const p = identifyProgram("https://acme.com/?via=joe")!;
    expect(backlinkTargetsFor(p, "acme.com")).toEqual([{ target: "acme.com", urlToContains: "via=" }]);
  });
});

describe("identifyProgram — a generic marker is flagged as generic", () => {
  it("marks ?via= (Rewardful) as a generic marker; network-specific markers are not", () => {
    // `via` is also Twitter's "via @user" share param and an ordinary tracking tag.
    expect(identifyProgram("https://acme.com/pricing?via=joe")).toMatchObject({ network: "Rewardful", genericMarker: true });
    expect(identifyProgram("https://acme.com/?fpr=joe")?.genericMarker).toBeUndefined();
    expect(identifyProgram("https://acme.com/?rfsn=1.abc")?.genericMarker).toBeUndefined();
  });

  it("prefers the network-specific marker when a link carries both", () => {
    expect(identifyProgram("https://acme.com/?via=joe&fpr=joe")).toMatchObject({ network: "FirstPromoter" });
  });
});

describe("competitorHostsFromLinks — recursive expansion signal", () => {
  it("promotes only hosts the network registry identifies as a merchant", () => {
    const hosts = competitorHostsFromLinks(
      [
        "https://acme.pxf.io/c/1/2", // vanity tracking domain → the brand itself
        "https://shareasale.com/r.cfm?m=222&u=joe&urllink=https%3A%2F%2Fbrandb.com%2F", // shared network, destination spelled out
        "https://brandc.com/?fpr=joe", // network-specific self-hosted marker (FirstPromoter)
        "https://shareasale.com/r.cfm?m=222", // shared network, no recoverable destination → skip
        "https://amzn.to/3x?tag=joe-20", // retailer → skip
        "https://news.com/article", // no affiliate marker → skip
      ],
      ["mycompany.com"],
    );
    expect(hosts.sort()).toEqual(["acme.pxf.io", "brandb.com", "brandc.com"]);
  });

  it("NEVER promotes a host on a generic ?ref= / ?via= / /go/ shape (AUDIT-2026-10 D7)", () => {
    // Every one of these matched before, and each became a seed the frontier went on to
    // backlink-mine: a share button, a hosting company, a blog's own outbound redirect.
    const hosts = competitorHostsFromLinks([
      "https://twitter.com/intent/tweet?text=hi&via=someblog",
      "https://www.bluehost.com/go/deal",
      "https://brandb.com/buy?ref=joe",
      "https://rival.com/?via=joe",
      "https://someshop.com/aff/123",
      "https://another.com/?affiliate=9",
    ]);
    expect(hosts).toEqual([]);
    expect(merchantDomainFromLink("https://brandb.com/buy?ref=joe")).toBeNull();
    expect(merchantDomainFromLink("https://rival.com/?via=joe")).toBeNull();
  });

  it("never promotes a social network, a marketplace or a shortener even when a link names it", () => {
    const hosts = competitorHostsFromLinks([
      "https://shareasale.com/r.cfm?m=1&urllink=https%3A%2F%2Fwww.instagram.com%2Fbrand",
      "https://shareasale.com/r.cfm?m=1&urllink=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FX",
      "https://shareasale.com/r.cfm?m=1&urllink=https%3A%2F%2Fbit.ly%2Fabc",
      "https://youtube.com/watch?v=1&fpr=joe",
    ]);
    expect(hosts).toEqual([]);
  });

  it("respects the exclude set — your own domains and known competitors, subdomains included", () => {
    expect(competitorHostsFromLinks(["https://known.com/?fpr=x"], ["known.com"])).toEqual([]);
    expect(competitorHostsFromLinks(["https://shop.known.com/?fpr=x"], ["known.com"])).toEqual([]);
  });
});

describe("merchantDomainFromLink — resolve shared-network links to the brand domain", () => {
  it("reads the destination param on shared networks (ShareASale urllink, Rakuten murl, Awin ued)", () => {
    expect(merchantDomainFromLink("https://shareasale.com/r.cfm?b=1&u=joe&m=222&urllink=https%3A%2F%2Fbrandb.com%2Fshop")).toBe("brandb.com");
    expect(merchantDomainFromLink("https://click.linksynergy.com/deeplink?id=A&mid=99&murl=https%3A%2F%2Fbrandc.com%2Fp")).toBe("brandc.com");
    expect(merchantDomainFromLink("https://www.awin1.com/cread.php?awinmid=5&awinaffid=9&ued=https%3A%2F%2Fbrandd.com")).toBe("brandd.com");
  });

  it("now lets the recursive extractor surface shared-network merchants (gap closed)", () => {
    const hosts = competitorHostsFromLinks(["https://shareasale.com/r.cfm?m=222&u=joe&urllink=https%3A%2F%2Fbrandb.com%2F"]);
    expect(hosts).toContain("brandb.com");
  });

  it("returns null when no destination is recoverable from the URL", () => {
    expect(merchantDomainFromLink("https://shareasale.com/r.cfm?b=1&u=joe&m=222")).toBeNull(); // would need a redirect
  });
});
