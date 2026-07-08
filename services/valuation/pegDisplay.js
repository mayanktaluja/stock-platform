// PEG (Price/Earnings-to-Growth) display resolver.
//
// WHY THIS EXISTS
// ---------------
// The Quick Stats modal used to render Groww/Refinitiv's raw `pegRatio` field
// directly, showing "Not meaningful" whenever that value was <= 0. That field
// is UNSTABLE: PEG = P/E ÷ earnings-growth%, and Groww's growth denominator
// frequently dips to near-zero or slightly negative, so the raw field emits
// large-magnitude or negative garbage even for healthy companies. Observed in
// the 2026-06-11 Groww cache: 1455 / 3976 tickers (37%) carried a negative
// pegRatio, including blue-chips — POWERGRID −58 (P/E 16.8, +EPS), SUPREMEIND
// −70, APARINDS −59, BPCL, PNB, IOC, HINDPETRO, BANKBARODA — and JSLL flipped
// negative in production despite +178% TTM profit growth (Screener.in,
// 07-Jul-2026). None of those are genuinely "not meaningful"; they are a flaky
// upstream field surfaced verbatim. An audit of 5561 deep-briefed stocks found
// ~493 in this false-"Not meaningful" state.
//
// PEG is only defined for POSITIVE earnings growth. So a non-positive raw value
// is not a real signal — before declaring "Not meaningful" we recompute PEG
// from P/E ÷ a robust earnings-growth basis, tried in order:
//   1. a smoothed multi-year net-income CAGR (SWS fiscal.yearly_history), else
//   2. a smoothed CAGR off Groww's yearly profit series, else
//   3. trailing YoY earnings growth.
// "Not meaningful" is reserved for the genuine case: earnings flat/shrinking or
// no growth series at all, so no positive-growth PEG can be formed.
//
// SCOPE: display only. The live V4 composite (services/swsScoringV4.js) does
// not use PEG at all, and fundamentalsV2.js's legacy PEG sub-score already
// gates on `pegRatio > 0`, so this resolver changes nothing about any score.
//
// The gated/app.js modal inlines this exact algorithm (it is a plain browser
// script and cannot import this module); test/pegDisplayAppParity.test.mjs
// guards the two copies against drift.

// Displayed PEG is capped here. Beyond ~20 the growth is so weak relative to the
// multiple that PEG carries no valuation signal — treat as "Not meaningful".
export const PEG_DISPLAY_CAP = 20;

// Minimum P/E required to recompute a PEG. A trailing P/E below ~3 on an Indian
// equity is almost always a data artefact — a one-off extraordinary gain
// inflating TTM EPS, or a stale price/EPS — and dividing it by growth just
// manufactures a fake sub-0.1 "bargain" PEG (seen on RELINFRA 0.73, GENSOL 1.08,
// KOHINOOR 1.08). 3.0 sits in the clean gap below the cheapest legitimate names
// (IOC 4.4, BPCL 4.8, PSU banks 5-7), so it drops the broken rows to "Not
// meaningful" without touching real deep-value stocks. Only gates the recompute
// path; a positive raw Groww peg still shows verbatim.
export const PEG_MIN_PE = 3;

