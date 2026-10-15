import { describe, it, expect } from "vitest";
import { applyRate, money, proRateCents, allocateCents, MoneyError } from "../src/index.js";

// AUDIT-2026-10 M8: "half-up" was applied to a binary float product.
describe("applyRate is exact", () => {
  it("rounds a true half cent up even when the float product falls just short of it", () => {
    // 100 × 0.145 = 14.5 exactly; in floating point it is 14.499999999999998 and used to round to 14.
    expect(100 * 0.145).toBeLessThan(14.5);
    expect(applyRate(money(100, "USD"), 0.145).amountCents).toBe(15);
    expect(applyRate(money(1000, "USD"), 0.0725).amountCents).toBe(73);
    expect(applyRate(money(290, "USD"), 0.35).amountCents).toBe(102);
    expect(applyRate(money(1010, "USD"), 0.15).amountCents).toBe(152);
    // 1.15 × 100 is 114.99999999999999 as a float.
    expect(applyRate(money(100, "USD"), 1.15).amountCents).toBe(115);
  });

  it("still rounds ordinary cases the documented way", () => {
    expect(applyRate(money(12_345, "USD"), 0.15).amountCents).toBe(1852); // 1851.75
    expect(applyRate(money(3500, "USD"), 0.0705).amountCents).toBe(247); // 246.75
    expect(applyRate(money(333, "USD"), 0.1).amountCents).toBe(33); // 33.3
    expect(applyRate(money(10_000, "USD"), 0).amountCents).toBe(0);
    expect(applyRate(money(10_000, "USD"), 1).amountCents).toBe(10_000);
    expect(applyRate(money(-12_345, "USD"), 0.15).amountCents).toBe(-1852); // symmetric
  });

  it("agrees with exact decimal arithmetic for every rate from 0.1% to 99.9% on awkward amounts", () => {
    for (const cents of [1, 3, 5, 15, 99, 105, 995, 1005, 33_335]) {
      for (let permille = 1; permille < 1000; permille += 1) {
        // cents × permille / 1000, half-up, in integers.
        const expected = Math.floor((cents * permille * 2 + 1000) / 2000);
        expect(applyRate(money(cents, "USD"), permille / 1000).amountCents).toBe(expected);
      }
    }
  });

  it("rejects a negative or non-finite rate", () => {
    expect(() => applyRate(money(100, "USD"), -0.1)).toThrow(MoneyError);
    expect(() => applyRate(money(100, "USD"), Number.NaN)).toThrow(MoneyError);
  });
});

describe("pro-rating and allocation are exact", () => {
  it("proRateCents rounds half-up without floats", () => {
    expect(proRateCents(100, 1, 3)).toBe(33);
    expect(proRateCents(100, 2, 3)).toBe(67);
    expect(proRateCents(5, 1, 2)).toBe(3); // 2.5 → 3
    expect(proRateCents(9_300, 7_000, 10_000)).toBe(6_510);
    expect(() => proRateCents(100.5, 1, 2)).toThrow(MoneyError);
    expect(() => proRateCents(100, 1, 0)).toThrow(MoneyError);
  });

  it("allocateCents parts always add up to the total", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(10, [3, 7])).toEqual([3, 7]);
    expect(allocateCents(1, [1, 1])).toEqual([1, 0]);
    expect(allocateCents(0, [5, 5])).toEqual([0, 0]);
    for (const total of [1, 7, 99, 1001, 123_457]) {
      const parts = allocateCents(total, [3, 1, 4, 1, 5, 9, 2, 6]);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
    expect(() => allocateCents(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocateCents(100, [1, -1])).toThrow(MoneyError);
  });
});
