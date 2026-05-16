#!/usr/bin/env node
/**
 * Earnings predictor — weight-tuning sweep harness.
 *
 * Re-scores resolved archived predictions under candidate component-
 * weight MULTIPLIER configs and ranks them by hit-rate (Brier
 * tiebreak), with a per-sector breakdown and a held-out 20% check.
 *
 * It NEVER edits earningsPredictor.js — it recommends directional
 * shifts; a human applies them. And it refuses to recommend anything
 * until the validation gate clears:
 *   - >= 80 resolved actuals
 *   - across >= 2 fiscal quarters
 *   - >= 5 sectors with >= 10 resolved events each
 * (see services/earnings/weightTuner.js for the why).
 *
 * As of this PR the archive holds 47 resolved actuals from a single
 * quarter — the gate is firmly NOT met. That is expected: this ships
 * the machinery so a future run (post-Q1-FY27 results) produces a real
 * recommendation with no further code change.
 *
 * Output: data/catalysts/earnings-weight-tuning.json — reviewed by a
 * human before any predictor weight is touched.
 *
 * Usage:
 *   node scripts/tune-earnings-weights.mjs
 *   node scripts/tune-earnings-weights.mjs --json
 *
 * Exit codes:
 *   0  ran (whether or not the gate was met)
 *   1  fatal error
 */

import fs from "node:fs";
import path from "node:path";

