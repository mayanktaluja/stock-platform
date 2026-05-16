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
import {
  COMPONENT_KEYS,
  rescoreUnderMultipliers,
} from "../services/earnings/weightTuner.js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argJson = process.argv.includes("--json");
const argNoSnapshot = process.argv.includes("--no-snapshot");
const argAblation = process.argv.includes("--ablation");

// PR B8 — writes data/catalysts/earnings-backtest-latest.json on every
// run so /api/earnings/backtest serves a fresh snapshot without re-running
// the script. Pass --no-snapshot to suppress (useful for ad-hoc debugging).
const _here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(_here, "..", "data", "catalysts");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "earnings-backtest-latest.json");
const ABLATION_PATH = path.join(SNAPSHOT_DIR, "ablation-latest.json");
function writeSnapshot(history, cal) {
  if (argNoSnapshot) return;
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const resolved = cal && Number.isFinite(cal.resolved_count) ? cal.resolved_count : 0;
    const expected = (cal && Number.isFinite(cal.unresolved_count) ? cal.unresolved_count : 0) + resolved;
    const snapshot = {
      schema_version: "earnings-backtest-v2",
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
      // v2 — never average across predictor versions; surface the
      // per-version breakdown so a weight change stays auditable.
      by_predictor_version: cal && cal.by_predictor_version ? cal.by_predictor_version : null,
      latest_predictor_version: cal && cal.latest_predictor_version ? cal.latest_predictor_version : null,
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

/* ──────────────── P2.5 — component ablation ─────────────────────── */

/**
 * Deduped resolved+breakdown rows for ablation. Same dedup rule as
 * the weight tuner: keep one row per (symbol, event_iso_date),
 * preferring the latest snapshot. We need both `actual_verdict`
 * (to score against) and `score_breakdown` (to re-score). Rows
 * missing the breakdown are counted as `skipped_no_breakdown` so
 * the user knows why the eligible-N differs from the headline
 * resolved count.
 */
function dedupResolvedWithBreakdown(history) {
  const byKey = new Map();
  let skippedNoBreakdown = 0;
  let totalResolved = 0;
  for (const day of history || []) {
    const todayIso = day.today_iso || day.filename || "";
    for (const r of day.predictions || []) {
      if (!r || !r.actual_verdict) continue;
      totalResolved += 1;
      if (!r.score_breakdown) { skippedNoBreakdown += 1; continue; }
      const key = `${r.symbol}|${r.event_iso_date}`;
      const existing = byKey.get(key);
      if (!existing || todayIso >= existing._today_iso) {
        byKey.set(key, { ...r, _today_iso: todayIso });
      }
    }
  }
  return {
    rows: [...byKey.values()],
    total_resolved: totalResolved,
    skipped_no_breakdown: skippedNoBreakdown,
  };
}

/**
 * Compute baseline + per-component hit-rate when each component's
 * weight multiplier is zeroed. The most-important component is the
 * one whose removal causes the largest absolute hit-rate change
 * (positive OR negative — a strongly anti-correlated component would
 * register as important too, surfaced as a positive delta when
 * removed). Sorts components by abs(delta) descending and assigns
 * importance_rank starting at 1.
 *
 * Reuses each archived prediction's stored `score_breakdown`; never
 * re-fetches SWS data. Older rows missing the breakdown are skipped
 * (count surfaced in the snapshot).
 */
function runAblation(history) {
  const { rows, total_resolved, skipped_no_breakdown } = dedupResolvedWithBreakdown(history);

  const baselineHitRate = computeHitRateForMultipliers(rows, {});
  const components = COMPONENT_KEYS.map((name) => {
    const hr = computeHitRateForMultipliers(rows, { [name]: 0 });
    return {
      name,
      hit_rate_without: hr,
      delta_vs_baseline: hr == null || baselineHitRate == null
        ? null
        : Math.round((hr - baselineHitRate) * 10) / 10,
    };
  });
  // Sort by abs(delta) descending (null deltas sink to the bottom).
  components.sort((a, b) => {
    const aa = a.delta_vs_baseline == null ? -Infinity : Math.abs(a.delta_vs_baseline);
    const bb = b.delta_vs_baseline == null ? -Infinity : Math.abs(b.delta_vs_baseline);
    return bb - aa;
  });
  components.forEach((c, i) => { c.importance_rank = i + 1; });

  return {
    schema_version: "ablation-v1",
    generated_at: new Date().toISOString(),
    history_files: history.length,
    span: history.length
      ? { from: history[0].today_iso, to: history[history.length - 1].today_iso }
      : null,
    baseline_hit_rate: baselineHitRate,
    baseline_sample_size: rows.length,
    total_resolved,
    skipped_no_breakdown,
    components,
    note:
      "Ablation re-scores each archived prediction with one component " +
      "weight set to zero, then compares the hit-rate against baseline. " +
      "Components are ranked by abs(delta) — highest absolute delta is " +
      "the most-impactful component. score_breakdown only entered the " +
      "archive in schema v4; pre-v4 resolved rows are skipped.",
  };
}

function computeHitRateForMultipliers(rows, multipliers) {
  if (!rows || rows.length === 0) return null;
  let hits = 0;
  for (const r of rows) {
    const { verdict } = rescoreUnderMultipliers(r.score_breakdown, multipliers);
    if (verdict === r.actual_verdict) hits += 1;
  }
  return Math.round((hits / rows.length) * 1000) / 10;
}

function writeAblation(ablation) {
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(ABLATION_PATH, JSON.stringify(ablation, null, 2) + "\n");
    if (!argJson) console.log(`Ablation snapshot written: ${ABLATION_PATH}`);
  } catch (err) {
    console.warn(`[BACKTEST] ablation write failed: ${err && err.message}`);
  }
}

function printAblation(ablation) {
  console.log("");
  console.log("Component Ablation");
  console.log("==================");
  console.log(`Baseline hit-rate: ${pctOrDash(ablation.baseline_hit_rate)}  (n=${ablation.baseline_sample_size})`);
  console.log(`Resolved skipped (no score_breakdown): ${ablation.skipped_no_breakdown}`);
  console.log("");
  if (ablation.baseline_sample_size === 0) {
    console.log("No eligible rows — ablation skipped.");
    console.log("(Need >=1 resolved actual whose archive row carries score_breakdown, i.e. schema v4+.)");
    return;
  }
  console.log("Rank  Component               HR(without)  Δ vs baseline");
  console.log("----  ----------------------  -----------  -------------");
  for (const c of ablation.components) {
    const hr = c.hit_rate_without == null ? "—" : `${c.hit_rate_without}%`;
    const d = c.delta_vs_baseline == null ? "—" : (c.delta_vs_baseline > 0 ? `+${c.delta_vs_baseline}` : `${c.delta_vs_baseline}`);
    console.log(`${String(c.importance_rank).padStart(4)}  ${c.name.padEnd(22)}  ${hr.padStart(11)}  ${d.padStart(13)}`);
  }
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
    if (argAblation) writeAblation(runAblation([]));
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

  // P2.5 — component ablation (additive; only runs with --ablation).
  let ablation = null;
  if (argAblation) {
    ablation = runAblation(history);
    writeAblation(ablation);
  }

  if (argJson) {
    const payload = {
      history_files: history.length,
      span: history.length
        ? `${history[0].today_iso} → ${history[history.length - 1].today_iso}`
        : null,
      calibration: cal,
    };
    if (argAblation) payload.ablation = ablation;
    console.log(JSON.stringify(payload, null, 2));
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

  if (argAblation && ablation) printAblation(ablation);
}

try {
  main();
} catch (err) {
  console.error(`backtest FAILED:`, err.stack || err.message);
  process.exitCode = 1;
}
