#!/usr/bin/env node
/**
 * SWS sanity gate — Phase 1 (Layers 1, 2, 3, 6).
 *
 * Runs after sws-refresh-api.sh completes; sws-nightly.sh invokes it and
 * gates the push to prod on the exit code.
 *
 * Layers
 *   L1 — Run integrity   (last-refresh.json: shards, counts, freshness)
 *   L2 — Coverage audit  (universe vs deep/, parsed_at window, failed.json)
 *   L3 — Data sanity     (per-stock numeric clamps, snowflake range, UUIDs)
 *   L6 — Picks coherence (picks-latest internal consistency)
 *
 * Exit codes
 *   0 — no BLOCK violations (verdict PASS or WARN)
 *   1 — at least one BLOCK violation (verdict FAIL)
 *
 * Outputs
 *   stdout                              — human-readable per-layer summary
 *   data/sws/_sanity/<runId>.json       — full machine-readable report
 *   data/sws/_sanity/_latest.json       — copy of the latest report
 *
 * Phase 1 policy: existing gate's BLOCK checks keep BLOCK severity AND
 * keep their existing thresholds. NEW checks introduced by this gate
 * are WARN-only — they surface in email + PR body for ~1 week, then
 * individual checks get flipped to BLOCK once thresholds are calibrated.
 *
 * Threshold-split note: MIN_SCORED_COUNT and MIN_NEWS_POPULATED preserve
 * the existing inline-gate values (5000 / 1000) as BLOCK. Tighter values
 * (5400 / 1500) are surfaced as separate WARN checks; flip to BLOCK once
 * a week of clean runs confirms they're rarely tripped.
 */

import * as dal from "../services/swsDal/index.js";
import { closeDb } from "../db/client.js";

const RUN_ID = process.env.SWS_RUN_ID || null;

import {
  readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, copyFileSync,
} from "fs";
import path from "path";

// ----------------------------- paths ------------------------------------

const ROOT = "data/sws";
const SANITY_DIR = path.join(ROOT, "_sanity");
const PANIC_FLAG = path.join(ROOT, "panic-stop.flag");

const LAST_REFRESH = path.join(ROOT, "last-refresh.json");
const PICKS = path.join(ROOT, "picks-latest.json");
const SCORED = path.join(ROOT, "sws-scored-universe.json");
const UNIVERSE = path.join(ROOT, "universe.json");
const DEEP_DIR = path.join(ROOT, "deep");
const FAILED = path.join(ROOT, "failed.json");
const MACRO_REGIME = path.join("data", "macroRegime.json");

// --------------------------- thresholds ---------------------------------

// L1 — preserved BLOCK thresholds match the prior inline gate.
const MIN_SCORED_COUNT          = 5000;   // BLOCK — preserved from inline gate
const MIN_SCORED_COUNT_STRONG   = 5400;   // WARN — flip to BLOCK after ~1 wk calibration
const MIN_NEWS_POPULATED        = 1000;   // BLOCK — preserved from inline gate
const MIN_NEWS_POPULATED_STRONG = 1500;   // WARN — flip to BLOCK after ~1 wk calibration
const MAX_RUN_DURATION_SEC      = 6 * 3600;
const PICKS_MAX_AGE_HOURS       = 6;

// L2
const MAX_SILENT_DROP        = 5;       // tickers in universe but missing from deep
const RUN_WINDOW_HOURS       = 24;      // parsed_at within this window = "fresh"
const STALE_FILE_HOURS       = 48;
const MIN_FRESH_PCT          = 95;
const STALE_WARN_PCT         = 5;
const FAILED_LOG_MAX         = 100;
const FAILED_RETRY_TOLERANCE = 10;      // tickers in failed.json still not refreshed

