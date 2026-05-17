/**
 * Pure helpers for the NSE-index-membership stamp applied to every pick row
 * served by /api/sws-picks and /api/sws-universe.
 *
 * Kept as a separate module so the helpers are unit-testable without spinning
 * up server.js and without filesystem mocking. The actual JSON load lives in
 * server.js (which calls `buildIndexSets()` once at module init).
 *
 * Powers the universe-filter dropdown on the SWS Picks tab.
 */

import fs from "node:fs";

const EMPTY_SETS = {
  nifty100:         new Set(),
  niftyMidcap150:   new Set(),
  niftySmallcap250: new Set(),
  nifty500:         new Set(),
};

/**
 * Build the four index sets from a parsed nse-index-constituents.json payload.
 * Returns a frozen object with the same shape so callers can't mutate state.
 */
export function buildIndexSets(raw) {
  if (!raw || typeof raw !== "object") return { ...EMPTY_SETS };
  return {
    nifty100:         new Set(Array.isArray(raw.nifty100)         ? raw.nifty100         : []),
    niftyMidcap150:   new Set(Array.isArray(raw.niftyMidcap150)   ? raw.niftyMidcap150   : []),
    niftySmallcap250: new Set(Array.isArray(raw.niftySmallcap250) ? raw.niftySmallcap250 : []),
    nifty500:         new Set(Array.isArray(raw.nifty500)         ? raw.nifty500         : []),
  };
}

/**
 * Read + parse the constituent JSON file from disk. Returns { sets, available }
 * — `available` is false if the file is missing or empty, which the API surfaces
 * to the UI so it can disable the three new dropdown options.
 */
export function loadIndexConstituentsFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { sets: { ...EMPTY_SETS }, available: false };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const sets = buildIndexSets(raw);
    return { sets, available: sets.nifty100.size > 0 };
  } catch (err) {
    console.warn(`[index-constituents] could not load ${filePath}: ${err.message}`);
    return { sets: { ...EMPTY_SETS }, available: false };
  }
}

/**
 * Strip Yahoo-style suffixes (.NS / .BO) and uppercase.
 * NSE CSVs ship bare symbols (RELIANCE, BAJAJ-AUTO); pick rows sometimes carry
 * the bare form, sometimes Yahoo-suffixed — normalise once before set lookup.
 */
export function normalizeTicker(ticker) {
  if (typeof ticker !== "string") return "";
  return ticker.replace(/\.(NS|BO)$/i, "").toUpperCase();
}

/**
 * Stamp the four universe-membership booleans onto a pick/universe row.
 *
 * The nifty500 branch OR-folds the new set with the legacy `nifty500FallbackSet`
 * (NIFTY500_SYMBOLS in server.js) so the existing radio's exact semantic is
 * preserved even if data/nse-index-constituents.json goes missing. The three
 * new flags have no fallback — when the JSON is absent they're all false, and
 * the UI separately disables those dropdown options via the available flag.
 *
 * Mutates `it` in place; returns nothing.
 */
export function stampIndexFlags(it, sets, nifty500FallbackSet) {
  if (!it || !it.ticker) return;
  const key = normalizeTicker(it.ticker);
  it.nifty100         = sets.nifty100.has(key);
  it.niftyMidcap150   = sets.niftyMidcap150.has(key);
  it.niftySmallcap250 = sets.niftySmallcap250.has(key);
  const inNew500      = sets.nifty500.has(key);
  const inFallback    = nifty500FallbackSet && nifty500FallbackSet.has(`${key}.NS`);
  it.nifty500         = inNew500 || !!inFallback;
}
