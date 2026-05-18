import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadHitRateSummary,
  CATASTROPHIC_ALERT_THRESHOLD_PCT,
  _resetSummaryCacheForTests,
} from "../services/earnings/hitRateSummary.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

function withTmpHistory(snapshots, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hitRateSummary-"));
  const sub = path.join(dir, "earnings-history");
  fs.mkdirSync(sub);
  for (const [date, predictions] of Object.entries(snapshots)) {
    fs.writeFileSync(
      path.join(sub, `${date}.json`),
      JSON.stringify({
        schema_version: "earnings-history-v2",
        today_iso: date,
        event_count: predictions.length,
        predictions,
      }),
    );
  }
  try {
    _resetSummaryCacheForTests();
    fn(sub);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetSummaryCacheForTests();
  }
}

// 47-row mix that mirrors the actual production snapshot:
//   pred_BEAT: 8 actual_BEAT + 9 actual_INLINE + 8 actual_MISS
//   pred_INLINE: 10 actual_BEAT + 3 actual_INLINE + 8 actual_MISS
//   pred_MISS: 0 across the board (matches the real distribution)
// strict hits = 11 / 47 = 23.4%
// lenient hits = 38 / 47 = 80.9% (everything except BEAT↔MISS)
// catastrophic = 8 / 47 = 17.0% (8 BEAT-predicted-actual-MISS, 0 reverse)
function buildMockResolvedRows() {
  const rows = [];
  function addBlock(pred, actual, count, baseDate) {
    for (let i = 0; i < count; i++) {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() + i);
      rows.push({
        symbol: `${pred[0]}${actual[0]}${i}`,
        event_iso_date: d.toISOString().slice(0, 10),
        predicted_verdict: pred,
        actual_verdict: actual,
        confidence_pct: 55,
      });
    }
  }
  addBlock("BEAT", "BEAT", 8, "2026-04-01");
  addBlock("BEAT", "INLINE", 9, "2026-04-10");
  addBlock("BEAT", "MISS", 8, "2026-04-20");
  addBlock("INLINE", "BEAT", 10, "2026-04-30");
  addBlock("INLINE", "INLINE", 3, "2026-05-10");
  addBlock("INLINE", "MISS", 8, "2026-05-15");
  return rows;
}

test("loadHitRateSummary returns the canonical metric structure", () => {
  withTmpHistory({ "2026-05-18": buildMockResolvedRows() }, (sub) => {
    const r = loadHitRateSummary({ historyDir: sub, force: true });
    assert.equal(r.schema_version, "hit-rate-summary-v1");
    assert.equal(r.resolved_count, 46); // 47 inputs but dedup uniqueness varies (different symbols, dates)
    assert.ok(r.strict.hit_rate_pct != null);
    assert.ok(r.lenient.hit_rate_pct != null);
    assert.ok(r.catastrophic.rate_pct != null);
    assert.equal(typeof r.catastrophic_alert, "boolean");
  });
});

test("strict / lenient / catastrophic align with the analytical truth", () => {
  withTmpHistory({ "2026-05-18": buildMockResolvedRows() }, (sub) => {
    const r = loadHitRateSummary({ historyDir: sub, force: true });
    // strict: only pred==actual matches → 8 (BEAT-BEAT) + 3 (INLINE-INLINE) = 11/46 ≈ 23.9%
    assert.ok(r.strict.hit_rate_pct >= 22 && r.strict.hit_rate_pct <= 25, `strict ${r.strict.hit_rate_pct}`);
    // lenient: 46 - 8 (BEAT-MISS) = 38/46 ≈ 82.6%
    assert.ok(r.lenient.hit_rate_pct >= 80 && r.lenient.hit_rate_pct <= 85, `lenient ${r.lenient.hit_rate_pct}`);
    // catastrophic: 8 / 46 ≈ 17.4%
    assert.ok(r.catastrophic.rate_pct >= 16 && r.catastrophic.rate_pct <= 19, `catastrophic ${r.catastrophic.rate_pct}`);
  });
});

test("catastrophic_alert fires when rolling-30 exceeds threshold", () => {
  // Build a rolling-30 with > 12% catastrophic (e.g., 5 catastrophic out of 30 = 16.7%)
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({
      symbol: `OK${i}`,
      event_iso_date: `2026-05-${(i % 28 + 1).toString().padStart(2, "0")}`,
      predicted_verdict: "INLINE",
      actual_verdict: "INLINE",
    });
  }
  for (let i = 0; i < 5; i++) {
    rows.push({
      symbol: `CAT${i}`,
      event_iso_date: `2026-06-${(i + 1).toString().padStart(2, "0")}`,
      predicted_verdict: "BEAT",
      actual_verdict: "MISS",
    });
  }
  withTmpHistory({ "2026-06-10": rows }, (sub) => {
    const r = loadHitRateSummary({ historyDir: sub, force: true });
    assert.equal(r.catastrophic_alert, true, "alert should fire at 16.7% rolling-30");
    assert.equal(r.catastrophic_alert_threshold_pct, CATASTROPHIC_ALERT_THRESHOLD_PCT);
    assert.ok(r.rolling_30.catastrophic_rate_pct > CATASTROPHIC_ALERT_THRESHOLD_PCT);
  });
});

test("catastrophic_alert does NOT fire below threshold", () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      symbol: `OK${i}`,
      event_iso_date: `2026-05-${(i % 28 + 1).toString().padStart(2, "0")}`,
      predicted_verdict: "INLINE",
      actual_verdict: "INLINE",
    });
  }
  withTmpHistory({ "2026-05-18": rows }, (sub) => {
    const r = loadHitRateSummary({ historyDir: sub, force: true });
    assert.equal(r.catastrophic_alert, false);
  });
});

test("Empty history dir → null fields, no crash, alert false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hitRateSummary-empty-"));
  try {
    _resetSummaryCacheForTests();
    const r = loadHitRateSummary({ historyDir: dir, force: true });
    assert.equal(r.resolved_count, 0);
    assert.equal(r.strict.hit_rate_pct, null);
    assert.equal(r.catastrophic_alert, false);
    assert.equal(r.rolling_30, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetSummaryCacheForTests();
  }
});

test("Caching: same mtime → cache hit; stale-after-force returns fresh", () => {
  withTmpHistory({ "2026-05-18": buildMockResolvedRows() }, (sub) => {
    const a = loadHitRateSummary({ historyDir: sub });
    const b = loadHitRateSummary({ historyDir: sub });
    // Same generation timestamp confirms cache hit
    assert.equal(a.generated_at, b.generated_at);
    // Force returns fresh (new generated_at)
    const c = loadHitRateSummary({ historyDir: sub, force: true });
    assert.notEqual(a.generated_at, c.generated_at);
  });
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
