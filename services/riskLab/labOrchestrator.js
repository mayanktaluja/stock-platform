/**
 * Risk Lab — orchestrator.
 *
 * Single entry point: runRiskLab(opts) reads picks-latest + macroRegime,
 * runs the Macro Lens (and, per PR 7, the Quality Lens), and writes the
 * parallel data files to data/risk-lab/.
 *
 * Hard rule (per plan, user-mandated): the orchestrator is READ-ONLY on
 * production files. It does not modify data/sws/picks-latest.json,
 * data/macroRegime.json, or any /api/picks-* output. The only write
 * targets are inside data/risk-lab/.
 *
 * Errors are non-fatal at the per-row level: a malformed row gets a
 * default zero-adjustment record so the downstream UI never has to
 * handle missing entries. A whole-file failure (missing picks-latest)
 * returns an empty output rather than throwing.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { adjustedScoreForRow } from "./macro/adjustedScorer.js";
import { computeQualityScore } from "./quality/qualityScorer.js";
import { classifyBatch as classifyLlmDisagreementBatch } from "./quality/llmDisagreementBatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PICKS_PATH = path.join(REPO_ROOT, "data", "sws", "picks-latest.json");
const REGIME_PATH = path.join(REPO_ROOT, "data", "macroRegime.json");
const DEEP_DIR = path.join(REPO_ROOT, "data", "sws", "deep");
const OUT_DIR = path.join(REPO_ROOT, "data", "risk-lab");
const OUT_PICKS_PATH = path.join(OUT_DIR, "picks-adjusted-latest.json");
const OUT_QUALITY_FLAGS_PATH = path.join(OUT_DIR, "quality-flags-latest.json");

const SCHEMA_VERSION = "risk-lab-picks-v2";

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.warn(`[risk-lab] failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

function writeJsonAtomic(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  // writeFile+rename matches refresh-macro-regime.mjs's writeAtomic — the
  // lab file isn't read mid-write by any concurrent consumer (API loads it
  // fresh per request), but atomicity prevents a partial file from being
  // read on cold start if the writer is interrupted.
  renameSync(tmp, filePath);
}

/**
 * Walk every section of picks-latest, dedup by ticker (keeping the first
 * occurrence — top_ranked_30_v3 / deep_value / etc. can carry the same
 * stock; the canonical row is whichever section happens to come first in
 * iteration order, which matches existing UI behaviour).
 */
function collectUniqueRows(picks) {
  if (!picks || !picks.sections || typeof picks.sections !== "object") return [];
  const seen = new Set();
  const out = [];
  for (const rows of Object.values(picks.sections)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const ticker = row?.ticker;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push(row);
    }
  }
  return out;
}

/**
 * Lazy in-process cache of SWS deep briefs. The orchestrator runs once
 * per cron fire and exits, so this never grows unbounded — it just
 * dedups repeat reads if a ticker appears in multiple sections.
 */
function makeDeepLoader(deepDir = DEEP_DIR) {
  const cache = new Map();
  return function loadDeep(ticker) {
    if (!ticker) return null;
    if (cache.has(ticker)) return cache.get(ticker);
    const filePath = path.join(deepDir, `${ticker}.json`);
    if (!existsSync(filePath)) {
      cache.set(ticker, null);
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      cache.set(ticker, parsed);
      return parsed;
    } catch {
      cache.set(ticker, null);
      return null;
    }
  };
}

/**
 * Pull the fields the quality scorer needs from an SWS deep brief.
 * Returns null when the brief is missing or malformed.
 */
function extractDeepQualityInputs(deep) {
  if (!deep || typeof deep !== "object") return null;
  const overview = deep.overview || {};
  return {
    risks: Array.isArray(overview.risks) ? overview.risks : Array.isArray(deep.risks) ? deep.risks : [],
    news: Array.isArray(deep.news) ? deep.news : Array.isArray(overview.news) ? overview.news : [],
  };
}

