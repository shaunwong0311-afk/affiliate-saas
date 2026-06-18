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

/**
 * Apply a decimal rate (0.15 === 15%) to a money amount, rounding to whole cents.
 * Used for percentage commissions and percentage recruiter overrides.
 */
export function applyRate(base: Money, rate: number): Money {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new MoneyError(`rate must be a finite, non-negative number, got ${rate}`);
  }
  return money(roundCents(base.amountCents * rate), base.currency);
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
