/**
 * Audience-overlap scoring (Section 8.3). Turns the REAL creator geo/language we
 * already collect during enrichment (YouTube `country`/`defaultLanguage`, scrape-API
 * country, etc.) into the `audienceOverlap` scoring signal — geo/language alignment
 * between the creator's audience and the merchant's primary market.
 *
 * Honesty discipline: the creator's geo/language are real (from a provider) or null.
 * When BOTH are unknown we return null (the signal stays "unknown — no data", excluded
 * from the score), never an invented number. The merchant's target market is derived
 * from its billing currency as a sensible default until an explicit per-merchant
 * target-market ICP field exists; ambiguous currencies (EUR) carry geos but no single
 * language, so only the geo component contributes.
 */

export interface TargetMarket {
  /** ISO 3166-1 alpha-2 country codes the merchant primarily sells to. */
  geos: string[];
  /** ISO 639-1 language code, or null when the currency spans languages (e.g. EUR). */
  language: string | null;
}

const CURRENCY_MARKET: Record<string, TargetMarket> = {
  USD: { geos: ["US"], language: "en" },
  CAD: { geos: ["CA"], language: "en" },
  GBP: { geos: ["GB"], language: "en" },
  AUD: { geos: ["AU"], language: "en" },
  NZD: { geos: ["NZ"], language: "en" },
  SGD: { geos: ["SG"], language: "en" },
  EUR: { geos: ["DE", "FR", "ES", "IT", "NL", "IE", "BE", "AT", "PT", "FI", "GR"], language: null },
  JPY: { geos: ["JP"], language: "ja" },
  BRL: { geos: ["BR"], language: "pt" },
  MXN: { geos: ["MX"], language: "es" },
  INR: { geos: ["IN"], language: "en" },
};

/** The merchant's likely target market from its billing currency (null if unmapped). */
export function targetMarketForCurrency(currency: string | null | undefined): TargetMarket | null {
  if (!currency) return null;
  return CURRENCY_MARKET[currency.toUpperCase()] ?? null;
}

/**
 * 0..1 geo/language alignment between a creator and a target market, or null when it
 * cannot be assessed (no target, or the creator's geo AND language are both unknown).
 * An in-market, right-language creator → 1.0; right language, different geo → ~0.6;
 * mismatched on both → ~0.25.
 */
export function audienceOverlapScore(
  creator: { primaryGeo: string | null; language: string | null },
  target: TargetMarket | null,
): number | null {
  if (!target) return null;
  const components: number[] = [];

  if (creator.primaryGeo) {
    const g = creator.primaryGeo.toUpperCase();
    components.push(target.geos.includes(g) ? 1 : 0.3);
  }
  if (creator.language && target.language) {
    const l = creator.language.toLowerCase().split("-")[0]!; // "en-US" → "en"
    components.push(l === target.language ? 1 : 0.2);
  }

  if (components.length === 0) return null; // nothing comparable → unknown, not invented
  return components.reduce((a, b) => a + b, 0) / components.length;
}
