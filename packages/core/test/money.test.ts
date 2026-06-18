import { describe, it, expect } from "vitest";
import { money, add, subtract, applyRate, clamp, roundCents, MoneyError, formatMoney } from "../src/index.js";

describe("money", () => {
  it("rejects non-integer cents", () => {
    expect(() => money(10.5, "USD")).toThrow(MoneyError);
  });

  it("rejects malformed currency", () => {
    expect(() => money(100, "US")).toThrow(MoneyError);
  });

  it("adds and subtracts same currency", () => {
    expect(add(money(100, "USD"), money(50, "USD")).amountCents).toBe(150);
    expect(subtract(money(100, "USD"), money(150, "USD")).amountCents).toBe(-50);
  });

  it("throws on currency mismatch", () => {
    expect(() => add(money(100, "USD"), money(50, "EUR"))).toThrow(MoneyError);
  });

  it("applies a rate with half-up rounding", () => {
    // 12345 * 0.15 = 1851.75 → 1852
    expect(applyRate(money(12_345, "USD"), 0.15).amountCents).toBe(1852);
  });

  it("rounds negative cents symmetrically", () => {
    expect(roundCents(-1851.75)).toBe(-1852);
    expect(roundCents(1851.5)).toBe(1852);
  });

  it("clamps to bounds", () => {
    expect(clamp(money(100, "USD"), money(20, "USD"), money(80, "USD")).amountCents).toBe(80);
    expect(clamp(money(10, "USD"), money(20, "USD"), null).amountCents).toBe(20);
  });

  it("formats money", () => {
    expect(formatMoney(money(-12_345, "USD"))).toBe("-123.45 USD");
    expect(formatMoney(money(5, "USD"))).toBe("0.05 USD");
  });
});
