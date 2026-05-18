/**
 * Risk Lab — per-ticker sector overrides.
 *
 * SWS occasionally miscategorises stocks at the sector level. The canonical
 * case is ANANTRAJ (Anant Raj Limited): listed as "Diversified Financials"
 * in data/sws/picks-latest.json[*].sector, but it's a Real Estate developer
 * (NCR housing + commercial). Under the production normalizeSector path
 * (macroRegime.js:90+), "Diversified Financials" is in the alias map as
 * `null` ("can't normalize cleanly"), so the macro overlay never fires.
 *
 * This file is a curated override list. The lab reads the picks row's
 * `sector` and replaces it with the override if present. Diversified
 * conglomerates (RIL, ITC, L&T) get an ARRAY of sectors — the adjusted
 * scorer takes the worst-case impact across them, so the overlay reflects
 * the most fragile leg of the business under each regime.
 *
 * Editing guidance: add a ticker by name (NSE symbol, uppercase). The
 * value is either a single canonical sector string (one of the values
 * returned by normalizeSector) or an array of them. Adding a stock here
 * has no side effects on production scoring — only the lab reads this.
 */

const TICKER_SECTOR_OVERRIDES = {
  // SWS miscategorisation: ANANTRAJ is a Real Estate developer (NCR housing
  // + commercial), but SWS reports it as Diversified Financials. This is
  // the canonical case study from the 2026-05-18 Risk Lab plan.
  ANANTRAJ: "Real Estate",

  // Diversified conglomerates — array of canonical sectors. Lab takes the
  // worst-case impact across them so the overlay surfaces the most fragile
  // leg under the current regime.
  RELIANCE: ["Oil & Gas", "Telecom", "Retail"],
  ITC: ["FMCG", "Pharma", "Real Estate"],
  LT: ["Capital Goods", "Infrastructure", "IT Services"],
  "M&M": ["Automobile", "Capital Goods"],
  TATAMOTORS: ["Automobile", "IT Services"],
  ADANIENT: ["Infrastructure", "Power", "Oil & Gas"],
  GRASIM: ["Cement", "Chemicals", "FMCG"],

  // EPC / Power-T&D-heavy industrials that SWS lumps under "Capital Goods"
  // but whose dominant risk is Real-Estate-adjacent (working-capital cycles
  // tied to housing/infra demand). Adding "Real Estate" as a secondary so
  // they get hit by rate-hike and risk-off scenarios.
  KEC: ["Capital Goods", "Infrastructure"],
  KALPATPOWR: ["Capital Goods", "Infrastructure"],
};

/**
 * Resolve a ticker's effective sector(s) for the Risk Lab. Returns:
 *   - null if neither override nor source sector available
 *   - string for a single canonical sector
 *   - array of strings for diversified names
 *
 * sourceSector is the raw value from picks-latest.json[*].sector — used
 * as the fallback when no override exists.
 */
export function resolveSectorsForTicker(ticker, sourceSector) {
  if (!ticker) return sourceSector || null;
  const upper = String(ticker).toUpperCase();
  if (upper in TICKER_SECTOR_OVERRIDES) {
    return TICKER_SECTOR_OVERRIDES[upper];
  }
  return sourceSector || null;
}

/**
 * Whether a ticker has an explicit override (useful for telemetry — count
 * how many lab adjustments come from overrides vs source data).
 */
export function hasOverride(ticker) {
  if (!ticker) return false;
  return String(ticker).toUpperCase() in TICKER_SECTOR_OVERRIDES;
}

// Exported for tests that want to assert specific override entries exist
// (e.g. "ANANTRAJ must be tagged Real Estate or the entire ANANTRAJ case
// study collapses").
export { TICKER_SECTOR_OVERRIDES };
