/**
 * Dedupe search results by bare ticker, preferring the NSE listing.
 *
 * The Starbhai platform is NSE-canonical everywhere downstream — picks
 * file, watchlist storage, stock-detail modal, analyzer — but the
 * global search dropdown used to surface both `AJAXENGG.NS` and
 * `AJAXENGG.BO` for the same company. This helper collapses any such
 * pair to the NSE row (or keeps the BSE row standalone when NSE is
 * absent, e.g. a BSE-only SME).
 *
 * Caveat: assumes "same bare ticker on NSE and BSE" == "same issuer".
 * True for ~99.9% of Indian listings (NSE/BSE coordinate symbols for
 * dual-listed names). On the rare cross-issuer collision the BSE row
 * is hidden from the dropdown — acceptable failure mode for a search
 * surface; both rows remain reachable via direct symbol typing.
 */

const SUFFIX_RX = /\.(NS|BO)$/i;
const NSE_SUFFIX_RX = /\.NS$/i;

export function bareTicker(symbol) {
  return (symbol || "").replace(SUFFIX_RX, "").toUpperCase();
}

export function isNseSymbol(symbol) {
  return NSE_SUFFIX_RX.test(symbol || "");
}

export function dedupeByBareSymbol(results) {
  if (!Array.isArray(results)) return [];
  const preferred = new Map();
  for (const r of results) {
    const bare = bareTicker(r && r.symbol);
    if (!bare) continue;
    const existing = preferred.get(bare);
    if (!existing) {
      preferred.set(bare, r);
    } else if (!isNseSymbol(existing.symbol) && isNseSymbol(r.symbol)) {
      preferred.set(bare, r);
    }
  }
  return [...preferred.values()];
}
