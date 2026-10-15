/**
 * Currency-amount <-> minor-unit conversion for form inputs. The API speaks integer cents;
 * people type "25", "25.5" or "1,250.00". Pure (no DOM) so it can be exercised in isolation.
 */

/**
 * Parse a typed currency amount into integer cents. Returns null when the text is not a
 * number. Accepts an optional leading sign, a currency symbol or code, and thousands
 * separators; treats a lone comma followed by 1-2 digits as a decimal comma ("12,50").
 */
export function parseAmountToCents(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  // Accounting-style negatives: (12.50)
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s ]/g, "").replace(/^[A-Za-z]{3}(?=[-+\d.,])/, "").replace(/[A-Za-z]{3}$/, "");
  s = s.replace(/[$€£¥₹]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!s) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the right-most one is the decimal mark, the other groups thousands.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // Only commas: "12,50" is a decimal comma; "1,250" / "1,250,000" are thousands.
    const decimals = s.length - lastComma - 1;
    const single = s.indexOf(",") === lastComma;
    if (single && decimals >= 1 && decimals <= 2) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

/** Cents → a plain editable amount ("2500" → "25.00"). No currency, no grouping. */
export function centsToAmount(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
