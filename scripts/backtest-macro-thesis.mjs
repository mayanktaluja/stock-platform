#!/usr/bin/env node
// Macro-thesis analog backtest (PR B1.4).
//
// For every CURRENT regime, summarise:
//   - Number of past analogs (regime + severity match)
//   - Per-sector return distribution at +7/+14/+30/+60 days
//   - INDETERMINATE flag if n < MIN_SAFE_N
//
// Output: data/risk-lab/macro-thesis-backtest-latest.json
// Use `--json` to dump the full report to stdout for diffing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findAnalogs, loadAllRegimeHistory } from "../services/macroThesis/historicalAnalogFinder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "data", "risk-lab", "macro-thesis-backtest-latest.json");

const args = process.argv.slice(2);
const FLAG_JSON = args.includes("--json");

function main() {
  const rows = loadAllRegimeHistory();
  if (!rows.length) {
    console.error("[backtest-macro-thesis] no regime history found — run macro refresh and/or seed-historical-regimes.mjs");
    process.exit(1);
  }
  // For each distinct regime in history, treat the LATEST occurrence as
  // the "current" and compute analogs over earlier matches. Severity
  // taken from the latest entry.
  const latestByRegime = new Map();
  for (const r of rows) {
    if (!r.regime) continue;
    if (
      !latestByRegime.has(r.regime) ||
      (r.generatedAt || "") > (latestByRegime.get(r.regime).generatedAt || "")
    ) {
      latestByRegime.set(r.regime, r);
    }
  }
  const perRegime = [];
  for (const [regime, latest] of latestByRegime) {
    const report = findAnalogs({
      regime,
      severity: latest.severity,
      currentDate: (latest.generatedAt || "").slice(0, 10),
      excludeWindowDays: 30,
    });
    perRegime.push({
      regime,
      severity: latest.severity,
      current_label: latest.regimeLabel || regime,
      current_date: (latest.generatedAt || "").slice(0, 10),
      ...report,
    });
  }
  perRegime.sort((a, b) => b.n_analogs - a.n_analogs);

  const summary = {
    schema_version: "macro-thesis-backtest-v1",
    generated_at: new Date().toISOString(),
    regime_count: latestByRegime.size,
    indeterminate_count: perRegime.filter((p) => p.indeterminate).length,
    actionable_count: perRegime.filter((p) => !p.indeterminate).length,
    per_regime: perRegime,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  if (FLAG_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[backtest-macro-thesis] wrote ${OUT_PATH}`);
    console.log(`regimes scanned: ${summary.regime_count}; actionable (n≥3): ${summary.actionable_count}; INDETERMINATE: ${summary.indeterminate_count}`);
    for (const p of perRegime) {
      const flag = p.indeterminate ? " [INDETERMINATE]" : "";
      console.log(`  ${p.regime} sev${p.severity}: n=${p.n_analogs}${flag}`);
    }
  }
}

main();