/**
 * Build the lab output payload from picks + regime. Returns a structure
 * suitable for direct JSON.stringify and projection by the API in PR 8.
 *
 * Now wires BOTH the Macro Lens (PR 1-2) and Quality Lens (PR 3-6) per
 * stock. Each stock entry carries:
 *   - macro_*    fields from adjustedScoreForRow (PR 1)
 *   - quality_*  fields from computeQualityScore (PR 6)
 */
export function buildLabPayload(picks, regime, opts = {}) {
  const now = opts.now || new Date();
  const rows = collectUniqueRows(picks);
  const loadDeep = opts.loadDeep || makeDeepLoader(opts.deepDir);

  const adjustments = rows.map((row) => {
    let macro = {};
    let quality = {};
    let qualityFailed = false;

    try {
      macro = adjustedScoreForRow(row, regime, opts);
    } catch (err) {
      macro = {
        ticker: row?.ticker || null,
        original_score: Number(row?.v4_score_100 ?? row?.score ?? 0),
        original_verdict: row?.v4_verdict || null,
        macro_score_delta: 0,
        macro_adjusted_score: Number(row?.v4_score_100 ?? row?.score ?? 0),
        macro_adjusted_verdict: row?.v4_verdict || null,
        macro_veto: { vetoed: false, reason: null, regime: null, severity: null, sectorImpact: 0 },
        error: err.message,
      };
    }

    try {
      const deep = loadDeep(row?.ticker);
      const deepInputs = extractDeepQualityInputs(deep) || { risks: [], news: [] };
      quality = computeQualityScore({
        ticker: row?.ticker || null,
        original_score: Number(row?.v4_score_100 ?? row?.score ?? 0),
        original_verdict: row?.v4_verdict || row?.verdict || null,
        original_confidence: null, // picks rows don't carry a predictor confidence
        v4_breakdown: row?.v4_breakdown || null,
        sector: row?.sector || null,
        counter_thesis: row?.counter_thesis || null,
        risks: deepInputs.risks,
        news: deepInputs.news,
        event_iso_date: row?.next_earnings_date || null,
      }, { now: opts.now });
    } catch (err) {
      qualityFailed = true;
      quality = {
        quality_flags: [],
        quality_score_delta: 0,
        quality_adjusted_score: Number(row?.v4_score_100 ?? row?.score ?? 0),
        quality_adjusted_verdict: row?.v4_verdict || null,
        quality_verdict: "INSUFFICIENT_DATA",
        combined_verdict: null,
        quality_veto: { vetoed: false, reason: null },
        error: err.message,
      };
    }

    // Merge macro + quality into one row. macro_* and quality_* don't
    // collide; we copy macro first then quality.
    return {
      ...macro,
      // Quality fields (avoid clobbering macro's ticker/original_* fields)
      quality_flags: quality.quality_flags,
      quality_score_delta: quality.quality_score_delta,
      quality_adjusted_score: quality.quality_adjusted_score,
      quality_adjusted_verdict: quality.quality_adjusted_verdict,
      quality_adjusted_confidence: quality.quality_adjusted_confidence,
      quality_verdict: quality.quality_verdict,
      combined_verdict: quality.combined_verdict,
      quality_veto: quality.quality_veto,
      ...(qualityFailed ? { quality_error: quality.error } : {}),
    };
  });

  // Summary metrics for the UI banner and PR 13 telemetry
  const macroVetoed = adjustments.filter((a) => a.macro_veto?.vetoed).length;
  const qualityVetoed = adjustments.filter((a) => a.quality_veto?.vetoed).length;
  const macroFlagged = adjustments.filter((a) => a.macro_score_delta !== 0).length;
  const qualityFlagged = adjustments.filter((a) => (a.quality_flags?.length || 0) > 0).length;
  const stale = adjustments.filter((a) => a.regime_stale).length;
  const lowQuality = adjustments.filter((a) => a.quality_verdict === "LOW").length;
  const insufficientQuality = adjustments.filter((a) => a.quality_verdict === "INSUFFICIENT_DATA").length;

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    source_picks_scanned_at: picks?.scanned_at || null,
    source_regime_generated_at: regime?.generatedAt || null,
    regime: regime
      ? {
          regime: regime.regime,
          regimeLabel: regime.regimeLabel,
          severity: regime.severity,
          confidence: regime.confidence,
          sectorImpacts: regime.sectorImpacts || [],
        }
      : null,
    summary: {
      total_stocks: adjustments.length,
      // Macro lens metrics
      macro_flagged_count: macroFlagged,
      macro_vetoed_count: macroVetoed,
      macro_stale_skipped_count: stale,
      // Quality lens metrics
      quality_flagged_count: qualityFlagged,
      quality_vetoed_count: qualityVetoed,
      low_quality_count: lowQuality,
      insufficient_quality_data_count: insufficientQuality,
      // v1 alias kept one release for any consumer still on the old field names
      flagged_count: macroFlagged,
      vetoed_count: macroVetoed,
      stale_skipped_count: stale,
    },
    stocks: adjustments,
  };
}

