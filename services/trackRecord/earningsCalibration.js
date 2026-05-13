/**
 * earningsCalibration.js — PR E5
 *
 * Per-symbol calibration aggregate for the Earnings Watch card footer:
 * "last N BEAT calls on this stock: H hit, M miss · sector Brier B vs
 * platform Brier P". Surfaced only when priorCallsForSymbol ≥ 3 so we
 * never extrapolate from a single coincidental pick.
 *
 * Inputs:
 *   - history files from services/earnings/earningsHistoryArchive.js
 *     (each row carries .predicted_verdict + .actual_verdict per symbol)
 *   - the snapshot written by scripts/backtest-earnings-predictions.mjs
 *     (carries platform-wide Brier when resolved coverage is sufficient)
 *
 * Output shape, per symbol:
 *   {
 *     priorCallsForSymbol: N,
 *     priorBeatCalls: N_beat,
 *     hitCount:    H,
 *     missCount:   M,
 *     hitRate:     H / N (or null when N=0),
 *     sectorBrier: B  (mean over resolved priors in same sector or null),
 *     platformBrier: P (from the backtest snapshot),
 *   }
 */

export function buildSymbolEarningsCalibration(history, snapshot) {
  const platformBrier = (snapshot && Number.isFinite(snapshot.brier)) ? snapshot.brier : null;

  // First pass — collect per-symbol resolved priors and sector-level squared
  // errors so we can derive sector-Brier locally without rebuilding all of
  // computeCalibration().
  const bySymbol = new Map();
  const sectorSquaredErrors = new Map(); // sector → [se1, se2, ...]
  if (Array.isArray(history)) {
    for (const day of history) {
      const events = Array.isArray(day && day.events) ? day.events : [];
      for (const ev of events) {
        if (!ev || !ev.symbol) continue;
        const sym = String(ev.symbol);
        if (!bySymbol.has(sym)) {
          bySymbol.set(sym, {
            symbol: sym,
            sector: ev.sector || null,
            calls: [],
          });
        }
        const rec = bySymbol.get(sym);
        rec.calls.push({
          predicted: ev.predicted_verdict || null,
          actual: ev.actual_verdict || null,
          confidence: Number.isFinite(ev.predicted_confidence_pct) ? ev.predicted_confidence_pct : null,
        });

        // Per-sector squared-error accumulator (Brier).
        if (ev.sector && Number.isFinite(ev.predicted_confidence_pct) && ev.actual_verdict) {
          const arr = sectorSquaredErrors.get(ev.sector) || [];
          const p = ev.predicted_confidence_pct / 100;
          const outcome = ev.predicted_verdict === ev.actual_verdict ? 1 : 0;
          arr.push(Math.pow(outcome - p, 2));
          sectorSquaredErrors.set(ev.sector, arr);
        }
      }
    }
  }

  const sectorBrier = new Map();
  for (const [sector, arr] of sectorSquaredErrors) {
    if (arr.length === 0) continue;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    sectorBrier.set(sector, +mean.toFixed(3));
  }

  const out = new Map();
  for (const rec of bySymbol.values()) {
    const resolved = rec.calls.filter((c) => c.actual);
    const beatCalls = resolved.filter((c) => c.predicted === "BEAT");
    const hits = resolved.filter((c) => c.predicted === c.actual).length;
    const misses = resolved.length - hits;
    out.set(rec.symbol, {
      symbol: rec.symbol,
      sector: rec.sector,
      priorCallsForSymbol: resolved.length,
      priorBeatCalls: beatCalls.length,
      hitCount: hits,
      missCount: misses,
      hitRate: resolved.length > 0 ? +(hits / resolved.length).toFixed(3) : null,
      sectorBrier: rec.sector ? (sectorBrier.get(rec.sector) ?? null) : null,
      platformBrier,
    });
  }
  return out;
}

export const _internals = { buildSymbolEarningsCalibration };