// L3
const SANE = {
  pe:                  { min: 0,    max: 500,   inclusive: false },
  payout_pct:          { min: 0,    max: 200,   inclusive: true  },
  fair_value_inr:      { min: 0,    max: null,  inclusive: false },
  upside_pct:          { min: -95,  max: 500,   inclusive: true  },
  market_cap_inr:      { min: 0,    max: null,  inclusive: false },
  dividend_yield_pct:  { min: 0,    max: 50,    inclusive: true  },
  v3_score_100:        { min: 0,    max: 100,   inclusive: true  },
};
const SANE_INSANE_WARN_PCT  = 0.1;      // unique-ticker insane >= 0.1% → WARN
const SANE_INSANE_BLOCK_PCT = 0.5;      // unique-ticker insane >= 0.5% → BLOCK
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// L6
const TOP_PICK_MIN_SCORE     = 60;
const MIN_BEST_TO_BUY_NOW    = 20;
const MIN_UPCOMING_EARNINGS  = 50;

// ---------------------------- severities -------------------------------

const BLOCK = "BLOCK";
const WARN  = "WARN";

// ---------------------------- finding store ----------------------------

const findings = []; // { layer, name, severity, ok, detail }

function record(layer, name, severity, ok, detail = {}) {
  findings.push({ layer, name, severity, ok, detail });
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf-8")); }
  catch { return null; }
}

function isInsane(value, range) {
  if (value === null || value === undefined) return false; // null is allowed
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  const { min, max, inclusive } = range;
  if (min !== null && (inclusive ? value < min : value <= min)) return true;
  if (max !== null && (inclusive ? value > max : value >= max)) return true;
  return false;
}

// ============================== L1 =====================================

function layer1(lr, picks) {
  const layer = "L1_run_integrity";

  if (!lr) {
    record(layer, "last_refresh_present", BLOCK, false, { reason: "last-refresh.json missing" });
    return;
  }
  record(layer, "last_refresh_present", BLOCK, true);

  record(layer, "shards_failed_zero", BLOCK,
    (lr.shards_failed ?? 0) === 0,
    { shards_failed: lr.shards_failed });

  record(layer, "scrape_not_skipped", WARN,
    lr.scrape_skipped !== true,
    { scrape_skipped: lr.scrape_skipped });

  record(layer, "scored_count_threshold", BLOCK,
    (lr.scored_count ?? 0) >= MIN_SCORED_COUNT,
    { scored_count: lr.scored_count, threshold: MIN_SCORED_COUNT });

  record(layer, "scored_count_strong_threshold", WARN,
    (lr.scored_count ?? 0) >= MIN_SCORED_COUNT_STRONG,
    { scored_count: lr.scored_count, threshold: MIN_SCORED_COUNT_STRONG });

  record(layer, "duration_within_bounds", WARN,
    (lr.duration_seconds ?? 0) > 0 && (lr.duration_seconds ?? 0) < MAX_RUN_DURATION_SEC,
    { duration_seconds: lr.duration_seconds, max: MAX_RUN_DURATION_SEC });

  record(layer, "panic_flag_absent", BLOCK, !existsSync(PANIC_FLAG));

  record(layer, "news_populated_threshold", BLOCK,
    (lr.news_populated_count ?? 0) >= MIN_NEWS_POPULATED,
    { news_populated_count: lr.news_populated_count, threshold: MIN_NEWS_POPULATED });

  record(layer, "news_populated_strong_threshold", WARN,
    (lr.news_populated_count ?? 0) >= MIN_NEWS_POPULATED_STRONG,
    { news_populated_count: lr.news_populated_count, threshold: MIN_NEWS_POPULATED_STRONG });

  if (picks?.scanned_at) {
    const ageHrs = (Date.now() - new Date(picks.scanned_at).getTime()) / 36e5;
    record(layer, "picks_recent", BLOCK,
      ageHrs < PICKS_MAX_AGE_HOURS,
      { age_hours: +ageHrs.toFixed(2), threshold: PICKS_MAX_AGE_HOURS });
  } else {
    record(layer, "picks_recent", BLOCK, false, { reason: "picks.scanned_at missing" });
  }

  const sec = picks?.sections || {};
  record(layer, "section_top30", BLOCK,
    (sec.top_ranked_30_v3?.length ?? 0) === 30,
    { count: sec.top_ranked_30_v3?.length });
  record(layer, "section_best_to_buy_now", BLOCK,
    (sec.best_to_buy_now?.length ?? 0) >= MIN_BEST_TO_BUY_NOW,
    { count: sec.best_to_buy_now?.length, threshold: MIN_BEST_TO_BUY_NOW });
  record(layer, "section_upcoming_earnings", BLOCK,
    (sec.upcoming_earnings?.length ?? 0) >= MIN_UPCOMING_EARNINGS,
    { count: sec.upcoming_earnings?.length, threshold: MIN_UPCOMING_EARNINGS });
}

