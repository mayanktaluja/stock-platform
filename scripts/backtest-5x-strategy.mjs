#!/usr/bin/env node
/**
 * Backtest the multibagger scorer against forward 365-day returns.
 *
 * Reads resolved rows from data/strategy/backtest-resolved.json (built
 * by a future resolver that joins history snapshots → forward prices).
 * Until that file + 9mo of forward archive exist, the validation gate
 * stays closed and this prints "not yet validated" — expected.
 *
 * Usage:
 *   node scripts/backtest-5x-strategy.mjs
 *   node scripts/backtest-5x-strategy.mjs --json
 *   node scripts/backtest-5x-strategy.mjs --ablation
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeBacktest, computeAblation } from "../services/multibagger/multibaggerBacktest.js";
import { COMPONENT_KEYS } from "../services/multibagger/multibaggerWeightTuner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESOLVED_PATH = path.join(ROOT, "data", "strategy", "backtest-resolved.json");
const OUT_PATH = path.join(ROOT, "data", "strategy", "5x-backtest-latest.json");

const asJson = process.argv.includes("--json");
const withAblation = process.argv.includes("--ablation");

function loadResolved() {
  if (!fs.existsSync(RESOLVED_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(RESOLVED_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.resolved || []);
  } catch { return []; }
}

function main() {
  const resolved = loadResolved();
  const report = computeBacktest(resolved);
  if (withAblation && resolved.length) {
    report.ablation = computeAblation(resolved, COMPONENT_KEYS);
  }
  report.generated_at = new Date().toISOString();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, OUT_PATH);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  console.log("\n5x Strategy Backtest");
  console.log("====================");
  console.log(`Resolved rows: ${report.resolved_count}`);
  console.log(`Windows: ${report.windows}`);
  if (report.resolved_count === 0) {
    console.log("\n⚠ No resolved rows yet. The forward archive needs to accumulate.");
    console.log("  Validation gate: NOT MET (expected — see plan §9.3).");
    return;
  }
  console.log("\nBucket hit-rates:");
  for (const [k, v] of Object.entries(report.bucket_hit_rates)) {
    console.log(`  ${k.padEnd(10)} ${v.hits}/${v.total} = ${v.hit_rate_pct}%`);
  }
  console.log(`\nValidation gate: ${report.validation_gate.gate_met ? "MET ✓" : "NOT MET"}`);
  if (!report.validation_gate.gate_met) {
    console.log(`  Blocking: ${report.validation_gate.blocking_reasons.join(", ")}`);
  }
  console.log(`\n⚠ ${report.survivorship_warning}`);
}

main();
