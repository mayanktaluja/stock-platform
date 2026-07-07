/**
 * Generic index-membership stamp for the US picks tab.
 *
 * The India equivalent (services/indexConstituents.js) is hardcoded to the four
 * Nifty keys and a .NS/.BO normaliser. This module is parametrised by a market's
 * index keys + a per-market ticker normaliser, so the SAME machinery powers the
 * universe dropdowns on the US (S&P 500 / NASDAQ-100 / Russell 2000 / Dow 30) tab.
 *
 * Pure + unit-testable; server.js calls loadMarketIndexConstituents() once at
 * module init and stampMarketIndexFlags() per row. The JSON files live at
 * data/sws-<market>/<market>-index-constituents.json, written locally by the
 * scripts/refresh-<market>-index-constituents.mjs jobs (Vercel can't fetch the
 * exchange/Wikipedia sources reliably — same constraint as the NSE list).
 */

import fs from "node:fs";

// Per-market index keys = the dropdown option values, in dropdown order.
export const MARKET_INDEX_KEYS = {
  us: ["sp500", "nasdaq100", "russell2000", "dow30"],
};

// Human labels for the dropdown options (the "All scored" default is added
// client-side). Keep in sync with MARKET_INDEX_KEYS.
export const MARKET_INDEX_LABELS = {
  us: { sp500: "S&P 500", nasdaq100: "NASDAQ-100", russell2000: "Russell 2000", dow30: "Dow Jones 30" },
};

// Per-market ticker normaliser → a canonical key shared by BOTH the constituent
// list and the picks-row ticker. US: dotted share classes (BRK.B / KELY.A) — fold
// '-' and '/' to '.' so source variants (BRK-B) match.
export const MARKET_NORMALISERS = {
  us: (t) => (typeof t === "string" ? t.trim().toUpperCase().replace(/[-/]/g, ".") : ""),
};

function emptySets(keys) {
  const o = {};
  for (const k of keys) o[k] = new Set();
  return o;
}

/** Build the per-index Sets from a parsed constituents payload, normalising each
 *  ticker so lookups match the picks-row form. */
export function buildMarketIndexSets(raw, market) {
  const keys = MARKET_INDEX_KEYS[market];
  const norm = MARKET_NORMALISERS[market];
  if (!keys || !norm) throw new Error(`unknown market: ${market}`);
  const sets = {};
  for (const k of keys) {
    const arr = raw && Array.isArray(raw[k]) ? raw[k] : [];
    sets[k] = new Set(arr.map((t) => norm(t)).filter(Boolean));
  }
  return sets;
}

/** Load + parse the constituent JSON. Returns { sets, available } — `available`
 *  is false when the file is missing/empty/corrupt, which the API surfaces so the
 *  UI can disable the dropdown options (graceful degradation, like the NSE list). */
export function loadMarketIndexConstituents(filePath, market) {
  const keys = MARKET_INDEX_KEYS[market];
  if (!keys) return { sets: {}, available: false };
  try {
    if (!fs.existsSync(filePath)) return { sets: emptySets(keys), available: false };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const sets = buildMarketIndexSets(raw, market);
    return { sets, available: keys.some((k) => sets[k].size > 0) };
  } catch (err) {
    console.warn(`[region-index-constituents] could not load ${filePath} (${market}): ${err.message}`);
    return { sets: emptySets(keys), available: false };
  }
}

/** Stamp one membership boolean per index key onto a picks/universe row (mutates). */
export function stampMarketIndexFlags(it, sets, market) {
  if (!it || !it.ticker) return;
  const keys = MARKET_INDEX_KEYS[market];
  const norm = MARKET_NORMALISERS[market];
  if (!keys || !norm) return;
  const key = norm(it.ticker);
  for (const k of keys) it[k] = !!(sets[k] && sets[k].has(key));
}

/** Which index keys actually have constituents loaded — drives per-option
 *  enable/disable in the dropdown (an empty list disables its option). */
export function availableMarketIndexKeys(sets, market) {
  return (MARKET_INDEX_KEYS[market] || []).filter((k) => sets[k] && sets[k].size > 0);
}