// ============================== L2 =====================================

function layer2(lr) {
  const layer = "L2_coverage_audit";

  const universe = readJson(UNIVERSE);
  if (!universe || !Array.isArray(universe)) {
    record(layer, "universe_present", BLOCK, false);
    return;
  }
  record(layer, "universe_present", BLOCK, true);

  let deepFiles = [];
  try { deepFiles = readdirSync(DEEP_DIR).filter(f => f.endsWith(".json")); }
  catch (e) {
    record(layer, "deep_dir_present", BLOCK, false, { reason: e.message });
    return;
  }

  const universeTickers = new Set(universe.map(s => s.ticker).filter(Boolean));
  const deepTickers = new Set(deepFiles.map(f => f.replace(/\.json$/, "")));
  const missing = [...universeTickers].filter(t => !deepTickers.has(t));

  record(layer, "coverage_within_tolerance", WARN,
    missing.length <= MAX_SILENT_DROP,
    { missing_count: missing.length, tolerance: MAX_SILENT_DROP, sample: missing.slice(0, 10) });

  // Freshness window — anchored to last-refresh.finished_at if present.
  const finishedAt = lr?.finished_at ? new Date(lr.finished_at).getTime() : Date.now();
  const windowStart = finishedAt - RUN_WINDOW_HOURS * 36e5;
  const staleStart  = finishedAt - STALE_FILE_HOURS * 36e5;

  let freshCount = 0;
  let staleCount = 0;
  let unparsedCount = 0;
  const staleSample = [];

  for (const file of deepFiles) {
    let parsedAt = null;
    try {
      const d = JSON.parse(readFileSync(path.join(DEEP_DIR, file), "utf-8"));
      parsedAt = d.parsed_at ? new Date(d.parsed_at).getTime() : null;
    } catch { unparsedCount++; continue; }
    if (!parsedAt) { unparsedCount++; continue; }
    if (parsedAt >= windowStart) freshCount++;
    if (parsedAt < staleStart) {
      staleCount++;
      if (staleSample.length < 10) staleSample.push(file.replace(/\.json$/, ""));
    }
  }

  const total = deepFiles.length || 1;
  const freshPct = (freshCount / total) * 100;
  const stalePct = (staleCount / total) * 100;

  record(layer, "fresh_pct_threshold", WARN,
    freshPct >= MIN_FRESH_PCT,
    { fresh_pct: +freshPct.toFixed(2), threshold: MIN_FRESH_PCT, fresh_count: freshCount, total });

  record(layer, "stale_pct_threshold", WARN,
    stalePct < STALE_WARN_PCT,
    { stale_pct: +stalePct.toFixed(2), warn_at: STALE_WARN_PCT, sample: staleSample });

  record(layer, "unparsed_files", WARN,
    unparsedCount === 0,
    { unparsed_count: unparsedCount });

  // failed.json
  const failed = readJson(FAILED);
  const failedEntries = failed?.entries || [];
  record(layer, "failed_log_size_reasonable", WARN,
    failedEntries.length < FAILED_LOG_MAX,
    { failed_count: failedEntries.length, threshold: FAILED_LOG_MAX });

  let stillFailing = 0;
  const stillFailingSample = [];
  for (const e of failedEntries.slice(-50)) {
    const file = path.join(DEEP_DIR, `${e.ticker}.json`);
    let isStale = false;
    if (!existsSync(file)) isStale = true;
    else {
      try {
        const d = JSON.parse(readFileSync(file, "utf-8"));
        const t = d.parsed_at ? new Date(d.parsed_at).getTime() : 0;
        if (t < windowStart) isStale = true;
      } catch { isStale = true; }
    }
    if (isStale) {
      stillFailing++;
      if (stillFailingSample.length < 10) stillFailingSample.push(e.ticker);
    }
  }
  record(layer, "failed_tickers_retried", WARN,
    stillFailing < FAILED_RETRY_TOLERANCE,
    { still_failing_count: stillFailing, sample: stillFailingSample });
}