/**
 * Build the quality-flags drill-down payload — flat array of every
 * stock that has at least one quality flag, with the full flag detail.
 * Used by the /api/risk-lab/quality-flags/:ticker endpoint in PR 8.
 */
export function buildQualityFlagsPayload(stocks, opts = {}) {
  const now = opts.now || new Date();
  if (!Array.isArray(stocks)) {
    return { schema_version: "risk-lab-quality-flags-v1", generated_at: now.toISOString(), stocks: [] };
  }
  const withFlags = stocks
    .filter((s) => Array.isArray(s.quality_flags) && s.quality_flags.length > 0)
    .map((s) => ({
      ticker: s.ticker,
      original_score: s.original_score,
      original_verdict: s.original_verdict,
      quality_verdict: s.quality_verdict,
      combined_verdict: s.combined_verdict,
      quality_score_delta: s.quality_score_delta,
      quality_adjusted_score: s.quality_adjusted_score,
      quality_adjusted_confidence: s.quality_adjusted_confidence,
      quality_veto: s.quality_veto,
      flags: s.quality_flags,
      // PR 2-3 — LLM disagreement check (per-stock authoritative override).
      // null when the stock was below the V3≥50 floor or the LLM was
      // unavailable; the API surfaces it so the UI can show the
      // classifier provider + top_reason.
      llm_disagreement_check: s.llm_disagreement_check || null,
    }));
  return {
    schema_version: "risk-lab-quality-flags-v1",
    generated_at: now.toISOString(),
    total_with_flags: withFlags.length,
    stocks: withFlags,
  };
}

/**
 * Top-level runner: read files, compute, write outputs. Returns the
 * payloads + paths written so the caller can log a one-liner.
 *
 * Writes TWO files (Phase 2 onwards):
 *   - data/risk-lab/picks-adjusted-latest.json (full per-stock rows)
 *   - data/risk-lab/quality-flags-latest.json   (drill-down for UI tooltips)
 */
export function runRiskLab(opts = {}) {
  const picksPath = opts.picksPath || PICKS_PATH;
  const regimePath = opts.regimePath || REGIME_PATH;
  const outPath = opts.outPath || OUT_PICKS_PATH;
  const qualityFlagsOutPath = opts.qualityFlagsOutPath || OUT_QUALITY_FLAGS_PATH;

  const picks = readJsonSafe(picksPath);
  const regime = readJsonSafe(regimePath);

  const payload = buildLabPayload(picks, regime, opts);
  const qualityPayload = buildQualityFlagsPayload(payload.stocks, opts);

  if (!opts.dryRun) {
    writeJsonAtomic(outPath, payload);
    writeJsonAtomic(qualityFlagsOutPath, qualityPayload);
  }

  return {
    payload,
    qualityPayload,
    outPath,
    qualityFlagsOutPath,
    dryRun: !!opts.dryRun,
  };
}

/**
 * Async wrapper that runs the LLM disagreement checker after the sync
 * orchestrator, patches the result onto each stock, and re-writes the
 * picks-adjusted file. PR 2-3 (2026-05-19): turns the boilerplate-heavy
 * heuristic into a discriminating LLM-backed signal for V3≥50 BEAT
 * candidates.
 *
 * The sync `runRiskLab` is still the source of truth for everything
 * except the `llm_disagreement_check` field. If the LLM step fails or
 * the env has no keys, every stock falls back to the same heuristic
 * the sync run already uses — so the system is no worse than before
 * even when the LLM is unreachable.
 */
