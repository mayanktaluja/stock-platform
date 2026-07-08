#!/usr/bin/env node
// Audit every Indian stock's PEG display under the resolver in
// services/valuation/pegDisplay.js, exactly as the Quick Stats modal renders it.
//
// Classifies each stock the modal can show a PEG row for into:
//   shown     — positive Groww/Refinitiv peg, rendered verbatim.
//   rescued   — Groww peg was <=0 (false "Not meaningful") but a real positive-
//               growth PEG exists; the fix now shows a computed number.
//   genuine   — Groww peg <=0 AND earnings flat/shrinking → truly "Not meaningful".
//   no_row    — no Groww peg coverage; PEG row omitted (unchanged).
//
// Usage:
//   node scripts/audit-peg-not-meaningful.mjs            # human summary + samples
//   node scripts/audit-peg-not-meaningful.mjs --json     # full machine-readable dump
//   node scripts/audit-peg-not-meaningful.mjs --csv > peg-audit.csv
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePegDisplay } from "../services/valuation/pegDisplay.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEEP_DIR = path.join(REPO_ROOT, "data/sws/deep");
const asJson = process.argv.includes("--json");
const asCsv = process.argv.includes("--csv");

function num(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}
function sane(v, lo, hi) {
  const n = num(v);
  return n == null || n < lo || n > hi ? null : n;
}

// Mirror gated/app.js: which raw peg the modal treats as Groww-sourced.
function growwPegFor(deep) {
  const ov = deep.overview || {};
  const mult = ov.multiples || {};
  const sourceMap = ov.source_map || {};
  const growwSource = deep.groww_source || deep.groww || null;
  const pegSource = sourceMap["multiples.peg"] || sourceMap["multiples.peg_ratio"] || null;
  const pegRawVal = sane(mult.peg, -500, 500) ?? sane(mult.peg_ratio, -500, 500);
  const fromGroww =
    pegSource?.provider === "groww_refinitiv" ||
    (growwSource?.provider === "groww_refinitiv" && pegRawVal != null);
  return fromGroww ? pegRawVal : null;
}

const rows = [];
for (const file of fs.readdirSync(DEEP_DIR)) {
  if (!file.endsWith(".json")) continue;
  let deep;
  try {
    deep = JSON.parse(fs.readFileSync(path.join(DEEP_DIR, file), "utf8"));
  } catch {
    continue;
  }
  const ov = deep.overview || {};
  const mult = ov.multiples || {};
  const symbol = file.replace(/\.json$/, "");
  const r = resolvePegDisplay({
    growwPeg: growwPegFor(deep),
    pe: num(mult.pe),
    netIncomeHistory: deep.fiscal?.yearly_history || null,
    growwProfit: deep.financials?.groww?.yearly?.profit || null,
    yoyEarningsGrowthPct: num(ov.earnings_growth_yoy_pct),
  });
  const klass =
    r.basis === "refinitiv" ? "shown" :
    r.basis === "computed" ? "rescued" :
    r.basis === "not_meaningful" ? "genuine" : "no_row";
  rows.push({
    symbol,
    class: klass,
    raw_groww_peg: growwPegFor(deep),
    pe: num(mult.pe),
    yoy_growth_pct: num(ov.earnings_growth_yoy_pct),
    resolved: r.value,
  });
}

const counts = rows.reduce((a, r) => ((a[r.class] = (a[r.class] || 0) + 1), a), {});

if (asJson) {
  console.log(JSON.stringify({ counts, rows }, null, 2));
} else if (asCsv) {
  console.log("symbol,class,raw_groww_peg,pe,yoy_growth_pct,resolved");
  for (const r of rows) {
    console.log([r.symbol, r.class, r.raw_groww_peg ?? "", r.pe ?? "", r.yoy_growth_pct ?? "", r.resolved ?? ""].join(","));
  }
} else {
  const total = rows.length;
  console.log(`PEG display audit over ${total} deep-briefed Indian stocks\n`);
  console.log(`  shown    ${String(counts.shown || 0).padStart(5)}  positive Groww peg, rendered verbatim`);
  console.log(`  rescued  ${String(counts.rescued || 0).padStart(5)}  was false "Not meaningful" → now shows a computed PEG`);
  console.log(`  genuine  ${String(counts.genuine || 0).padStart(5)}  truly "Not meaningful" (flat/shrinking earnings)`);
  console.log(`  no_row   ${String(counts.no_row || 0).padStart(5)}  no Groww peg coverage; PEG row omitted`);
  const rescued = rows.filter((r) => r.class === "rescued").sort((a, b) => Number(a.resolved) - Number(b.resolved));
  console.log(`\n  ── sample RESCUED (bug fix impact) — sorted by resolved PEG ──`);
  for (const r of rescued.slice(0, 25)) {
    console.log(`    ${r.symbol.padEnd(12)} rawGroww=${String(r.raw_groww_peg).padStart(9)}  pe=${String(r.pe).padStart(7)}  yoyG=${String(r.yoy_growth_pct).padStart(7)}  → PEG ${r.resolved}`);
  }
  const genuine = rows.filter((r) => r.class === "genuine");
  console.log(`\n  ── sample GENUINE Not-meaningful (verify: earnings flat/negative) ──`);
  for (const r of genuine.slice(0, 15)) {
    console.log(`    ${r.symbol.padEnd(12)} rawGroww=${String(r.raw_groww_peg).padStart(9)}  pe=${String(r.pe).padStart(7)}  yoyG=${String(r.yoy_growth_pct).padStart(7)}`);
  }
}
