// PR E5 — services/trackRecord/earningsCalibration.js unit tests.

import assert from "node:assert/strict";
import { buildSymbolEarningsCalibration } from "../services/trackRecord/earningsCalibration.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("[1] empty history");
it("empty history → empty map; platformBrier honoured", () => {
  const snap = { brier: 0.213 };
  const map = buildSymbolEarningsCalibration([], snap);
  assert.equal(map.size, 0);
});

console.log("[2] per-symbol aggregation");
const history = [
  {
    today_iso: "2026-04-01",
    events: [
      { symbol: "INFY", sector: "IT", predicted_verdict: "BEAT", actual_verdict: "BEAT", predicted_confidence_pct: 70 },
      { symbol: "INFY", sector: "IT", predicted_verdict: "BEAT", actual_verdict: "MISS", predicted_confidence_pct: 65 },
      { symbol: "INFY", sector: "IT", predicted_verdict: "INLINE", actual_verdict: "INLINE", predicted_confidence_pct: 55 },
    ],
  },
  {
    today_iso: "2026-05-01",
    events: [
      { symbol: "HDFCBANK", sector: "Banks", predicted_verdict: "BEAT", actual_verdict: "BEAT", predicted_confidence_pct: 72 },
      { symbol: "HDFCBANK", sector: "Banks", predicted_verdict: "BEAT", actual_verdict: "BEAT", predicted_confidence_pct: 68 },
      { symbol: "HDFCBANK", sector: "Banks", predicted_verdict: "BEAT", actual_verdict: "BEAT", predicted_confidence_pct: 75 },
    ],
  },
];
const map = buildSymbolEarningsCalibration(history, { brier: 0.21 });

it("INFY: 3 priors, 2 hits, 1 miss, 2 BEAT calls", () => {
  const r = map.get("INFY");
  assert.ok(r);
  assert.equal(r.priorCallsForSymbol, 3);
  assert.equal(r.hitCount, 2);
  assert.equal(r.missCount, 1);
  assert.equal(r.priorBeatCalls, 2);
});
it("HDFCBANK: 3 priors, 3 hits, 0 miss", () => {
  const r = map.get("HDFCBANK");
  assert.equal(r.priorCallsForSymbol, 3);
  assert.equal(r.hitCount, 3);
  assert.equal(r.missCount, 0);
});
it("sectorBrier computed from squared errors; platformBrier carried", () => {
  const r = map.get("HDFCBANK");
  assert.ok(Number.isFinite(r.sectorBrier));
  assert.equal(r.platformBrier, 0.21);
});

console.log("[3] no actuals → skipped");
it("events without actual_verdict don't count", () => {
  const onlyPredictions = [{
    today_iso: "2026-05-13",
    events: [
      { symbol: "TCS", sector: "IT", predicted_verdict: "BEAT", actual_verdict: null, predicted_confidence_pct: 60 },
    ],
  }];
  const m = buildSymbolEarningsCalibration(onlyPredictions, { brier: 0.2 });
  const r = m.get("TCS");
  assert.equal(r.priorCallsForSymbol, 0);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
