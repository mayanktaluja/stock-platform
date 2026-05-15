// PR T7 — services/trackRecord/calibration.js unit tests.
//
// Walks the aggregator across three shapes: empty, earnings-style
// (prediction.confidence_pct), and SWS-pick style (v3_score → implied
// hit-probability). Verifies bucket bounds, hit-rate math, thin-data
// flag, and the Wilson CI helper.

import assert from "node:assert/strict";
import { buildCalibration, _internals } from "../services/trackRecord/calibration.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("[1] empty input");
it("returns 5 buckets, all thin, no resolved", () => {
  const out = buildCalibration([]);
  assert.equal(out.buckets.length, 5);
  assert.equal(out.total, 0);
  assert.equal(out.resolved, 0);
  for (const b of out.buckets) {
    assert.equal(b.n, 0);
    assert.equal(b.thin, true);
    assert.equal(b.realised_pct, null);
  }
});

console.log("[2] earnings-style trades");
it("buckets a 75 % confidence forecast into 70–80 and reports realised rate", () => {
  const trades = [];
  for (let i = 0; i < 10; i += 1) {
    trades.push({
      prediction: { confidence_pct: 75 },
      returns: { alphaPct: i < 7 ? 3.5 : -1.2 },
    });
  }
  const out = buildCalibration(trades);
  const b70 = out.buckets.find((b) => b.bucket_low === 70 && b.bucket_high === 80);
  assert.equal(b70.n, 10);
  assert.equal(b70.realised_pct, 70.0);
  assert.equal(b70.thin, true);
  assert.equal(out.resolved, 10);
});

console.log("[3] SWS-pick style trades via v3_score mapping");
it("maps v3_score_100 = 70 to the 60–70 bucket", () => {
  const trades = [];
  for (let i = 0; i < 30; i += 1) {
    trades.push({
      v3_score_100: 70,
      returns: { returnPct: i < 18 ? 4.2 : -2.5 },
    });
  }
  const out = buildCalibration(trades);
  const b60 = out.buckets.find((b) => b.bucket_low === 60 && b.bucket_high === 70);
  assert.equal(b60.n, 30);
  assert.equal(b60.realised_pct, 60.0);
  assert.equal(b60.thin, false);
});

console.log("[4] inferConfidencePct anchors");
it("v3 50 maps to ~50 %", () => {
  const p = _internals.inferConfidencePct({ v3_score_100: 50 });
  assert.equal(p, 50);
});
it("v3 85 maps to ~70 %", () => {
  const p = _internals.inferConfidencePct({ v3_score_100: 85 });
  assert.equal(p, 70);
});
it("v3 < 40 yields null (excluded)", () => {
  const p = _internals.inferConfidencePct({ v3_score_100: 30 });
  assert.equal(p, null);
});

console.log("[5] Wilson CI sanity");
it("CI narrows with N", () => {
  const small = _internals.wilsonCI(5, 10);
  const large = _internals.wilsonCI(500, 1000);
  assert.ok((small.hi - small.lo) > (large.hi - large.lo), "small-n CI should be wider");
  assert.ok(large.lo > 40 && large.hi < 60, "1000-sample 50% should land tight around 50%");
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
