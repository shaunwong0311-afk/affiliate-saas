import { describe, it, expect } from "vitest";
import { isGoodLocalSendTime, localTimeForCountry } from "../src/send-timing.js";

describe("send-timing", () => {
  it("computes local time from country offset", () => {
    // 15:00 UTC → US (-6) = 09:00 local.
    const t = localTimeForCountry("US", new Date("2026-06-30T15:00:00Z")); // a Tuesday
    expect(t!.hour).toBeCloseTo(9, 1);
  });

  it("allows sends in the recipient's business hours, blocks the middle of their night", () => {
    // 15:00 UTC, US central = 09:00 local (Tuesday) → good.
    expect(isGoodLocalSendTime("US", new Date("2026-06-30T15:00:00Z"))).toBe(true);
    // 03:00 UTC, US central = 21:00 local prior evening → outside 8-17 window → blocked.
    expect(isGoodLocalSendTime("US", new Date("2026-06-30T03:00:00Z"))).toBe(false);
  });

  it("blocks weekends in the recipient's local timezone", () => {
    // Saturday local for GB (offset 0).
    expect(isGoodLocalSendTime("GB", new Date("2026-07-04T10:00:00Z"))).toBe(false); // Sat
    expect(isGoodLocalSendTime("GB", new Date("2026-07-03T10:00:00Z"))).toBe(true); // Fri
  });

  it("never blocks when the country/geo is unknown (falls back to UTC window)", () => {
    expect(isGoodLocalSendTime(null, new Date("2026-06-30T03:00:00Z"))).toBe(true);
    expect(isGoodLocalSendTime("ZZ", new Date("2026-06-30T03:00:00Z"))).toBe(true);
  });
});