// ============================== L3 =====================================

function layer3() {
  const layer = "L3_data_sanity";

  const scored = readJson(SCORED);
  if (!scored) {
    record(layer, "scored_universe_present", BLOCK, false);
    return [];
  }
  const arr = Array.isArray(scored) ? scored : (scored.stocks || scored.universe || []);
  if (!arr.length) {
    record(layer, "scored_universe_nonempty", BLOCK, false);
    return [];
  }
  record(layer, "scored_universe_present", BLOCK, true);

  const offenders = []; // { ticker, field, value }

  // Pass 1: numeric fields available in scored-universe
  for (const s of arr) {
    if (isInsane(s.upside_pct, SANE.upside_pct))
      offenders.push({ ticker: s.ticker, field: "upside_pct", value: s.upside_pct });
    if (isInsane(s.fair_value_inr, SANE.fair_value_inr))
      offenders.push({ ticker: s.ticker, field: "fair_value_inr", value: s.fair_value_inr });
    if (isInsane(s.market_cap_inr, SANE.market_cap_inr))
      offenders.push({ ticker: s.ticker, field: "market_cap_inr", value: s.market_cap_inr });
    if (isInsane(s.v3_score_100, SANE.v3_score_100))
      offenders.push({ ticker: s.ticker, field: "v3_score_100", value: s.v3_score_100 });
  }

  // Pass 2: walk every deep file for fields not in scored-universe
  let deepScanned = 0;
  let deepReadErrors = 0;
  try {
    const deepFiles = readdirSync(DEEP_DIR).filter(f => f.endsWith(".json"));
    for (const file of deepFiles) {
      const ticker = file.replace(/\.json$/, "");
      let d;
      try { d = JSON.parse(readFileSync(path.join(DEEP_DIR, file), "utf-8")); }
      catch { deepReadErrors++; continue; }
      const ov = d.overview || {};
      const pe = ov.multiples?.pe;
      const payout = ov.dividend?.payout_pct;
      const dy = ov.dividend_yield_pct;
      const sf = ov.snowflake || {};

      if (isInsane(pe, SANE.pe))
        offenders.push({ ticker, field: "pe", value: pe });
      if (isInsane(payout, SANE.payout_pct))
        offenders.push({ ticker, field: "payout_pct", value: payout });
      if (isInsane(dy, SANE.dividend_yield_pct))
        offenders.push({ ticker, field: "dividend_yield_pct", value: dy });

      for (const k of ["valuation", "future", "past", "financial_health", "dividends"]) {
        const v = sf[k];
        if (v === null || v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 6) {
          offenders.push({ ticker, field: `snowflake.${k}`, value: v });
        }
      }

      if (d.company_id && !UUID_REGEX.test(d.company_id)) {
        offenders.push({ ticker, field: "company_id", value: d.company_id });
      }

      deepScanned++;
    }
  } catch (e) {
    record(layer, "deep_dir_walkable", BLOCK, false, { reason: e.message });
    return offenders;
  }
  record(layer, "deep_dir_walkable", BLOCK, true,
    { deep_files_scanned: deepScanned, read_errors: deepReadErrors });

  const total = arr.length || 1;
  const insanePct       = (offenders.length / total) * 100;
  const insaneTickers   = new Set(offenders.map(o => o.ticker));
  const insaneTickerPct = (insaneTickers.size / total) * 100;

  // Phase 1: insane-rate is WARN only. Bump to BLOCK once thresholds are
  // calibrated against ~1 week of clean runs.
  const ok = insaneTickerPct < SANE_INSANE_WARN_PCT;
  record(layer, "insane_value_rate", WARN, ok, {
    insane_pct: +insanePct.toFixed(3),
    insane_ticker_pct: +insaneTickerPct.toFixed(3),
    insane_finding_count: offenders.length,
    insane_unique_tickers: insaneTickers.size,
    warn_at: SANE_INSANE_WARN_PCT,
    block_at: SANE_INSANE_BLOCK_PCT,
    sample: offenders.slice(0, 25),
  });

  return offenders;
}

