import { randomUUID, randomBytes } from "node:crypto";

/**
 * A Clock abstraction keeps the domain deterministic and testable: engines, the
 * ledger, and attribution never call Date.now() directly — they receive a Clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A fixed clock for tests; advanceable. */
export function fixedClock(start: Date | number): Clock & { set(d: Date | number): void; advance(ms: number): void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set: (d) => {
      current = new Date(d).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/**
 * UUIDv7 — time-sortable. Used for click_id so click records are naturally ordered
 * and index well on the hot path (Section 6). First 48 bits are the Unix epoch in
 * milliseconds; the rest is randomness with the version/variant nibbles set.
 */
export function uuidv7(now: number = Date.now()): string {
  const ms = Math.max(0, Math.floor(now));
  const rnd = randomBytes(10);

  // 48-bit timestamp
  const timeHex = ms.toString(16).padStart(12, "0").slice(-12);

  // version 7 in the high nibble of the 7th byte
  const randA = ((rnd[0]! & 0x0f) | 0x70).toString(16).padStart(2, "0") + rnd[1]!.toString(16).padStart(2, "0");

  // variant 10xx in the high bits of the 9th byte
  const randBHigh = ((rnd[2]! & 0x3f) | 0x80).toString(16).padStart(2, "0") + rnd[3]!.toString(16).padStart(2, "0");
  const randBLow = Array.from(rnd.subarray(4, 10))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return (
    `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${randA}-${randBHigh}-${randBLow}`
  );
}

/** A general-purpose opaque id (UUIDv4) for non-hot-path entities. */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Generate a non-guessable affiliate/discount code. Leak protection (Section 7)
 * starts with unpredictability — avoid sequential or low-entropy codes.
 */
export function newCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (I,O,0,1)
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