function num(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

/**
 * Smoothed multi-year earnings CAGR (%) from a newest-first history whose rows
 * carry `netIncome` (and optionally `year`). Requires >=3 finite points and a
 * positive value at BOTH endpoints (a CAGR across a sign flip is meaningless).
 * Uses the actual year span between endpoints when years are known (so gaps in
 * the series don't distort the annualisation), else the point count. Scale-
 * invariant, so ₹ vs ₹-crore inputs are fine. A negative-but-valid CAGR
 * (shrinking earnings, both endpoints positive) is returned as-is so the caller
 * can reject it rather than fall back to a spikier figure.
 *
 * @param {Array<{netIncome?: number, year?: number}>|null} history
 * @returns {number|null}
 */
export function netIncomeCagrPct(history) {
  if (!Array.isArray(history)) return null;
  const pts = history
    .map((r) =>
      r && Number.isFinite(Number(r.netIncome))
        ? { year: Number.isFinite(Number(r.year)) ? Number(r.year) : null, ni: Number(r.netIncome) }
        : null,
    )
    .filter(Boolean);
  if (pts.length < 3) return null;
  const newest = pts[0];
  const oldest = pts[pts.length - 1];
  if (!(newest.ni > 0) || !(oldest.ni > 0)) return null;
  const yearSpan =
    newest.year != null && oldest.year != null && newest.year - oldest.year >= 2
      ? newest.year - oldest.year
      : pts.length - 1;
  const cagr = (Math.pow(newest.ni / oldest.ni, 1 / yearSpan) - 1) * 100;
  return Number.isFinite(cagr) ? cagr : null;
}

/**
 * Groww's `{year: profit}` map → newest-first `[{year, netIncome}]` rows so it
 * can feed netIncomeCagrPct. Years with non-finite values are dropped.
 * @param {Object<string, number>|null} profitMap
 * @returns {Array<{year:number, netIncome:number}>|null}
 */
export function growwProfitToHistory(profitMap) {
  if (!profitMap || typeof profitMap !== "object") return null;
  const rows = Object.keys(profitMap)
    .map((y) => ({ year: Number(y), netIncome: Number(profitMap[y]) }))
    .filter((r) => Number.isFinite(r.year) && Number.isFinite(r.netIncome))
    .sort((a, b) => b.year - a.year); // newest-first
  return rows.length ? rows : null;
}

/**
 * Resolve the PEG value to display in the Quick Stats modal.
 *
 * @param {object} args
 * @param {number|null} args.growwPeg              Raw Groww/Refinitiv pegRatio (already source-gated by the caller). null = no Groww coverage.
 * @param {number|null} args.pe                    Reliable trailing P/E.
 * @param {Array|null}  args.netIncomeHistory      Newest-first rows carrying `netIncome` (SWS fiscal.yearly_history).
 * @param {Object|null} args.growwProfit           Groww `{year: profit}` map (fallback growth series).
 * @param {number|null} args.yoyEarningsGrowthPct  Last-resort single-year earnings growth %.
 * @returns {{ peg: number|null, basis: 'refinitiv'|'computed'|'not_meaningful'|null, value: string|null }}
 *   basis/value semantics:
 *     null            → no Groww coverage; the PEG row is omitted entirely.
 *     'refinitiv'     → Groww's positive raw value, shown verbatim (unchanged behaviour).
 *     'computed'      → recomputed P/E ÷ growth% because the raw value was non-positive.
 *     'not_meaningful'→ genuine: earnings flat/shrinking / no growth series, no positive-growth PEG possible.
 */
export function resolvePegDisplay({
  growwPeg = null,
  pe = null,
  netIncomeHistory = null,
  growwProfit = null,
  yoyEarningsGrowthPct = null,
} = {}) {
  const raw = num(growwPeg);
  if (raw == null) return { peg: null, basis: null, value: null };
  if (raw > 0) return { peg: raw, basis: "refinitiv", value: raw.toFixed(2) };

  // raw <= 0 → the flaky field went non-positive. Try to recompute a real PEG.
  const peNum = num(pe);
  const growth = firstFinite(
    netIncomeCagrPct(netIncomeHistory),
    netIncomeCagrPct(growwProfitToHistory(growwProfit)),
    yoyEarningsGrowthPct,
  );
  if (peNum != null && peNum >= PEG_MIN_PE && growth != null && growth > 0) {
    const computed = peNum / growth;
    if (computed > 0 && computed <= PEG_DISPLAY_CAP) {
      return { peg: computed, basis: "computed", value: computed.toFixed(2) };
    }
  }
  return { peg: null, basis: "not_meaningful", value: "Not meaningful" };
}
