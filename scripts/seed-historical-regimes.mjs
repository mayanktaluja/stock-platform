#!/usr/bin/env node
// Seed the macro regime history with hand-curated anchor events (PR B1.3).
//
// Reads data/macro-seed-events.json and writes one line per entry to
// data/macroRegime-history/backfill-seeds.jsonl in the same JSONL
// shape the live classifier produces — so the analog backtester (B1.4)
// can blend live + seeded entries without a special path.
//
// Every line is tagged with `source: "manual-seed"` so callers can
// distinguish hand-curated vs live-classified provenance when reporting
// analog counts. Idempotent: re-running overwrites the file (single
// source of truth for the seeds).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SEEDS_PATH = path.join(REPO_ROOT, "data", "macro-seed-events.json");
const HISTORY_DIR = path.join(REPO_ROOT, "data", "macroRegime-history");
const OUT_PATH = path.join(HISTORY_DIR, "backfill-seeds.jsonl");

const args = process.argv.slice(2);
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_QUIET = args.includes("--quiet");

function log(...m) {
  if (!FLAG_QUIET) console.log("[seed-historical-regimes]", ...m);
}

function seedToRegimeLine(seed) {
  // Mirror the live shape from scripts/refresh-macro-regime.mjs +
  // macroRegime.js so the analog reader doesn't need to special-case
  // seeded entries (only filters via the `source` tag).
  const sectorImpacts = [];
  for (const s of seed.primary_sectors_hit || []) {
    sectorImpacts.push({ sector: s, impact: -Math.min(3, seed.severity), reason: `Seed: hit by ${seed.label}` });
  }
  for (const s of seed.primary_sectors_benefit || []) {
    sectorImpacts.push({ sector: s, impact: Math.min(3, Math.max(1, seed.severity - 1)), reason: `Seed: beneficiary of ${seed.label}` });
  }
  // `generatedAt` set to the event date itself (00:00 UTC) so the analog
  // finder's "nearest regime ≤ event_date" join picks up these events
  // at the right point in time.
  const generatedAt = `${seed.date}T00:00:00.000Z`;
  return {
    regime: seed.regime,
    regimeLabel: seed.label,
    severity: seed.severity,
    confidence: 1.0,
    sectorImpacts,
    keyEvents: [seed.label],
    reasoning: seed.severity_rationale || `Manual seed: ${seed.label}`,
    headlineCount: 0,
    generatedAt,
    classifierProvider: "manual-seed",
    source: "manual-seed",
    duration_days: seed.duration_days || null,
    source_url: seed.source_url || null,
  };
}

function main() {
  if (!fs.existsSync(SEEDS_PATH)) {
    console.error(`[seed-historical-regimes] seeds file missing: ${SEEDS_PATH}`);
    process.exit(1);
  }
  const seedsDoc = JSON.parse(fs.readFileSync(SEEDS_PATH, "utf-8"));
  const events = Array.isArray(seedsDoc?.events) ? seedsDoc.events : [];
  if (events.length === 0) {
    console.error("[seed-historical-regimes] no events in seeds file");
    process.exit(1);
  }
  const lines = events
    .map(seedToRegimeLine)
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
    .map((r) => JSON.stringify(r));
  log(`processed ${events.length} seed events`);
  if (FLAG_DRY_RUN) {
    log(`would write ${lines.length} lines to ${OUT_PATH}`);
    if (args.includes("--json")) console.log(JSON.stringify(lines.map((l) => JSON.parse(l)), null, 2));
    return;
  }
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  log(`wrote ${lines.length} lines → ${OUT_PATH}`);
  if (args.includes("--json")) console.log(JSON.stringify({ written: lines.length, path: OUT_PATH }, null, 2));
}

main();
