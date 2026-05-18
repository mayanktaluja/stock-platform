#!/usr/bin/env node
// Macro-thesis pipeline health summary (PR B4).
//
// Daily roll-up of the macro-thesis surface so a single read tells you
// what's working. Output: data/risk-lab/macro-thesis-health.json.
//
// Checks performed:
//   1. macroRegime.json freshness
//   2. macro-thesis-latest.json freshness + indeterminate count
//   3. macroRegime-history file count + seed presence
//   4. sector-indices/ — per-sector latest-bar age
//   5. upcoming catalysts in next 30 days
//
// Alerts roll up as a flat array consumed by sws-sanity-gate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeSectorFreshness } from "../services/macroThesis/sectorReturnLoader.js";
import { getUpcomingCatalysts } from "../services/macroThesis/catalystTimeline.js";
import { loadAllRegimeHistory } from "../services/macroThesis/historicalAnalogFinder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const REGIME_PATH = path.join(REPO_ROOT, "data", "macroRegime.json");
const THESIS_PATH = path.join(REPO_ROOT, "data", "risk-lab", "macro-thesis-latest.json");
const SEED_BACKFILL_PATH = path.join(REPO_ROOT, "data", "macroRegime-history", "backfill-seeds.jsonl");
const OUT_PATH = path.join(REPO_ROOT, "data", "risk-lab", "macro-thesis-health.json");

function _readJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function _ageHours(iso) {
  if (!iso) return null;
  return (Date.now() - Date.parse(iso)) / (3600 * 1000);
}

function _ageFileHours(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return (Date.now() - fs.statSync(filePath).mtimeMs) / (3600 * 1000);
}

function main() {
  const alerts = [];

  const regime = _readJson(REGIME_PATH);
  const regimeAge = regime ? _ageHours(regime.generatedAt) : null;
  if (!regime) {
    alerts.push("macroRegime.json missing — run scripts/refresh-macro-regime.mjs");
  } else if (regimeAge != null && regimeAge > 18) {
    alerts.push(`macroRegime.json is ${Math.round(regimeAge)}h old (threshold 18h)`);
  }

  const thesis = _readJson(THESIS_PATH);
  const thesisAge = _ageFileHours(THESIS_PATH);
  if (!thesis) {
    alerts.push("macro-thesis-latest.json missing — run thesisOrchestrator.writeMacroThesis()");
  } else if (thesisAge != null && thesisAge > 30) {
    alerts.push(`macro-thesis-latest.json is ${Math.round(thesisAge)}h stale`);
  }
  const indeterminateCount = thesis?.branches
    ? thesis.branches.filter((b) => b.indeterminate).length
    : null;

  const history = loadAllRegimeHistory();
  const seedsPresent = fs.existsSync(SEED_BACKFILL_PATH);
  if (!seedsPresent) {
    alerts.push("backfill-seeds.jsonl missing — run scripts/seed-historical-regimes.mjs");
  }

  const sectorFreshness = describeSectorFreshness();
  const staleSectorCount = Object.values(sectorFreshness).filter(
    (s) => s.stale_days == null || s.stale_days > 5,
  ).length;
  if (staleSectorCount > 0) {
    alerts.push(
      `${staleSectorCount} sector indices have stale or missing data (>5d) — run scripts/refresh-sector-indices.mjs`,
    );
  }

  const catalysts = getUpcomingCatalysts({ windowDays: 30 });

  const out = {
    schema_version: "macro-thesis-health-v1",
    generated_at: new Date().toISOString(),
    regime: {
      present: !!regime,
      regime: regime?.regime || null,
      severity: regime?.severity ?? null,
      age_hours: regimeAge != null ? Math.round(regimeAge * 10) / 10 : null,
    },
    thesis: {
      present: !!thesis,
      indeterminate_branches: indeterminateCount,
      branches_count: thesis?.branches?.length ?? null,
      age_hours: thesisAge != null ? Math.round(thesisAge * 10) / 10 : null,
    },
    regime_history: {
      total_lines: history.length,
      seeds_present: seedsPresent,
    },
    sector_data: {
      total_sectors: Object.keys(sectorFreshness).length,
      stale_sectors_count: staleSectorCount,
      freshness: sectorFreshness,
    },
    upcoming_catalysts: catalysts,
    alerts,
    healthy: alerts.length === 0,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`[macro-thesis-health] wrote ${OUT_PATH}`);
    console.log(`healthy=${out.healthy}; alerts=${alerts.length}`);
    for (const a of alerts) console.log(`  alert: ${a}`);
  }
}

main();
