import { describe, it, expect } from "vitest";
import { identifyProgram, backlinkTargetsFor, parseProgramInput } from "../src/index.js";

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
  it("shared network → query the click host, filtered by merchant id", () => {
    const p = identifyProgram("https://shareasale.com/r.cfm?m=56789")!;
    expect(backlinkTargetsFor(p)).toContainEqual({ target: "shareasale.com", urlToContains: "m=56789" });
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

describe("parseProgramInput — forgiving manual entry", () => {
  it("accepts a pasted affiliate / join link", () => {
    expect(parseProgramInput("https://shareasale.com/shareasale.cfm?merchantID=56789")).toMatchObject({ network: "ShareASale", merchantId: "56789" });
  });

  it("accepts a bare vanity domain", () => {
    expect(parseProgramInput("acme.pxf.io")).toMatchObject({ network: "Impact", kind: "vanity", vanityHost: "acme.pxf.io" });
  });

  it("accepts 'Network id' and 'network:id' (case / spacing insensitive)", () => {
    expect(parseProgramInput("ShareASale 56789")).toMatchObject({ network: "ShareASale", merchantId: "56789" });
    expect(parseProgramInput("awin:12345")).toMatchObject({ network: "Awin", merchantId: "12345" });
    expect(parseProgramInput("rakuten 38000")).toMatchObject({ network: "Rakuten Advertising", merchantId: "38000" });
  });

  it("returns null for unrecognized input", () => {
    expect(parseProgramInput("")).toBeNull();
    expect(parseProgramInput("just some text")).toBeNull();
  });
});
