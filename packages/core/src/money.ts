/**
 * Money is represented as integer minor units ("cents") tagged with an ISO-4217
 * currency. The platform is multi-currency throughout (Section 4) but never mixes
 * currencies in a single arithmetic operation — that is a programming error and
 * throws. All commission math rounds to whole cents using half-up rounding, which
 * is documented and deterministic so the ledger is reproducible.
 */

export type CurrencyCode = string; // ISO-4217, e.g. "USD", "MYR", "EUR"

export interface Money {
  readonly amountCents: number; // integer minor units; may be negative (reversals)
  readonly currency: CurrencyCode;
}

export function money(amountCents: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amountCents)) {
    throw new MoneyError(`amountCents must be an integer, got ${amountCents}`);
  }
  if (!currency || currency.length !== 3) {
    throw new MoneyError(`currency must be a 3-letter ISO-4217 code, got "${currency}"`);
  }
  return { amountCents, currency: currency.toUpperCase() };
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountCents + b.amountCents, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountCents - b.amountCents, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountCents, a.currency);
}

export function isPositive(a: Money): boolean {
  return a.amountCents > 0;
}

export function isZero(a: Money): boolean {
  return a.amountCents === 0;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountCents - b.amountCents;
}

/** Half-up rounding of a real number of cents to an integer number of cents. */
export function roundCents(realCents: number): number {
  return Math.sign(realCents) * Math.round(Math.abs(realCents));
}

/** Exact `numerator ÷ denominator` rounded half-up (half away from zero, like roundCents). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError(`cannot divide by ${denominator}`);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -quotient : quotient;
}

function assertWholeCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${what} must be a whole number of cents, got ${value}`);
}

// A rate is read as a decimal with this many places. Multiplying cents by the binary
// float instead rounds the wrong way whenever the true product ends in exactly half a
// cent: 100 × 0.145 is 14.5 → 15, but the float product is 14.499999999999998 → 14.
const RATE_DECIMALS = 12;
const RATE_DENOMINATOR = 10n ** BigInt(RATE_DECIMALS);

/**
 * Apply a decimal rate (0.15 === 15%) to a money amount, rounding half-up to whole cents.
 * Used for percentage commissions and percentage recruiter overrides. Exact: the rate is
 * taken as the decimal it was written as, and the arithmetic is done in integers.
 */
export function applyRate(base: Money, rate: number): Money {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new MoneyError(`rate must be a finite, non-negative number, got ${rate}`);
  }
  assertWholeCents(base.amountCents, "amountCents");
  const scaledRate = BigInt(rate.toFixed(RATE_DECIMALS).replace(".", ""));
  return money(Number(divideHalfUp(BigInt(base.amountCents) * scaledRate, RATE_DENOMINATOR)), base.currency);
}

/** `amountCents × part ÷ whole`, rounded half-up to a whole cent, computed exactly. */
export function proRateCents(amountCents: number, part: number, whole: number): number {
  assertWholeCents(amountCents, "amountCents");
  assertWholeCents(part, "part");
  assertWholeCents(whole, "whole");
  return Number(divideHalfUp(BigInt(amountCents) * BigInt(part), BigInt(whole)));
}

/**
 * Split `totalCents` in proportion to `weights` so that the parts add up to the total
 * exactly (largest-remainder method; ties go to the earlier weight). Rounding each share on
 * its own would let the parts drift a cent or two away from the whole.
 */
export function allocateCents(totalCents: number, weights: readonly number[]): number[] {
  assertWholeCents(totalCents, "totalCents");
  if (totalCents < 0) throw new MoneyError(`cannot allocate a negative amount, got ${totalCents}`);
  for (const w of weights) {
    assertWholeCents(w, "weight");
    if (w < 0) throw new MoneyError(`weights must be non-negative, got ${w}`);
  }
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sum === 0n) throw new MoneyError("cannot allocate across weights that sum to zero");

  const total = BigInt(totalCents);
  const shares = weights.map((w) => (total * BigInt(w)) / sum);
  const remainders = weights.map((w, index) => ({ index, remainder: (total * BigInt(w)) % sum }));
  let left = total - shares.reduce((s, x) => s + x, 0n);
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of remainders) {
    if (left === 0n) break;
    shares[index] = shares[index]! + 1n;
    left -= 1n;
  }
  return shares.map(Number);
}

/** Clamp a money amount to [min, max] (inclusive). Currencies must match. */
export function clamp(value: Money, min: Money | null, max: Money | null): Money {
  let out = value;
  if (min && compare(out, min) < 0) out = min;
  if (max && compare(out, max) > 0) out = max;
  return out;
}

export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function formatMoney(m: Money): string {
  const sign = m.amountCents < 0 ? "-" : "";
  const abs = Math.abs(m.amountCents);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${major}.${minor} ${m.currency}`;
}
