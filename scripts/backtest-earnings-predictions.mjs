#!/usr/bin/env node
/**
 * Backtest harness for the earnings predictor.
 *
 * Reads every committed history file under data/catalysts/earnings-
 * history/ and reports calibration metrics: hit-rate overall, by
 * confidence bucket, by predicted verdict, and the V1 confidence-cap
 * lift gate.
 *
 * On day 0 (this commit) the report will be all zeros — we have no
 * resolved actuals yet because the actuals ingester is out of V1
 * scope. The harness exists so:
 *
 *   1. The report runs cleanly with no data — confirms the file
 *      shape is correct ahead of actuals landing.
 *   2. Once actuals start populating (manually-fed by the user or
 *      auto-fed by a Q-end cron once result data ships), the same
 *      script runs without modification and starts producing
 *      meaningful numbers.
 *
 * Usage:
 *   node scripts/backtest-earnings-predictions.mjs
 *   node scripts/backtest-earnings-predictions.mjs --json   # machine-readable
 *
 * Exit codes:
 *   0  ran successfully (regardless of how much data is in)
 *   1  fatal error reading history dir
 */

import {
  loadAllHistory,
  computeCalibration,
} from "../services/earnings/earningsHistoryArchive.js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argJson = process.argv.includes("--json");
const argNoSnapshot = process.argv.includes("--no-snapshot");

// PR B8 — writes data/catalysts/earnings-backtest-latest.json on every
// run so /api/earnings/backtest serves a fresh snapshot without re-running
// the script. Pass --no-snapshot to suppress (useful for ad-hoc debugging).
const _here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(_here, "..", "data", "catalysts");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "earnings-backtest-latest.json");
function writeSnapshot(history, cal) {
  if (argNoSnapshot) return;
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const resolved = cal && Number.isFinite(cal.resolved_count) ? cal.resolved_count : 0;
    const expected = (cal && Number.isFinite(cal.unresolved_count) ? cal.unresolved_count : 0) + resolved;
    const snapshot = {
      schema_version: "earnings-backtest-v1",
      generated_at: new Date().toISOString(),
      history_files: history.length,
      span: history.length
        ? { from: history[0].today_iso, to: history[history.length - 1].today_iso }
        : null,
      resolved_count: resolved,
      expected_count: expected,
      brier: cal && cal.brier_score != null ? +cal.brier_score.toFixed(3) : null,
      brier_last_quarter: cal && cal.brier_score_last_quarter != null ? +cal.brier_score_last_quarter.toFixed(3) : null,
      hit_rate_overall_pct: cal && cal.hit_rate_overall_pct != null ? cal.hit_rate_overall_pct : null,
      hit_rate_by_confidence_bucket: cal ? cal.hit_rate_by_confidence_bucket : null,
      hit_rate_by_verdict: cal ? cal.hit_rate_by_verdict : null,
      v1_gate: cal ? cal.cap_lift_gate : null,
      enough_data_to_lift_cap: !!(cal && cal.enough_data_to_lift_cap),
    };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
    if (!argJson) console.log(`Snapshot written: ${SNAPSHOT_PATH}`);
  } catch (err) {
    console.warn(`[BACKTEST] snapshot write failed: ${err && err.message}`);
  }
}

function pctOrDash(v) {
  return v == null ? "—" : `${v}%`;
}

function fmtBucket(map) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return "  (no buckets populated)";
  return keys
    .map((k) => `  ${k.padEnd(6)} → ${pctOrDash(map[k])}`)
    .join("\n");
}

function main() {
  const history = loadAllHistory();
  if (history.length === 0) {
    writeSnapshot([], null);
    if (argJson) {
      console.log(JSON.stringify({
        history_files: 0,
        message: "no history files yet — run scripts/refresh-earnings.mjs first",
      }, null, 2));
    } else {
      console.log("No history files found.");
      console.log(`Run \`node scripts/refresh-earnings.mjs\` first to write the first snapshot.`);
    }
    return;
  }

  const cal = computeCalibration(history);
  writeSnapshot(history, cal);

  if (argJson) {
    console.log(JSON.stringify({
      history_files: history.length,
      span: history.length
        ? `${history[0].today_iso} → ${history[history.length - 1].today_iso}`
        : null,
      calibration: cal,
    }, null, 2));
    return;
  }

  // ── Human-readable report ──
  const span = `${history[0].today_iso} → ${history[history.length - 1].today_iso}`;
  console.log(`Earnings Predictor — Backtest Report`);
  console.log(`====================================`);
  console.log(`History files:     ${history.length}`);
  console.log(`Span:              ${span}`);
  console.log(`Resolved events:   ${cal.resolved_count}`);
  console.log(`Unresolved events: ${cal.unresolved_count}`);
  console.log(``);
  console.log(`Overall hit rate:  ${pctOrDash(cal.hit_rate_overall_pct)}`);
  console.log(`Brier score:       ${cal.brier_score == null ? "—" : cal.brier_score.toFixed(3)}  (lower is better)`);
  console.log(``);
  console.log(`Hit rate by confidence bucket:`);
  console.log(fmtBucket(cal.hit_rate_by_confidence_bucket));
  console.log(``);
  console.log(`Hit rate by predicted verdict:`);
  console.log(fmtBucket(cal.hit_rate_by_verdict));
  console.log(``);
  console.log(`V1 confidence-cap lift gate:`);
  console.log(`  resolved ≥ ${cal.cap_lift_gate.resolved_required}        : ${cal.cap_lift_gate.current_resolved} ${cal.cap_lift_gate.current_resolved >= cal.cap_lift_gate.resolved_required ? "✅" : "❌"}`);
  console.log(`  60-64 bucket ≥ ${cal.cap_lift_gate.bucket_60_64_hit_rate_required}%   : ${cal.cap_lift_gate.current_bucket_60_64_hit_rate}% ${cal.cap_lift_gate.current_bucket_60_64_hit_rate >= cal.cap_lift_gate.bucket_60_64_hit_rate_required ? "✅" : "❌"}`);
  console.log(`  Brier < ${cal.cap_lift_gate.max_brier_required}         : ${cal.cap_lift_gate.current_brier == null ? "—" : cal.cap_lift_gate.current_brier.toFixed(3)} ${(cal.cap_lift_gate.current_brier ?? 1) < cal.cap_lift_gate.max_brier_required ? "✅" : "❌"}`);
  console.log(``);
  console.log(`READY TO LIFT CAP:  ${cal.enough_data_to_lift_cap ? "YES" : "NO"}`);

  if (!cal.enough_data_to_lift_cap && cal.unresolved_count > 0) {
    console.log(``);
    console.log(`Note: ${cal.unresolved_count} unresolved events. Once actuals are`);
    console.log(`      filled in (post-Q4 results, ~mid-July 2026 for Q4 FY26),`);
    console.log(`      re-run this report.`);
  }
}

try {
  main();
} catch (err) {
  console.error(`backtest FAILED:`, err.stack || err.message);
  process.exitCode = 1;
}
