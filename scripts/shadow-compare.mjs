#!/usr/bin/env node
/**
 * Shadow comparison: V1 vs V2 scorer diff across the full fundamentals.json.
 *
 * The V2 scorer (fundamentalsV2.js) runs in shadow mode — never used for
 * production verdicts. Before it can be gated into production, we need to
 * understand:
 *
 *   1. Score drift — how far do the two composites diverge? A ±15 band is
 *      expected (V2 adds new pillars); anything beyond warrants a look.
 *   2. Verdict flips — which stocks change bucket (e.g. FAIR_VALUE → DV)?
 *      These are the high-leverage cases for Phase 3 backtest.
 *   3. Pillar coverage — for how many stocks is each pillar N/A? Drives
 *      our prioritisation for Phase 2.x governance-fetcher and data work.
 *
 * Output:
 *   - Summary table on stdout
 *   - shadow-diff.json: detailed per-stock comparison for backtest replay
 *
 * Usage:
 *   node scripts/shadow-compare.mjs
 *   node scripts/shadow-compare.mjs --top-flips=30
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { scoreFundamentals } from "../fundamentals.js";
import { scoreFundamentalsV2 } from "../fundamentalsV2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUND_PATH = path.join(__dirname, "..", "fundamentals.json");
const OUT_PATH = path.join(__dirname, "..", "shadow-diff.json");

const args = new Set(process.argv.slice(2));
const TOP_FLIPS = Number(
  [...args].find((a) => a.startsWith("--top-flips="))?.split("=")[1] || 20
);

const data = JSON.parse(readFileSync(FUND_PATH, "utf-8"));
const snapshots = Object.values(data.snapshots || {});

if (snapshots.length === 0) {
  console.error("No snapshots in fundamentals.json. Run refresh + enrich first.");
  process.exit(1);
}

console.log(`Running shadow comparison over ${snapshots.length} stocks...\n`);

const results = [];
let v1Only = 0, v2Only = 0, bothSkipped = 0;

for (const snap of snapshots) {
  const v1 = scoreFundamentals(snap);
  const v2 = scoreFundamentalsV2(snap);

  if (!v1 && !v2) { bothSkipped++; continue; }
  if (!v1)        { v2Only++; continue; }
  if (!v2)        { v1Only++; continue; }

  const scoreDelta = v2.score - v1.score;
  const verdictFlip = v1.verdict !== v2.verdict;

  results.push({
    symbol: snap.symbol,
    name: snap.name,
    sector: snap.sector,
    sectorKind: v2.sectorKind,
    v1: { score: v1.score, verdict: v1.verdict },
    v2: {
      score: v2.score,
      verdict: v2.verdict,
      pillars: Object.fromEntries(
        Object.entries(v2.pillars).map(([k, p]) => [k, p.score])
      ),
      naPillars: v2.composition.naPillars,
    },
    scoreDelta,
    verdictFlip,
  });
}

// ─── Summary stats ───
const deltas = results.map((r) => r.scoreDelta);
deltas.sort((a, b) => a - b);
const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
const median = deltas[Math.floor(deltas.length / 2)];
const p10 = deltas[Math.floor(deltas.length * 0.1)];
const p90 = deltas[Math.floor(deltas.length * 0.9)];
const absDeltas = deltas.map(Math.abs).sort((a, b) => a - b);
const maxAbsDelta = absDeltas[absDeltas.length - 1];

const flips = results.filter((r) => r.verdictFlip);

// Verdict transition matrix
const matrix = {};
for (const r of results) {
  const k = `${r.v1.verdict} → ${r.v2.verdict}`;
  matrix[k] = (matrix[k] || 0) + 1;
}

// Pillar N/A coverage
const pillarNA = { value: 0, future: 0, past: 0, health: 0, dividend: 0, governance: 0 };
for (const r of results) {
  for (const p of r.v2.naPillars || []) {
    pillarNA[p] = (pillarNA[p] || 0) + 1;
  }
}

// ─── Print ───
console.log("═".repeat(70));
console.log("                    SHADOW COMPARE: V1 vs V2");
console.log("═".repeat(70));
console.log();
console.log(`Stocks scored by both: ${results.length}`);
console.log(`Stocks only V1:        ${v1Only}`);
console.log(`Stocks only V2:        ${v2Only}`);
console.log(`Both skipped:          ${bothSkipped}`);
console.log();

console.log("── Score delta (V2 − V1) distribution ──");
console.log(`  mean:   ${mean.toFixed(1)}`);
console.log(`  median: ${median.toFixed(1)}`);
console.log(`  p10:    ${p10.toFixed(1)}`);
console.log(`  p90:    ${p90.toFixed(1)}`);
console.log(`  max |Δ|: ${maxAbsDelta}`);
console.log();

console.log(`── Verdict flips: ${flips.length} (${((flips.length / results.length) * 100).toFixed(1)}%)`);
console.log();
console.log("Transition matrix (V1 → V2):");
const entries = Object.entries(matrix).sort((a, b) => b[1] - a[1]);
for (const [k, n] of entries) {
  const changed = !k.match(/^(\w+) → \1$/);
  const mark = changed ? "◆" : " ";
  console.log(`  ${mark} ${k.padEnd(40)} ${String(n).padStart(4)}`);
}
console.log();

console.log("── Pillar N/A coverage (V2) ──");
for (const [k, n] of Object.entries(pillarNA).sort((a, b) => b[1] - a[1])) {
  const pct = ((n / results.length) * 100).toFixed(0);
  const bar = "█".repeat(Math.round(n / results.length * 30)).padEnd(30);
  console.log(`  ${k.padEnd(12)} ${bar} ${String(n).padStart(4)} (${pct}%)`);
}
console.log();

// ─── Top flips (biggest score deltas that also changed verdict) ───
console.log(`── Top ${TOP_FLIPS} verdict flips by absolute score delta ──`);
console.log();
const sortedFlips = flips.slice().sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta));
const header = "symbol".padEnd(14) + "sectorKind".padEnd(12) + "v1".padEnd(22) + "v2".padEnd(22) + "Δ";
console.log(header);
console.log("─".repeat(header.length));
for (const r of sortedFlips.slice(0, TOP_FLIPS)) {
  const v1Str = `${r.v1.score} ${r.v1.verdict}`.padEnd(22);
  const v2Str = `${r.v2.score} ${r.v2.verdict}`.padEnd(22);
  const delta = (r.scoreDelta > 0 ? "+" : "") + r.scoreDelta;
  console.log(
    r.symbol.padEnd(14) +
    (r.sectorKind || "").padEnd(12) +
    v1Str +
    v2Str +
    delta
  );
}
console.log();

// ─── Top biggest |Δ| regardless of verdict change ───
console.log(`── Top ${TOP_FLIPS} biggest |Δ| (verdict may or may not flip) ──`);
console.log();
const sortedByDelta = results.slice().sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta));
console.log(header);
console.log("─".repeat(header.length));
for (const r of sortedByDelta.slice(0, TOP_FLIPS)) {
  const v1Str = `${r.v1.score} ${r.v1.verdict}`.padEnd(22);
  const v2Str = `${r.v2.score} ${r.v2.verdict}`.padEnd(22);
  const delta = (r.scoreDelta > 0 ? "+" : "") + r.scoreDelta;
  console.log(
    r.symbol.padEnd(14) +
    (r.sectorKind || "").padEnd(12) +
    v1Str +
    v2Str +
    delta
  );
}
console.log();

// ─── Persist ───
writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      fundamentalsGeneratedAt: data.generatedAt,
      stocksScored: results.length,
      stats: { mean, median, p10, p90, maxAbsDelta },
      verdictFlips: flips.length,
      transitionMatrix: matrix,
      pillarNACounts: pillarNA,
      records: results,
    },
    null,
    2
  )
);
console.log(`Wrote detailed per-stock diff to ${OUT_PATH}`);