export async function runRiskLabWithLlm(opts = {}) {
  const sync = runRiskLab({ ...opts, dryRun: true });
  const stocks = sync.payload.stocks || [];

  // Build the LLM batcher inputs from each stock + the loaded SWS deep data.
  const loadDeep = opts.loadDeep || makeDeepLoader(opts.deepDir);
  // Reload picks to recover the counter_thesis/news for each ticker —
  // the synced payload omits the raw text to keep the JSON small.
  const picks = readJsonSafe(opts.picksPath || PICKS_PATH);
  const rowByTicker = new Map();
  for (const r of collectUniqueRows(picks)) {
    if (r?.ticker) rowByTicker.set(r.ticker, r);
  }

  // PR 3 — the LLM disagreement check is event-level: it asks "does the
  // production BEAT/INLINE/MISS prediction look wrong for this stock?".
  // Picks-latest carries TOP_PICK/STRONG verdicts, NOT BEAT/INLINE/MISS,
  // so we have to join the earnings-watch calendar to learn which
  // tickers actually have an upcoming earnings event AND what the
  // predictor said. Stocks without an upcoming event get a null
  // llm_disagreement_check (the heuristic in earningsLabView.js still
  // applies as fallback).
  const earningsPath = opts.earningsWatchPath
    || path.join(__dirname, "..", "..", "data", "catalysts", "earnings-watch-latest.json");
  const earnings = readJsonSafe(earningsPath);
  const eventByTicker = new Map();
  for (const e of (earnings?.events || earnings?.calendar || [])) {
    if (!e?.symbol) continue;
    const t = String(e.symbol).toUpperCase();
    // First (closest) event wins per ticker — the calendar is sorted by date.
    if (!eventByTicker.has(t)) eventByTicker.set(t, e);
  }

  const batchInputs = stocks.map((s) => {
    const row = rowByTicker.get(s.ticker) || {};
    const deep = loadDeep(s.ticker);
    const deepInputs = extractDeepQualityInputs(deep) || { risks: [], news: [] };
    const event = eventByTicker.get(String(s.ticker || "").toUpperCase());
    const prodVerdict = event?.prediction?.verdict || null;
    const prodConf = typeof event?.prediction?.confidence_pct === "number"
      ? event.prediction.confidence_pct
      : null;
    return {
      ticker: s.ticker,
      sector: row.sector || s.original_sector || null,
      predicted_verdict: prodVerdict,
      predicted_confidence_pct: prodConf,
      v4_score: s.original_score,
      counter_thesis_text: typeof row.counter_thesis === "string"
        ? row.counter_thesis
        : (row.counter_thesis?.bull_thesis_summary || row.counter_thesis?.text || ""),
      falsification_triggers: Array.isArray(row.counter_thesis?.falsification_triggers)
        ? row.counter_thesis.falsification_triggers
        : [],
      risks: deepInputs.risks || [],
      news: deepInputs.news || [],
      macro_veto: s.macro_veto,
      quality_flags: s.quality_flags || [],
    };
  });

  const llmResult = await classifyLlmDisagreementBatch(batchInputs, {
    skipLlm: opts.skipLlm,
    maxLlmCalls: opts.maxLlmCalls,
    concurrency: opts.llmConcurrency,
    cachePath: opts.llmCachePath,
  });

  // Patch the assessments back onto each stock row.
  for (let i = 0; i < stocks.length; i++) {
    stocks[i].llm_disagreement_check = llmResult.decisions[i] || null;
  }

  sync.payload.llm_disagreement_stats = llmResult.stats;
  // Rebuild quality flags payload so consumers see the LLM check too.
  const qualityPayload = buildQualityFlagsPayload(stocks, opts);

  if (!opts.dryRun) {
    writeJsonAtomic(sync.outPath, sync.payload);
    writeJsonAtomic(sync.qualityFlagsOutPath, qualityPayload);
  }

  return {
    ...sync,
    qualityPayload,
    llm: llmResult.stats,
    dryRun: !!opts.dryRun,
  };
}
