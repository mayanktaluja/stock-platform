// Unit tests for the V4 verdict-cutoff drift monitor (pure functions only —
// no file/universe I/O). Locks the percentile math and the material-drift flag.

import assert from "node:assert";
import { scoreAtPercentile, computeDrift } from "../scripts/monitor-v4-cutoff-drift.mjs";

let passed = 0;
function t(name, fn) { fn(); passed++; }

t("scoreAtPercentile interpolates on a sorted ascending distribution", () => {
  const s = [0, 25, 50, 75, 100];
  assert.strictEqual(scoreAtPercentile(s, 0), 0);
  assert.strictEqual(scoreAtPercentile(s, 100), 100);
  assert.strictEqual(scoreAtPercentile(s, 50), 50);   // middle element
  assert.strictEqual(scoreAtPercentile(s, 25), 25);
  assert.strictEqual(scoreAtPercentile([42], 50), 42); // single element
  assert.strictEqual(scoreAtPercentile([], 50), null); // empty
});

t("computeDrift: a distribution whose percentiles MATCH the frozen cutoffs → no drift", () => {
  // Build a distribution where the 92/75/50/25 pcts land exactly on 59/47/37/28.
  // Simple: linear ramp so percentile p → score = min + (max-min)*p/100.
  // Solve so that p=50→37 and p=25→28 etc. Use an explicit small set that hits them.
  // Easiest: replicate the frozen values at their intended fractions in a big array.
  const scores = [];
  for (let i = 0; i < 1000; i++) {
    const pct = (i / 999) * 100;
    // piecewise-linear anchored at the 4 intended points + endpoints
    let v;
    if (pct <= 25) v = 20 + (28 - 20) * (pct / 25);
    else if (pct <= 50) v = 28 + (37 - 28) * ((pct - 25) / 25);
    else if (pct <= 75) v = 37 + (47 - 37) * ((pct - 50) / 25);
    else if (pct <= 92) v = 47 + (59 - 47) * ((pct - 75) / 17);
    else v = 59 + (70 - 59) * ((pct - 92) / 8);
    scores.push(v);
  }
  const d = computeDrift(scores);
  assert.strictEqual(d.universe_size, 1000);
  assert.strictEqual(d.drift_detected, false);
  for (const r of d.rows) assert.ok(Math.abs(r.drift_points) < 5, `${r.verdict} drift ${r.drift_points} should be < 5`);
});

t("computeDrift: a materially shifted distribution → drift_detected + material rows", () => {
  // Everything scores ~20 points higher than the frozen calibration → the 50th
  // percentile now lands well above the ACCEPTABLE cutoff of 37.
  const scores = Array.from({ length: 1000 }, (_, i) => 40 + (i / 999) * 40); // 40..80
  const d = computeDrift(scores);
  assert.strictEqual(d.drift_detected, true);
  const acc = d.rows.find((r) => r.verdict === "ACCEPTABLE");
  assert.ok(acc.score_at_intended_percentile_now > 42, "50th pct should be well above 37");
  assert.strictEqual(acc.material, true);
});

t("computeDrift: empty scores → null drifts, not a crash", () => {
  const d = computeDrift([]);
  assert.strictEqual(d.universe_size, 0);
  assert.strictEqual(d.drift_detected, false);
  for (const r of d.rows) assert.strictEqual(r.drift_points, null);
});

console.log(`monitorV4CutoffDrift: ${passed} tests passed`);
