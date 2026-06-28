import { describe, it, expect } from "vitest";
import { audienceOverlapScore, targetMarketForCurrency } from "../src/index.js";

describe("targetMarketForCurrency", () => {
  it("maps common currencies to a market", () => {
    expect(targetMarketForCurrency("USD")).toEqual({ geos: ["US"], language: "en" });
    expect(targetMarketForCurrency("gbp")?.geos).toContain("GB");
    expect(targetMarketForCurrency("EUR")?.language).toBeNull(); // multi-language
  });
  it("returns null for an unmapped or missing currency", () => {
    expect(targetMarketForCurrency("XYZ")).toBeNull();
    expect(targetMarketForCurrency(null)).toBeNull();
  });
});

describe("audienceOverlapScore", () => {
  const usd = targetMarketForCurrency("USD");

  it("is 1.0 for an in-market, right-language creator", () => {
    expect(audienceOverlapScore({ primaryGeo: "US", language: "en-US" }, usd)).toBe(1);
  });
  it("is partial when the language matches but the geo doesn't", () => {
    const s = audienceOverlapScore({ primaryGeo: "GB", language: "en" }, usd)!;
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
  it("is low when both geo and language mismatch", () => {
    expect(audienceOverlapScore({ primaryGeo: "JP", language: "ja" }, usd)!).toBeLessThan(0.3);
  });
  it("returns null (unknown) when the creator's geo AND language are both unknown", () => {
    expect(audienceOverlapScore({ primaryGeo: null, language: null }, usd)).toBeNull();
  });
  it("returns null when there is no target market", () => {
    expect(audienceOverlapScore({ primaryGeo: "US", language: "en" }, null)).toBeNull();
  });
  it("uses only the geo component for a multi-language market (EUR)", () => {
    const eur = targetMarketForCurrency("EUR");
    expect(audienceOverlapScore({ primaryGeo: "DE", language: "de" }, eur)).toBe(1); // geo in-market; language skipped
  });
});
