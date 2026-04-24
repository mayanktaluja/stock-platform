#!/usr/bin/env node
/**
 * Smoke test for fundamentalsV2 scorer.
 *
 * Pulls live snapshots for a diverse 5-stock sample (matches the
 * enrichment smoke test set) and prints the 6-pillar breakdown for each.
 * Purpose: catch any runtime error and eyeball-sanity-check the pillar
 * scores before running the full-universe shadow compare.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { scoreFundamentals } from "../fundamentals.js";
import { scoreFundamentalsV2, pillarScoresForRadar } from "../fundamentalsV2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUND_PATH = path.join(__dirname, "..", "fundamentals.json");

const data = JSON.parse(readFileSync(FUND_PATH, "utf-8"));

const SAMPLE = ["RELIANCE.NS", "TCS.NS", "SBIN.NS", "PERSISTENT.NS", "MASTEK.NS"];

for (const sym of SAMPLE) {
  const snap = data.snapshots[sym];
  if (!snap) {
    console.log(`⚠ ${sym} not in fundamentals.json — skipping`);
    continue;
  }

  const v1 = scoreFundamentals(snap);
  const v2 = scoreFundamentalsV2(snap);

  console.log("\n" + "═".repeat(70));
  console.log(`${sym.padEnd(16)} ${snap.name} (${snap.sector})`);
  console.log("═".repeat(70));

  console.log(`  V1: ${v1.score}/100  ${v1.verdict}`);
  console.log(`  V2: ${v2.score}/100  ${v2.verdict}  [sectorKind: ${v2.sectorKind}]`);
  console.log(`  Δ:  ${v2.score - v1.score > 0 ? "+" : ""}${v2.score - v1.score}`);

  console.log("\n  Pillars (0–5):");
  const radar = pillarScoresForRadar(v2);
  for (const [name, val] of Object.entries(radar)) {
    const p = v2.pillars[name];
    const bar = val != null ? "█".repeat(Math.round(val * 4)).padEnd(20) : "N/A".padEnd(20);
    const label = val != null ? `${val.toFixed(1)}  ${p.grade}` : "N/A";
    console.log(`    ${name.padEnd(11)} ${bar}  ${label}`);
  }

  if (v2.composition.naPillars.length > 0) {
    console.log(`\n  N/A pillars: ${v2.composition.naPillars.join(", ")}`);
  }
  console.log(`  Applied weights: ${JSON.stringify(v2.composition.appliedWeights)}`);

  if (v2.warnings.length > 0) {
    console.log("\n  Warnings:");
    for (const w of v2.warnings) console.log(`    ⚠ ${w}`);
  }
}
