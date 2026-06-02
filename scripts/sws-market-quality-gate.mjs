#!/usr/bin/env node
/**
 * Fail-closed auto-ship gate for US/KR/TW modal-enrichment artifacts.
 *
 * This gate is intentionally about publishing, not scrape success. A failed
 * gate should leave local generated files inspectable and skip the PR/merge.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMarketQualitySummary, MARKET_CANARIES } from "./sws-market-quality-summary.mjs";

const MIN_DEEP_COVERAGE_RATIO = 0.95;
const MIN_REWARDS_RATIO = 0.2;

function parseArgs(argv = process.argv.slice(2)) {
  const out = { market: null, summaryPath: null, minScored: null, human: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--market") out.market = argv[++i];
    else if (a.startsWith("--market=")) out.market = a.slice("--market=".length);
    else if (a === "--summary") out.summaryPath = argv[++i];
    else if (a.startsWith("--summary=")) out.summaryPath = a.slice("--summary=".length);
    else if (a === "--min-scored") out.minScored = Number(argv[++i]);
    else if (a.startsWith("--min-scored=")) out.minScored = Number(a.slice("--min-scored=".length));
    else if (a === "--human") out.human = true;
  }
  if (!out.market || !MARKET_CANARIES[out.market]) {
    throw new Error("usage: sws-market-quality-gate.mjs --market <us|kr|tw> [--summary file] [--min-scored N]");
  }
  return out;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function loadSummary(args) {
  if (args.summaryPath) return JSON.parse(fs.readFileSync(args.summaryPath, "utf8"));
  const stdin = readStdin();
  if (stdin) return JSON.parse(stdin);
  return buildMarketQualitySummary(args.market);
}

function ratio(n, d) {
  return d > 0 ? n / d : 0;
}

function finding(name, message, severity = "BLOCK", detail = {}) {
  return { name, message, severity, detail };
}

export function evaluateQualityGate(summary, opts = {}) {
  const market = opts.market || summary.market;
  const canaries = MARKET_CANARIES[market] || [];
  const failures = [];
  const warnings = [];
  const scanned = Number(summary.deep_files_scanned || 0);
  const minScored = Number.isFinite(opts.minScored) ? opts.minScored : null;
  const denominator = minScored && minScored > 0 ? minScored : scanned;

  if (Array.isArray(summary.source_problems) && summary.source_problems.length) {
    failures.push(finding("no_source_problems", "source artifact has quality problems", "BLOCK", { source_problems: summary.source_problems }));
  }
  if (summary.source !== "tarball") failures.push(finding("source_is_tarball", `source is ${summary.source || "unknown"}; deployable tarball was not scanned`));
  if (!summary.tarball_exists && summary.source !== "tarball") failures.push(finding("tarball_present", "deep tarball is missing"));
  if (minScored && scanned < Math.floor(minScored * MIN_DEEP_COVERAGE_RATIO)) {
    failures.push(finding("deep_files_scanned_floor", `deep_files_scanned ${scanned} is below ${Math.floor(minScored * MIN_DEEP_COVERAGE_RATIO)} (${Math.round(MIN_DEEP_COVERAGE_RATIO * 100)}% of min scored)`));
  }
  if (scanned === 0) failures.push(finding("deep_files_scanned_nonzero", "no deep files scanned"));

  const rewardsRatio = ratio(Number(summary.rewards_populated_count || 0), denominator || scanned);
  if (denominator > 0 && rewardsRatio < MIN_REWARDS_RATIO) {
    failures.push(finding("rewards_not_near_zero", `rewards coverage ${(rewardsRatio * 100).toFixed(1)}% is below ${(MIN_REWARDS_RATIO * 100).toFixed(0)}%`));
  }
  const risksRatio = ratio(Number(summary.risks_populated_count || 0), denominator || scanned);
  if (denominator > 0 && risksRatio < 0.1) {
    warnings.push(finding("risks_populated_visibility", `risks coverage ${(risksRatio * 100).toFixed(1)}% is below 10%; risks can legitimately be empty`, "WARN"));
  }

  const agg = summary.news_aggregate || {};
  const progress = summary.news_progress || {};
  if (!(agg.exists || agg.present)) failures.push(finding("news_aggregate_present", "news-latest.json aggregate is missing after news enrichment"));
  if ((agg.exists || agg.present) && Number(agg.items_count || 0) <= 0) failures.push(finding("news_aggregate_has_items", "news aggregate has no items"));
  if ((progress.exists || progress.present) && progress.aborted) failures.push(finding("news_progress_not_aborted", "news progress reports aborted=true"));
  if ((progress.exists || progress.present) && Number(progress.done_count || 0) <= 0) failures.push(finding("news_progress_has_done_count", "news progress has no completed tickers"));
  if ((progress.exists || progress.present) && Number(progress.failed_count || 0) > 0) {
    warnings.push(finding("news_progress_failed_count", `news progress has ${progress.failed_count} failed ticker(s)`, "WARN"));
  }

  const results = summary.canary_results || {};
  for (const ticker of canaries) {
    const c = results[ticker] || {};
    if (!c.present) {
      failures.push(finding(`canary_present:${ticker}`, `canary ${ticker} missing from deep tarball`));
      continue;
    }
    if (Number(c.news_count || 0) <= 0) failures.push(finding(`canary_has_news:${ticker}`, `canary ${ticker} has no news[]`));
    if (Number(c.rewards_count || 0) <= 0) failures.push(finding(`canary_has_rewards:${ticker}`, `canary ${ticker} has no rewards[]`));
    if (!Number.isFinite(Number(c.risks_count))) warnings.push(finding(`canary_has_risks_array:${ticker}`, `canary ${ticker} has no risks array`, "WARN"));
  }

  return {
    ok: failures.length === 0,
    market,
    failures,
    warnings,
    summary: {
      source: summary.source,
      deep_files_scanned: scanned,
      news_populated_count: summary.news_populated_count ?? 0,
      rewards_populated_count: summary.rewards_populated_count ?? 0,
      risks_populated_count: summary.risks_populated_count ?? 0,
      tarball_mtime: summary.tarball_mtime ?? null,
    },
  };
}

export function evaluateMarketQuality(summary, opts = {}) {
  const report = evaluateQualityGate(summary, opts);
  return {
    ...report,
    blocks: report.failures.map((f) => f.message),
    warnings: report.warnings.map((w) => w.message),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs();
    const summary = loadSummary(args);
    const result = evaluateQualityGate(summary, { market: args.market, minScored: args.minScored });
    if (args.human) {
      const label = result.ok ? "PASS" : "FAIL";
      console.log(`[market-quality-gate] ${args.market}: ${label}`);
      for (const b of result.failures) console.log(`  BLOCK: ${b.message}`);
      for (const w of result.warnings) console.log(`  WARN: ${w.message}`);
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`[market-quality-gate] ${error.message}`);
    process.exit(2);
  }
}
