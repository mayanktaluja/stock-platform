#!/usr/bin/env node
/**
 * backtest-picks-sections.mjs — honest per-section hit-rate + alpha-vs-Nifty.
 *
 * Reads the paper-trade ledger, groups resolved picks by SWS section, and
 * computes the share that beat Nifty (Wilson CI) + median/mean alpha (bootstrap
 * CI) per section. Writes data/track-record/picks-section-backtest-latest.json,
 * which the Picks-tab section headers read to show a measured pill or a muted
 * "n=X · measuring" until a section clears the N≥30 gate.
 *
 * This is the resolved-cohort complement to build-section-performance-snapshot.mjs
 * (which builds the hindsight/latest cohort trailing returns) — it fills the one
 * gap that subsystem does not: a per-pick hit-rate + confidence interval.
 *
 *   node scripts/backtest-picks-sections.mjs              # human table + write
 *   node scripts/backtest-picks-sections.mjs --json       # machine JSON only
 *   node scripts/backtest-picks-sections.mjs --dry-run    # compute, no write
 *   node scripts/backtest-picks-sections.mjs --region=IN  # (default IN)
 *   node scripts/backtest-picks-sections.mjs --min-n=30   # override THIN_N
 *
 * Exit: 0 success (even all-thin/empty), 1 fatal read/parse, 2 bad region.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readAllTrades } from "../paperTrades.js";
import {
  buildSectionBacktest,
  PICKS_SECTION_THIN_N,
} from "../services/trackRecord/picksSectionBacktest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "track-record", "picks-section-backtest-latest.json");

// Only IN is wired today (the ledger is India-only by construction). The region
// switch exists so US/KR/TW slot in once their ledgers exist.
const SUPPORTED_REGIONS = new Set(["IN"]);

function parseArgs(argv) {
  const out = { json: false, dryRun: false, region: "IN", minN: PICKS_SECTION_THIN_N };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--region=")) out.region = arg.split("=")[1].toUpperCase();
    else if (arg.startsWith("--min-n=")) out.minN = Math.max(1, Number.parseInt(arg.split("=")[1], 10) || PICKS_SECTION_THIN_N);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, filePath);
}

function fmtCell(value, width, dp = 1) {
  const s = value == null ? "—" : (typeof value === "number" ? value.toFixed(dp) : String(value));
  return s.padStart(width);
}

function printHumanTable(payload) {
  const lines = [];
  lines.push("");
  lines.push(`Picks Section Backtest — ${payload.region} (vs ${payload.benchmark})`);
  lines.push(
    `Ledger: ${payload.ledger_rows_total} rows${payload.all_backfill ? " · ALL BACKFILL" : ""} · thin_n=${payload.thin_n}`
  );
  lines.push("");
  const head = [
    "section".padEnd(24),
    "n(res)".padStart(7),
    "hit%".padStart(6),
    "Wilson95".padStart(14),
    "med α%".padStart(8),
    "α 95%CI".padStart(16),
    "mean α%".padStart(8),
    "hold".padStart(5),
    "  state",
  ].join(" ");
  lines.push(head);
  lines.push("-".repeat(head.length));
  for (const [key, s] of Object.entries(payload.sections)) {
    const wilson =
      s.hit_rate_ci_pct && s.hit_rate_ci_pct.lo != null
        ? `[${s.hit_rate_ci_pct.lo},${s.hit_rate_ci_pct.hi}]`
        : "—";
    const alphaCi =
      s.median_alpha_ci_pct && s.median_alpha_ci_pct.lo != null
        ? `[${s.median_alpha_ci_pct.lo},${s.median_alpha_ci_pct.hi}]`
        : "—";
    const state = s.thin ? (s.n_resolved > 0 ? "measuring" : "no data") : "measured";
    lines.push(
      [
        key.padEnd(24),
        fmtCell(s.n_resolved, 7, 0),
        fmtCell(s.hit_rate_pct, 6),
        wilson.padStart(14),
        fmtCell(s.median_alpha_pct, 8),
        alphaCi.padStart(16),
        fmtCell(s.mean_alpha_pct, 8),
        fmtCell(s.median_days_held, 5, 0),
        `  ${state}`,
      ].join(" ")
    );
  }
  if (payload.unmapped_ledger_types.length) {
    const um = payload.unmapped_ledger_types.map((u) => `${u.type} (n=${u.count})`).join(", ");
    lines.push("");
    lines.push(`Unmapped ledger types (resolved data, no section): ${um}`);
  }
  lines.push("");
  lines.push(payload.honesty_note);
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!SUPPORTED_REGIONS.has(opts.region)) {
    console.error(`[picks-backtest] unsupported region: ${opts.region} (supported: ${[...SUPPORTED_REGIONS].join(", ")})`);
    process.exitCode = 2;
    return;
  }

  const trades = await readAllTrades();
  // new Date() is fine in a plain script (not a workflow); stamp generatedAt here.
  const generatedAt = new Date().toISOString();
  const payload = buildSectionBacktest(trades, { minN: opts.minN, region: opts.region, generatedAt });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printHumanTable(payload);
  }

  if (!opts.dryRun) {
    writeAtomic(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    if (!opts.json) console.log(`[picks-backtest] wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
  } else if (!opts.json) {
    console.log("[picks-backtest] dry-run — no file written");
  }
}

main().catch((err) => {
  console.error("[picks-backtest] failed:", err?.stack || err?.message || err);
  process.exitCode = 1;
});