// ============================== L6 =====================================

function layer6(picks, scored, insaneOffenders) {
  const layer = "L6_picks_coherence";

  if (!picks?.sections) {
    record(layer, "picks_present", BLOCK, false);
    return;
  }
  record(layer, "picks_present", BLOCK, true);

  const scoredArr = Array.isArray(scored) ? scored : (scored?.stocks || scored?.universe || []);
  const scoredTickers = new Set(scoredArr.map(s => s.ticker));

  const allPicksTickers = new Set();
  const picksMissingFromScored = [];
  for (const [secName, list] of Object.entries(picks.sections)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item.ticker) continue;
      allPicksTickers.add(item.ticker);
      if (!scoredTickers.has(item.ticker)) {
        picksMissingFromScored.push({ section: secName, ticker: item.ticker });
      }
    }
  }
  record(layer, "picks_in_scored", WARN,
    picksMissingFromScored.length === 0,
    { missing_count: picksMissingFromScored.length, sample: picksMissingFromScored.slice(0, 10) });

  const picksMissingDeep = [];
  for (const t of allPicksTickers) {
    if (!existsSync(path.join(DEEP_DIR, `${t}.json`))) picksMissingDeep.push(t);
  }
  record(layer, "picks_have_deep_file", WARN,
    picksMissingDeep.length === 0,
    { missing_count: picksMissingDeep.length, sample: picksMissingDeep.slice(0, 10) });

  const top30 = picks.sections.top_ranked_30_v3 || [];
  let sortedDesc = true;
  for (let i = 1; i < top30.length; i++) {
    if ((top30[i].v3_score_100 ?? 0) > (top30[i - 1].v3_score_100 ?? 0)) {
      sortedDesc = false; break;
    }
  }
  record(layer, "top30_sorted_desc", WARN, sortedDesc);

  const subThresh = top30.filter(s => (s.v3_score_100 ?? 0) < TOP_PICK_MIN_SCORE);
  record(layer, "top30_above_threshold", WARN,
    subThresh.length === 0,
    { threshold: TOP_PICK_MIN_SCORE, violations: subThresh.length,
      sample: subThresh.slice(0, 5).map(s => ({ ticker: s.ticker, v3_score_100: s.v3_score_100 })) });

  const dupes = [];
  for (const [secName, list] of Object.entries(picks.sections)) {
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    for (const item of list) {
      if (!item.ticker) continue;
      if (seen.has(item.ticker)) dupes.push({ section: secName, ticker: item.ticker });
      seen.add(item.ticker);
    }
  }
  record(layer, "no_duplicate_picks", WARN,
    dupes.length === 0,
    { dupes_count: dupes.length, sample: dupes.slice(0, 10) });

  // Top picks must be free of insane values — the canary that protects users
  // from seeing an INFY-with-pe=1440 in the front-row recommendations.
  const insaneTickers = new Set((insaneOffenders || []).map(o => o.ticker));
  const topPicksInsane = [];
  for (const item of top30) {
    if (insaneTickers.has(item.ticker)) topPicksInsane.push(item.ticker);
  }
  record(layer, "top_picks_clean", WARN,
    topPicksInsane.length === 0,
    { insane_top_picks: topPicksInsane.slice(0, 10) });
}

// ============================== L_macro ================================
//
// Defensive belt-and-suspenders for the macro-regime cache. The cron-side
// fail-fast in scripts/refresh-macro-regime.mjs (exit 9) is the primary
// defense against silently shipping a keyword-only macroRegime.json — this
// gate is the second line in case .env is loaded but the keys inside it
// are empty/whitespace, or some future refresh path skips the fail-fast.
// WARN-only: a heuristic fallback is still a valid file, just degraded.
function layerMacro() {
  const layer = "L_macro_regime";
  const mr = readJson(MACRO_REGIME);
  if (!mr) {
    record(layer, "macro_regime_present", WARN, false, { reason: "data/macroRegime.json missing" });
    return;
  }
  const ph = mr.llmProviderHealth || {};
  const bothMissing = ph.groq === "not_configured" && ph.gemini === "not_configured";
  record(layer, "macro_llm_providers_configured", WARN,
    !bothMissing,
    { groq: ph.groq, gemini: ph.gemini, classifierProvider: mr.classifierProvider });
}

