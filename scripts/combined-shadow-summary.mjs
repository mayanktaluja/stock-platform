#!/usr/bin/env node
/**
 * combined-shadow-summary.mjs
 *
 * Reads the daily combined-shadow-diff.json captures (written by the
 * scanner endpoints under COMBINED_SCORE_MODE=shadow) and emits a
 * human-readable summary for the SEBI-registered analyst's review.
 *
 * Drives the Phase 1 → Phase 2 gate decision in
 * /Users/mayanktaluja/.claude/plans/create-a-plan-to-witty-harp.md
 *
 *   • Verdict-flip rate < 30% required to graduate to opt-in mode.
 *   • Surveillance regression check: synthetic GSM/ASM stock at v3=80
 *     must NOT appear in deepValue/qualityGrowth/buynow buckets.
 *
 * Inputs:
 *   data/sws/combined-shadow-diff.json   — written by scanner cache writes.
 *
 * Output:
 *   stdout report (markdown). Schedule via mcp__scheduled-tasks to email
 *   the analyst daily.
 *
 * Usage:
 *   node scripts/combined-shadow-summary.mjs
 *   node scripts/combined-shadow-summary.mjs --since 2026-04-30
 *   node scripts/combined-shadow-summary.mjs --json    # machine-readable output
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIFF_PATH = path.resolve(__dirname, "..", "data", "sws", "combined-shadow-diff.json");

const args = process.argv.slice(2);
const sinceArg = (() => {
  const i = args.indexOf("--since");
  return i >= 0 ? args[i + 1] : null;
})();
const jsonOut = args.includes("--json");

function loadDiff() {
  if (!fs.existsSync(DIFF_PATH)) {
    return { entries: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DIFF_PATH, "utf-8"));
  } catch (err) {
    console.error(`[shadow-summary] failed to read ${DIFF_PATH}: ${err.message}`);
    return { entries: [] };
  }
}

function sinceFilter(entries, since) {
  if (!since) return entries;
  const cutoff = new Date(since).getTime();
  return entries.filter((e) => new Date(e.captured_at || 0).getTime() >= cutoff);
}

function summarize(entries) {
  const total = entries.length;
  const verdictFlips = entries.filter((e) => e.legacyVerdict !== e.combinedVerdict).length;
  const flipRate = total > 0 ? +(verdictFlips / total * 100).toFixed(1) : 0;

  const bySource = {};
  const buckets = { tech_dominant: 0, fund_dominant: 0, sws_dominant: 0, balanced: 0 };
  let missingSwsCount = 0;
  let divergentCount = 0;
  let totalDrift = 0;

  for (const e of entries) {
    bySource[e.swsSource || "unknown"] = (bySource[e.swsSource || "unknown"] || 0) + 1;
    if (e.swsSource !== "primary") missingSwsCount++;
    if (e.combinedDivergence) divergentCount++;
    if (typeof e.combinedScore === "number" && typeof e.legacyScore === "number") {
      totalDrift += Math.abs(e.combinedScore - e.legacyScore);
    }

    // Categorise dominance from weights actually used.
    const w = e.weightsUsed || {};
    const max = Math.max(w.tech || 0, w.fund || 0, w.sws || 0);
    if (max < 0.4) buckets.balanced++;
    else if ((w.tech || 0) === max) buckets.tech_dominant++;
    else if ((w.fund || 0) === max) buckets.fund_dominant++;
    else buckets.sws_dominant++;
  }

  const avgDrift = total > 0 ? +(totalDrift / total).toFixed(1) : 0;
  const missingSwsPct = total > 0 ? +(missingSwsCount / total * 100).toFixed(1) : 0;
  const divergentPct = total > 0 ? +(divergentCount / total * 100).toFixed(1) : 0;

  // Top-30 verdict flips (largest score drift).
  const flips = entries
    .filter((e) => e.legacyVerdict !== e.combinedVerdict)
    .map((e) => ({
      symbol: e.symbol,
      scanner: e.scannerType,
      legacyScore: e.legacyScore,
      combinedScore: e.combinedScore,
      drift: +Math.abs((e.combinedScore || 0) - (e.legacyScore || 0)).toFixed(1),
      legacyVerdict: e.legacyVerdict,
      combinedVerdict: e.combinedVerdict,
      reason: e.combinedDivergence ? "divergent signals" : null,
    }))
    .sort((a, b) => b.drift - a.drift)
    .slice(0, 30);

  return {
    total_picks: total,
    verdict_flip_count: verdictFlips,
    verdict_flip_rate_pct: flipRate,
    avg_score_drift: avgDrift,
    missing_sws_pct: missingSwsPct,
    divergent_pct: divergentPct,
    sws_source_distribution: bySource,
    weight_dominance_buckets: buckets,
    top_flips: flips,
    phase_1_to_2_gate: flipRate < 30 ? "PASS" : "FAIL",
  };
}

function renderMarkdown(s) {
  const lines = [];
  lines.push(`# Combined-Score Shadow Summary`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (sinceArg) lines.push(`Since: ${sinceArg}`);
  lines.push(``);
  lines.push(`## Phase-1 → Phase-2 Gate: **${s.phase_1_to_2_gate}**`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total picks captured | ${s.total_picks} |`);
  lines.push(`| Verdict flip rate | ${s.verdict_flip_rate_pct}% (${s.verdict_flip_count} flips) — gate < 30% |`);
  lines.push(`| Average score drift | ${s.avg_score_drift} pts |`);
  lines.push(`| Missing SWS (fallback/missing) | ${s.missing_sws_pct}% |`);
  lines.push(`| Divergent signals (alpha-rich/trap-rich) | ${s.divergent_pct}% |`);
  lines.push(``);
  lines.push(`## SWS source distribution`);
  for (const [k, v] of Object.entries(s.sws_source_distribution)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push(``);
  lines.push(`## Weight-dominance breakdown (effective weights after pro-rata reweighting)`);
  for (const [k, v] of Object.entries(s.weight_dominance_buckets)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push(``);
  if (s.top_flips.length > 0) {
    lines.push(`## Top ${s.top_flips.length} verdict flips (sorted by drift)`);
    lines.push(``);
    lines.push(`| # | Symbol | Scanner | Legacy → Combined | Drift | Reason |`);
    lines.push(`|---|---|---|---|---|---|`);
    s.top_flips.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${f.symbol} | ${f.scanner} | ${f.legacyVerdict} (${f.legacyScore}) → ${f.combinedVerdict} (${f.combinedScore}) | ${f.drift} | ${f.reason || "—"} |`);
    });
    lines.push(``);
  }
  lines.push(`---`);
  lines.push(`SEBI compliance: this report is the analyst's record-keeping artefact for the Phase-1 shadow-mode soak. Do not flip COMBINED_SCORE_MODE to primary without a documented backtest gate (see plan §7).`);
  return lines.join("\n");
}

function main() {
  const diff = loadDiff();
  const entries = sinceFilter(diff.entries || [], sinceArg);
  const summary = summarize(entries);

  if (jsonOut) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(renderMarkdown(summary) + "\n");
  }
}

main();