import { loadAllHistory } from "../services/earnings/earningsHistoryArchive.js";
import {
  selectResolvedForTuning,
  checkTuningGate,
  buildCandidateConfigs,
  rankConfigs,
  evaluateConfig,
  splitTrainHoldoutRandom,
  splitTrainHoldoutWalkForward,
  walkForwardEvaluate,
} from "../services/earnings/weightTuner.js";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "data", "catalysts", "earnings-weight-tuning.json");
const argJson = process.argv.includes("--json");

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function main() {
  const history = loadAllHistory();
  const rows = selectResolvedForTuning(history);
  const gate = checkTuningGate(rows);

  const base = {
    schema_version: "earnings-weight-tuning-v1",
    generated_at: new Date().toISOString(),
    gate_met: gate.met,
    gate,
  };

  // ── Gate not met — report the gap, recommend nothing ──
  if (!gate.met) {
    const report = {
      ...base,
      recommendation: null,
      message:
        `Validation gate NOT met — ${gate.resolved_count}/${gate.detail.need_resolved} resolved rows ` +
        `with score_breakdown, ${gate.distinct_quarters}/${gate.detail.need_quarters} quarters, ` +
        `${gate.sectors_with_min_events}/${gate.detail.need_sectors_with_events} sectors with ` +
        `>= ${gate.detail.sector_min_events} events. No weight recommendation until it clears. ` +
        `(score_breakdown entered the archive in schema v4 — only post-v4 resolved events count.)`,
    };
    writeJsonAtomic(OUT_PATH, report);
    if (argJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("Earnings Weight Tuner — Validation Gate");
      console.log("=======================================");
      console.log(`Resolved rows w/ score_breakdown: ${gate.resolved_count} / ${gate.detail.need_resolved}`);
      console.log(`Distinct fiscal quarters:         ${gate.distinct_quarters} / ${gate.detail.need_quarters}  (${gate.detail.quarters.join(", ") || "—"})`);
      console.log(`Sectors with >= ${gate.detail.sector_min_events} events:          ${gate.sectors_with_min_events} / ${gate.detail.need_sectors_with_events}`);
      console.log("");
      console.log("GATE NOT MET — no weight recommendation.");
      console.log("The harness is ready. score_breakdown only entered the archive");
      console.log("in schema v4, so the usable set grows as post-v4 events resolve");
      console.log("(snapshot still written for visibility).");
    }
    return;
  }

  // ── Gate met — primary: walk-forward CV; secondary: legacy 80/20 ──
  //
  // P2.2 (walk-forward CV): the primary out-of-sample signal is now
  // rolling-origin — train on quarters 1..k, test on quarter k+1, walk
  // the origin forward. Random 80/20 is preserved as a secondary check
  // for backward-compat with prior weight-tuning runs and to surface
  // when the two splits disagree.
  const walkForward = splitTrainHoldoutWalkForward(rows);
  const wfRanked = rankConfigs(rows, buildCandidateConfigs());
  const top = wfRanked.slice(0, 10);
  const baseline = wfRanked.find((c) => c.name === "baseline");
  const best = wfRanked[0];

  const walkForwardCheck = {
    best_on_walk_forward: walkForwardEvaluate(rows, best.multipliers),
    baseline_on_walk_forward: walkForwardEvaluate(rows, baseline ? baseline.multipliers : {}),
  };
  const { train: legacyTrain, holdout: legacyHoldout } = splitTrainHoldoutRandom(rows, 0.2);
  const legacyHoldoutCheck = {
    best_on_holdout: evaluateConfig(legacyHoldout, best.multipliers),
    baseline_on_holdout: evaluateConfig(legacyHoldout, baseline ? baseline.multipliers : {}),
  };

  const report = {
    ...base,
    cv_method: "walk-forward",
    cv_fold_count: walkForward.folds.length,
    cv_quarter_keys: walkForward.quarter_keys,
    cv_skipped_no_quarter: walkForward.skipped_no_quarter,
    // legacy fields kept for snapshot-shape stability
    train_count: legacyTrain.length,
    holdout_count: legacyHoldout.length,
    baseline: baseline ? { name: baseline.name, result: baseline.result } : null,
    top_configs: top.map((c) => ({ name: c.name, multipliers: c.multipliers, result: c.result })),
    best: { name: best.name, multipliers: best.multipliers, train_result: best.result },
    walk_forward_check: walkForwardCheck,
    holdout_check: legacyHoldoutCheck,
    recommendation:
      best.name === "baseline"
        ? "Baseline already optimal on this sample — no change recommended."
        : `Candidate "${best.name}" beat baseline overall ` +
          `(${best.result.hit_rate_pct}% vs ${baseline?.result.hit_rate_pct ?? "?"}%). ` +
          `Walk-forward CV: best ${walkForwardCheck.best_on_walk_forward.aggregated_hit_rate_pct}% ` +
          `vs baseline ${walkForwardCheck.baseline_on_walk_forward.aggregated_hit_rate_pct}% across ` +
          `${walkForward.folds.length} folds. Confirm both signals agree before editing earningsPredictor.js by hand.`,
  };
  writeJsonAtomic(OUT_PATH, report);

  if (argJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("Earnings Weight Tuner — Sweep Report");
  console.log("====================================");
  console.log(`Resolved: ${rows.length}  (walk-forward folds: ${walkForward.folds.length}, legacy 80/20 train ${legacyTrain.length} / holdout ${legacyHoldout.length})`);
  console.log(`CV method: walk-forward (rolling-origin) across quarters: ${walkForward.quarter_keys.join(", ") || "—"}`);
  console.log("");
  console.log("Top configs (overall hit-rate):");
  for (const c of top) {
    console.log(`  ${c.name.padEnd(24)} ${String(c.result.hit_rate_pct).padStart(5)}%  brier ${c.result.brier}`);
  }
  console.log("");
  console.log(`Best: ${best.name}`);
  console.log(`  overall      hit-rate ${best.result.hit_rate_pct}%`);
  console.log(`  walk-forward hit-rate ${walkForwardCheck.best_on_walk_forward.aggregated_hit_rate_pct}% (baseline ${walkForwardCheck.baseline_on_walk_forward.aggregated_hit_rate_pct}%)`);
  console.log(`  legacy 80/20 hit-rate ${legacyHoldoutCheck.best_on_holdout.hit_rate_pct}% (baseline ${legacyHoldoutCheck.baseline_on_holdout.hit_rate_pct}%)`);
  console.log("");
  console.log(report.recommendation);
}

try {
  main();
} catch (err) {
  console.error("[tune-weights] FAILED:", err.stack || err.message);
  process.exit(1);
}
