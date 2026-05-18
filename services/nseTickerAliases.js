// Legacy → current NSE symbol map for tickers that NSE (and Yahoo) have
// renamed or remapped following corporate actions. The legacy symbols are
// still listed in stockList.js' curated NIFTY50 / NIFTY_NEXT_50 / MIDCAP
// arrays, but NSE's quote-equity endpoint now returns `no_data` for them
// because the underlying entities have been renumbered to their successor
// listings. Yahoo Finance has applied the same remapping internally —
// `fundamentalsHistory.json` shows the legacy keys with empty annual/
// quarterly arrays while the successor keys carry the full history.
//
// Consulted by scripts/refresh-fundamentals.mjs so a curated entry like
// TATAMOTORS.NS gets folded into its successor (already present in the
// NIFTY500 supplement) instead of producing a permanent `no_data` failure
// every nightly refresh. Order matters: the SUCCESSOR is what reaches NSE
// and what becomes the snapshot key.
//
// Why a remap layer instead of editing stockList.js: ALL_STOCKS is consumed
// by the search index, scanner universe, portfolio matching, and audit
// trails. Swapping the symbols in-place there ripples through ~20 call
// sites; a thin alias layer at the data-fetch boundary keeps the blast
// radius scoped to the refresh pipeline.

export const NSE_TICKER_RENAMES = Object.freeze({
  // Tata Motors demerger (effective 2025): the original listing
  // (ISIN INE155A01022) was retained by the Passenger Vehicles entity
  // and trades as TMPV.NS. The Commercial Vehicles business was spun
  // out as a new listing (TMCV.NS, ISIN INE1TAE01010). Legacy holders
  // of TATAMOTORS.NS became TMPV holders plus TMCV bonus.
  "TATAMOTORS.NS": "TMPV.NS",

  // LTIMindtree (the L&T Infotech + Mindtree merger entity, ISIN
  // INE214T01019) ticker shortened from LTIM to LTM on NSE.
  "LTIM.NS": "LTM.NS",

  // Zomato rebranded to Eternal Ltd in March 2025; NSE symbol changed
  // from ZOMATO to ETERNAL while the ISIN (INE758T01015) was retained.
  "ZOMATO.NS": "ETERNAL.NS",
});

/**
 * Resolve an NSE symbol to its current form, applying any known
 * corporate-action rename. Returns the input unchanged when no rename
 * applies, so it's safe to wrap every symbol lookup.
 */
export function resolveCurrentNseSymbol(symbol) {
  if (!symbol) return symbol;
  return NSE_TICKER_RENAMES[symbol] || symbol;
}

/**
 * True if `symbol` is a known legacy ticker that has been remapped.
 * Used by callers that want to skip / warn on obsolete entries.
 */
export function isObsoleteNseSymbol(symbol) {
  return Boolean(symbol) && Object.prototype.hasOwnProperty.call(NSE_TICKER_RENAMES, symbol);
}