// ============================== main ===================================

function main() {
  const lr = readJson(LAST_REFRESH);
  const picks = readJson(PICKS);
  const scored = readJson(SCORED);

  const runId = (lr?.finished_at || new Date().toISOString()).replace(/[:.]/g, "-");

  layer1(lr, picks);
  layer2(lr);
  const insaneOffenders = layer3() || [];
  layer6(picks, scored, insaneOffenders);
  layerMacro();

  const blocks = findings.filter(f => !f.ok && f.severity === BLOCK);
  const warns  = findings.filter(f => !f.ok && f.severity === WARN);
  const passes = findings.filter(f => f.ok);

  const verdict = blocks.length > 0 ? "FAIL" : (warns.length > 0 ? "WARN" : "PASS");

  const layers = {};
  for (const f of findings) {
    if (!layers[f.layer]) layers[f.layer] = { pass: 0, warn: 0, block: 0, checks: [] };
    layers[f.layer].checks.push(f);
    if (f.ok) layers[f.layer].pass++;
    else if (f.severity === BLOCK) layers[f.layer].block++;
    else layers[f.layer].warn++;
  }

  const summaryLine = [
    `verdict=${verdict}`,
    `scored=${lr?.scored_count ?? "?"}`,
    `top30=${picks?.sections?.top_ranked_30_v3?.length ?? "?"}`,
    blocks.length ? `blocks=${blocks.length}` : null,
    warns.length ? `warns=${warns.length}` : null,
  ].filter(Boolean).join(" · ");

  const report = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    verdict,
    block_count: blocks.length,
    warn_count: warns.length,
    pass_count: passes.length,
    total_checks: findings.length,
    summary_line: summaryLine,
    layers,
    inputs: {
      scored_count: lr?.scored_count,
      universe_size: picks?.universe_size,
      finished_at: lr?.finished_at,
      pipeline_status: lr?.pipeline_status,
    },
  };

  try { mkdirSync(SANITY_DIR, { recursive: true }); } catch {}
  const reportPath = path.join(SANITY_DIR, `${runId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  try { copyFileSync(reportPath, path.join(SANITY_DIR, "_latest.json")); } catch {}

  // Human-readable stdout — captured by sws-nightly.sh and embedded in email.
  const lines = [];
  lines.push(`[sanity-gate] ${summaryLine}`);
  for (const [layerName, info] of Object.entries(layers)) {
    const layerVerdict = info.block > 0 ? "FAIL" : (info.warn > 0 ? "WARN" : "PASS");
    lines.push(`[sanity-gate] ${layerName}: ${layerVerdict}` +
      ` (${info.pass}/${info.checks.length} pass, ${info.warn} warn, ${info.block} block)`);
  }
  if (blocks.length) {
    lines.push(`[sanity-gate] BLOCKING violations:`);
    for (const f of blocks) {
      lines.push(`  - ${f.layer}/${f.name}: ${JSON.stringify(f.detail)}`);
    }
  }
  if (warns.length) {
    lines.push(`[sanity-gate] WARN findings:`);
    for (const f of warns) {
      lines.push(`  - ${f.layer}/${f.name}: ${JSON.stringify(f.detail)}`);
    }
  }
  lines.push(`[sanity-gate] report: ${reportPath}`);
  console.log(lines.join("\n"));

  // Phase 3 dual-write: mirror the report to Postgres. Verdict + counts
  // become queryable for the Vercel UI; full layers blob stays in JSONB.
  if (RUN_ID && dal.isDualWriteEnabled()) {
    dal.recordSanityReport(RUN_ID, report)
      .then(() => closeDb())
      .catch((e) => console.warn(`[sanity-gate] DAL write failed: ${e.message}`))
      .finally(() => process.exit(blocks.length > 0 ? 1 : 0));
    return;
  }

  process.exit(blocks.length > 0 ? 1 : 0);
}

main();
