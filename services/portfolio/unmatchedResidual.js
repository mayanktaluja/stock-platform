// Unmatched-equity residual — the value of uploaded holdings that the analyzer
// could not resolve to its SWS-scored universe (freshly-listed demergers,
// SME/illiquid names, ETFs that failed live resolution). These rows live in
// `parsed.unmatched`, never enter `scoredHoldings`, and so are absent from the
// SWS snapshot's money totals. To keep the Portfolio Analyzer hero trio ("Money
// put in" / "What it's worth today" / "Net P&L") reflecting the user's FULL
// book, we fold these rows' broker value into the snapshot DISPLAY totals only —
// they are never inserted into scoredHoldings (which feeds scoring, position
// weights, tiers, action mix, baskets, and the recommendation content-hash).
//
// Pure + deterministic. Shared by /analyze and /analyze/rerun in server.js so
// the two paths can't drift.

// Everything EXCEPT mutual funds / bonds / F&O counts as equity book value.
// MFs render separately via mfPositions; bonds/F&O aren't equity. This is an
// exclude-list on purpose: the parser's resolution chain admits both "equity"
// and "unknown" instrumentTypes, so a {equity,etf} whitelist would silently
// drop the "unknown" rows.
export const NON_EQUITY_INSTRUMENT_TYPES = new Set(["mf", "bond", "fno"]);

export function filterUnmatchedEquity(unmatched) {
  return (Array.isArray(unmatched) ? unmatched : []).filter(
    (u) => u && !NON_EQUITY_INSTRUMENT_TYPES.has(u.instrumentType),
  );
}

// Slim an unmatched-equity row set down to the fields the rerun residual needs,
// for persistence in analyzerStorage. Mirrors the brokerSummary persistence so
// the hero-trio residual survives a tab-switch / rerun (the rerun synth has no
// access to the original parsed.unmatched).
export function slimUnmatchedForStorage(unmatched) {
  return filterUnmatchedEquity(unmatched).map((u) => ({
    name: u.rawName || u.name || null,
    symbol: u.symbol || null,
    isin: u.isin || null,
    quantity: Number(u.quantity) || 0,
    avgPrice: Number(u.avgPrice) || 0,
    closePrice: Number(u.closePrice) || 0,
    instrumentType: u.instrumentType || "equity",
    reason: u.reason || null,
  }));
}

// Inverse of slimUnmatchedForStorage — rebuild the parsed.unmatched shape from
// persisted rows on /analyze/rerun. matchType is re-stamped "none" (these were
// never resolved at upload time) and rawName restored so the "Not analysed"
// UI section + the residual computation both see what they expect.
export function rebuildUnmatchedFromStored(storedUnmatchedEquity) {
  if (!Array.isArray(storedUnmatchedEquity)) return [];
  return storedUnmatchedEquity.map((u) => ({
    ...u,
    rawName: u.name || u.symbol || null,
    quantity: Number(u.quantity) || 0,
    avgPrice: Number(u.avgPrice) || 0,
    closePrice: Number(u.closePrice) || 0,
    matchType: "none",
  }));
}

// Sum invested (qty*avg) and current (qty*closePrice, falling back to cost when
// no broker close is available) across the unmatched equity rows. Returns
// rounded rupee integers + the row count.
export function computeUnmatchedEquityResidual(unmatched) {
  const rows = filterUnmatchedEquity(unmatched);
  let invested = 0;
  let current = 0;
  for (const u of rows) {
    const qty = Number(u.quantity) || 0;
    const avg = Number(u.avgPrice) || 0;
    const close = Number(u.closePrice) || 0;
    invested += qty * avg;
    current += qty * (close > 0 ? close : avg);
  }
  return {
    count: rows.length,
    invested: Math.round(invested),
    current: Math.round(current),
  };
}
