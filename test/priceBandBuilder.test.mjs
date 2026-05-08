/**
 * Tests for services/earnings/priceBandBuilder.js
 *
 * Invariants we never want to break:
 *   - Bull > Base > Bear (monotonic; no inverted bands)
 *   - All bands within ±15% of base (V1 hard cap)
 *   - Anchored output uses the SWS current_price_inr
 *   - Unanchored output drops price_inr but keeps pct
 *   - INSUFFICIENT_DATA passes through cleanly
 *
 * Run with: node test/priceBandBuilder.test.mjs
 */

import { buildPriceBand } from "../services/earnings/priceBandBuilder.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// ──── INSUFFICIENT_DATA → empty band ────
{
  const r = buildPriceBand({ prediction: { verdict: "INSUFFICIENT_DATA" }, signals: {} });
  assert("INSUFFICIENT_DATA → anchored=false, no bull/base/bear", r.anchored === false && r.bull === null && r.bear === null, r);
  assert("INSUFFICIENT_DATA basis = 'insufficient_data'", r.basis === "insufficient_data", r.basis);
}
{
  const r = buildPriceBand({ prediction: null, signals: {} });
  assert("Missing prediction → empty band", r.bull === null && r.base === null && r.bear === null, r);
}

// ──── Anchored BEAT band: bull > base > bear, all within ±15% ────
{
  const r = buildPriceBand({
    prediction: { verdict: "BEAT", confidence_pct: 60 },
    signals: {
      momentum: { ret_1m_pct: 8 },
      upside_pct: 15,
      sws_upcoming_earnings: { current_price_inr: 1000 },
    },
  });
  assert("BEAT anchored=true", r.anchored === true, r);
  assert("BEAT bull > base", r.bull.pct > r.base.pct, { bull: r.bull, base: r.base });
  assert("BEAT base > bear", r.base.pct > r.bear.pct, { base: r.base, bear: r.bear });
  assert("BEAT bull within +15%", r.bull.pct <= 15.0001, r.bull.pct);
  assert("BEAT bear within -15%", r.bear.pct >= -15.0001, r.bear.pct);
  assert("BEAT bull price > current", r.bull.price_inr > 1000, r.bull.price_inr);
  assert("BEAT bear price < current", r.bear.price_inr < 1000, r.bear.price_inr);
}

// ──── MISS band: skewed downward ────
{
  const r = buildPriceBand({
    prediction: { verdict: "MISS", confidence_pct: 60 },
    signals: {
      momentum: { ret_1m_pct: 8 },
      upside_pct: -10,
      sws_upcoming_earnings: { current_price_inr: 500 },
    },
  });
  assert("MISS base pct ≤ 0", r.base.pct <= 0, r.base.pct);
  assert("MISS bull > base > bear monotonic", r.bull.pct > r.base.pct && r.base.pct > r.bear.pct, r);
}

// ──── INLINE band: centred near zero ────
{
  const r = buildPriceBand({
    prediction: { verdict: "INLINE", confidence_pct: 55 },
    signals: {
      momentum: { ret_1m_pct: 5 },
      upside_pct: 0,
      sws_upcoming_earnings: { current_price_inr: 800 },
    },
  });
  assert("INLINE base pct near zero (|x| < 1)", Math.abs(r.base.pct) < 1, r.base.pct);
  assert("INLINE remains monotonic", r.bull.pct > r.base.pct && r.base.pct > r.bear.pct, r);
}

// ──── Unanchored when SWS price missing ────
{
  const r = buildPriceBand({
    prediction: { verdict: "BEAT", confidence_pct: 60 },
    signals: {
      momentum: { ret_1m_pct: 6 },
      upside_pct: 10,
      sws_upcoming_earnings: null,
    },
  });
  assert("Unanchored: anchored=false", r.anchored === false, r);
  assert("Unanchored: bull pct still present", typeof r.bull?.pct === "number", r.bull);
  assert("Unanchored: bull price_inr is null", r.bull?.price_inr === null, r.bull);
}

// ──── Confidence-scaling reduces magnitude at low conf ────
{
  const high = buildPriceBand({
    prediction: { verdict: "BEAT", confidence_pct: 65 },
    signals: { momentum: { ret_1m_pct: 12 }, upside_pct: 30, sws_upcoming_earnings: { current_price_inr: 100 } },
  });
  const low = buildPriceBand({
    prediction: { verdict: "BEAT", confidence_pct: 50 },
    signals: { momentum: { ret_1m_pct: 12 }, upside_pct: 30, sws_upcoming_earnings: { current_price_inr: 100 } },
  });
  // Low-confidence band should be tighter (smaller absolute spread).
  const highSpread = high.bull.pct - high.bear.pct;
  const lowSpread = low.bull.pct - low.bear.pct;
  assert("Lower confidence yields tighter band", lowSpread < highSpread, { low: lowSpread, high: highSpread });
}

// ──── Hard cap at ±15% even with extreme inputs ────
{
  const r = buildPriceBand({
    prediction: { verdict: "BEAT", confidence_pct: 65 },
    signals: {
      momentum: { ret_1m_pct: 100 }, // ridiculous
      upside_pct: 200,
      sws_upcoming_earnings: { current_price_inr: 100 },
    },
  });
  assert("Cap holds: bull.pct ≤ 15", r.bull.pct <= 15.0001, r.bull.pct);
  assert("Cap holds: bear.pct ≥ -15", r.bear.pct >= -15.0001, r.bear.pct);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
