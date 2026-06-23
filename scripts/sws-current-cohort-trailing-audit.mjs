#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

import {
  DEFAULT_TRAILING_HORIZONS,
  buildCurrentCohortRows,
  buildCurrentCohortTrailingAudit,
  canonicalYahooSymbol,
  normalizeTrailingCohorts,
  normalizeTrailingHorizons,
  renderCurrentCohortTrailingMarkdown,
} from "../services/swsCurrentCohortTrailingAudit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PICKS_PATH = path.join(ROOT, "data", "sws", "picks-latest.json");
const REPORTS_DIR = path.join(ROOT, "reports");
const BENCHMARK_SYMBOL = "^NSEI";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function parseArgs(argv) {
  const out = {
    horizons: DEFAULT_TRAILING_HORIZONS,
    cohorts: [3, 5, 10, 20],
    sections: null,
    minCoveragePct: 80,
    frictionBps: 0,
    concurrency: 6,
    stdoutJson: false,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === "--json") out.stdoutJson = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--include-empty") out.includeEmptySections = true;
    else if (arg.startsWith("--horizons=")) out.horizons = normalizeTrailingHorizons(arg.split("=")[1]);
    else if (arg.startsWith("--cohorts=")) out.cohorts = normalizeTrailingCohorts(arg.split("=")[1]);
    else if (arg.startsWith("--sections=")) out.sections = arg.split("=")[1];
    else if (arg.startsWith("--min-coverage=")) out.minCoveragePct = Number(arg.split("=")[1]);
    else if (arg.startsWith("--friction-bps=")) out.frictionBps = Number(arg.split("=")[1]);
    else if (arg.startsWith("--end-date=")) out.endDate = arg.split("=")[1];
    else if (arg.startsWith("--concurrency=")) out.concurrency = Math.max(1, Number.parseInt(arg.split("=")[1], 10));
    else if (arg.startsWith("--output-date=")) out.outputDate = arg.split("=")[1];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, filePath);
}

function addDays(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function subtractYears(dateKey, years) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function earliestFetchDate(endDate, horizons) {
  const years = Math.max(...horizons.map((h) => Number.parseInt(h, 10)).filter(Number.isFinite));
  return addDays(subtractYears(endDate, years), -20);
}

function latestGitAddDate() {
  try {
    const raw = execFileSync("git", [
      "log",
      "--follow",
      "--diff-filter=A",
      "--format=%ad",
      "--date=short",
      "--",
      "data/sws/picks-latest.json",
    ], { cwd: ROOT, encoding: "utf8" }).trim();
    return raw.split("\n").filter(Boolean).at(-1) || raw.split("\n").filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

async function fetchHistory(symbol, period1, period2) {
  try {
    const result = await yf.chart(symbol, { period1, period2, interval: "1d" });
    const quotes = result?.quotes || [];
    return quotes
      .filter((q) => q?.date && q.close != null)
      .map((q) => ({ date: q.date, close: q.close }));
  } catch (err) {
    console.warn(`[audit] ${symbol} fetch failed: ${err.message}`);
    return [];
  }
}

async function fetchHistories(symbols, period1, period2, concurrency) {
  const unique = [...new Set(symbols.filter(Boolean))];
  const histories = new Map();
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < unique.length) {
      const index = cursor++;
      const symbol = unique[index];
      histories.set(symbol, await fetchHistory(symbol, period1, period2));
      completed++;
      if (completed % 20 === 0 || completed === unique.length) {
        console.log(`[audit] fetched ${completed}/${unique.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker()));
  return histories;
}

function collectSymbols(picksData, opts) {
  const rows = buildCurrentCohortRows(picksData, opts);
  const symbols = new Set();
  for (const row of rows) {
    for (const c of row.constituents || []) {
      const symbol = c.symbol || canonicalYahooSymbol(c.ticker);
      if (symbol) symbols.add(symbol);
    }
  }
  return [...symbols];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const picksData = readJson(PICKS_PATH);
  const endDate = opts.endDate || String(picksData.scanned_at || new Date().toISOString()).slice(0, 10);
  const period1 = earliestFetchDate(endDate, opts.horizons);
  const period2 = addDays(endDate, 5);
  const symbols = collectSymbols(picksData, opts);
  console.log(`[audit] mode=research_only_current_cohort_trailing end=${endDate} symbols=${symbols.length} benchmark=${BENCHMARK_SYMBOL}`);
  console.log("[audit] warning: this is not a held-cohort Track Record backtest");

  if (opts.dryRun) {
    console.log(`[audit] dry-run would fetch ${period1}..${period2}`);
    return;
  }

  const histories = await fetchHistories(symbols, period1, period2, opts.concurrency);
  const benchmarkBars = await fetchHistory(BENCHMARK_SYMBOL, period1, period2);
  const payload = buildCurrentCohortTrailingAudit(picksData, histories, benchmarkBars, {
    ...opts,
    endDate,
    committedSwsSnapshotStart: latestGitAddDate(),
  });
  const markdown = renderCurrentCohortTrailingMarkdown(payload);
  const outputDate = opts.outputDate || new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(REPORTS_DIR, `sws-current-cohort-trailing-${outputDate}.json`);
  const mdPath = path.join(REPORTS_DIR, `sws-current-cohort-trailing-${outputDate}.md`);
  writeAtomic(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeAtomic(mdPath, markdown);
  console.log(`[audit] wrote ${path.relative(ROOT, jsonPath)}`);
  console.log(`[audit] wrote ${path.relative(ROOT, mdPath)}`);

  const best = [...(payload.results || [])]
    .filter((r) => Number.isFinite(r.alpha_pct) && r.coverage_pass)
    .sort((a, b) => b.alpha_pct - a.alpha_pct)[0];
  if (best) {
    console.log(`[audit] best proxy row: ${best.horizon} ${best.label} top ${best.requested_cohort_size} alpha=${best.alpha_pct}% coverage=${best.coverage_pct}% claim_allowed=${best.claim_allowed}`);
  } else {
    console.log("[audit] no coverage-passing proxy row found");
  }

  if (opts.stdoutJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((err) => {
  console.error("[audit] failed:", err?.stack || err?.message || err);
  process.exit(1);
});
