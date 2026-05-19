#!/usr/bin/env node
/**
 * Tune the multibagger scorer's component weights by multiplier sweep.
 * NEVER edits multibaggerScorer.js — recommends directional shifts a
 * human applies by hand. Gated until ≥80 resolved rows across ≥2
 * windows + ≥5 sectors with ≥10 events each.
 *
 * Usage:
 *   node scripts/tune-5x-weights.mjs
 *   node scripts/tune-5x-weights.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tuneWeights } from "../services/multibagger/multibaggerWeightTuner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESOLVED_PATH = path.join(ROOT, "data", "strategy", "backtest-resolved.json");
const OUT_PATH = path.join(ROOT, "data", "strategy", "5x-weight-tuning.json");

const asJson = process.argv.includes("--json");

function loadResolved() {
  if (!fs.existsSync(RESOLVED_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(RESOLVED_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.resolved || []);
  } catch { return []; }
}

function main() {
  const resolved = loadResolved();
  const report = tuneWeights(resolved);
  report.generated_at = new Date().toISOString();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, OUT_PATH);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  console.log("\n5x Weight Tuner");
  console.log("===============");
  console.log(`Gate met: ${report.gate_met ? "YES ✓" : "NO"}`);
  if (!report.gate_met) {
    console.log(`Blocking: ${report.blocking_reasons.join(", ")}`);
  }
  console.log(`Baseline ≥2x hit-rate: ${report.baseline_hit_rate_2x_pct ?? "—"}%`);
  console.log("\nTop candidates:");
  for (const c of report.top_candidates.slice(0, 5)) {
    console.log(`  ${c.label.padEnd(22)} ${c.hit_rate_2x_pct ?? "—"}%`);
  }
  console.log(`\n${report.recommendation}`);
}

main();
