/**
 * combinedScore.js — Tech + Fundamentals + SWS combined-score module.
 *
 * Pure-math compute() + bulk SWS-index lookup helpers. Used by every
 * scanner endpoint (Buy-Now / Midterm / Sell / Fundamental / Small-Cap).
 *
 * Weighting: horizon-adaptive per scanner. Defended in
 *   /Users/mayanktaluja/.claude/plans/create-a-plan-to-witty-harp.md
 * Equal 33/33/33 is retained as `uniform` for the methodology footer
 * disclosure and A/B backtest only — never a default sort.
 *
 * Data sources:
 *   - data/sws/sws-scored-universe.json  — pre-built bulk index (5,439 stocks).
 *   - data/sws/last-refresh.json         — refresh metadata for footer.
 *   - services/swsHoldingEngine.js::loadSWSDeep — per-ticker fallback.
 *   - services/swsCoverageFallback.js::buildFallbackHolding — synthetic
 *                                                              SWS via V2.
 *
 * SEBI compliance:
 *   - Methodology version is stamped on every response (`combined-v1-2026-04`).
 *   - Surveillance flags applied AFTER combined-score sort (caller's job).
 *   - Source attribution + last-refresh timestamp in getMethodology().
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSWSDeep } from "./swsHoldingEngine.js";
import { scoreStock } from "./swsScoring.js";
import { buildFallbackHolding } from "./swsCoverageFallback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWS_UNIVERSE_PATH = path.resolve(__dirname, "..", "data", "sws", "sws-scored-universe.json");
const SWS_LAST_REFRESH_PATH = path.resolve(__dirname, "..", "data", "sws", "last-refresh.json");

export const METHODOLOGY_VERSION = "combined-v1-2026-04";

// ─────────────────────── Weighting matrix ───────────────────────
// scannerType → { tech, fund, sws }. Sum to 1.0.
//
// Justification per row is in the plan file's §1 weighting matrix.
// Buy-Now stays tech-led to preserve the Phase-4 attribution edge.
// Mid-Term gives SWS equal billing because Snowflake.future + analyst
// PT shifts time mid-term swings.
// Fundamental scanner is fund-led by definition with SWS as the
// independent valuation cross-check.
// Small-Cap stays tech-led because momentum dominates and SWS coverage
// is sparser at the bottom of the universe.
export const WEIGHTS = Object.freeze({
  buynow:    { tech: 0.45, fund: 0.25, sws: 0.30 },
  midterm:   { tech: 0.35, fund: 0.30, sws: 0.35 },
  sell:      { tech: 0.55, fund: 0.20, sws: 0.25 },
  fund:      { tech: 0.20, fund: 0.45, sws: 0.35 },
  smallcap:  { tech: 0.50, fund: 0.20, sws: 0.30 },
  uniform:   { tech: 1 / 3, fund: 1 / 3, sws: 1 / 3 },
});

// Divergence threshold: max - min over the three component scores.
// Calibrated to v3 distribution — p95-p25 ≈ 38, so 22 is ~58th percentile
// of natural spread. Meaningful without firing on noise.
export const DIVERGENCE_THRESHOLD = 22;

const SOURCES = Object.freeze([
  "NSE OHLC",
  "fundamentalsV2 model",
  "Simply Wall St",
]);

// ─────────────────────── Bulk universe cache ───────────────────────
// Mirrors the _loadV3Universe pattern in swsHoldingEngine.js: read once,
// cache against file mtime, invalidate transparently when the daily SWS
// refresh writes a new universe file.
let _universeCache = null;
let _refreshCache = null;

function _loadUniverseIndex() {
  let stat;
  try {
    stat = fs.statSync(SWS_UNIVERSE_PATH);
  } catch {
    return null;
  }
  if (_universeCache && _universeCache.mtimeMs === stat.mtimeMs) {
    return _universeCache.byTicker;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SWS_UNIVERSE_PATH, "utf-8"));
    const stocks = Array.isArray(raw) ? raw : raw.stocks || [];
    const byTicker = new Map();
    for (const s of stocks) {
      if (!s || !s.ticker) continue;
      byTicker.set(String(s.ticker).toUpperCase(), s);
    }
    _universeCache = { mtimeMs: stat.mtimeMs, byTicker, generatedAt: raw.generated_at || null };
    return byTicker;
  } catch (err) {
    console.warn(`[combinedScore] universe load failed: ${err.message}`);
    return null;
  }
}

function _loadLastRefresh() {
  let stat;
  try {
    stat = fs.statSync(SWS_LAST_REFRESH_PATH);
  } catch {
    return null;
  }
  if (_refreshCache && _refreshCache.mtimeMs === stat.mtimeMs) {
    return _refreshCache.data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(SWS_LAST_REFRESH_PATH, "utf-8"));
    _refreshCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

// Strip Yahoo-style suffix; portfolioParser surfaces tickers as RELIANCE.NS,
// SWS files key on bare RELIANCE. Mirrors _swsKey() in swsHoldingEngine.js.
function _key(ticker) {
  if (!ticker) return null;
  return String(ticker).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "").toUpperCase();
}

// ─────────────────────── Lookup helpers ───────────────────────

/**
 * Lookup SWS score for a single ticker. Three-tier fallback:
 *   1. Bulk universe index (fast, mtime-cached)
 *   2. Per-ticker deep file (loadSWSDeep + scoreStock)
 *   3. fundamentalsV2-derived fallback (buildFallbackHolding)
 *   4. null — caller pro-rata reweights Tech+Fund.
 *
 * Returns { v3Score, snowflakeTotal, surveillance, v3Verdict, source, mtime }
 * where source is "primary" | "fallback" | "missing".
 */
export function lookupSwsScore(symbol) {
  const k = _key(symbol);
  if (!k) return _missingResult();

  // Tier 1 — bulk index hit.
  const idx = _loadUniverseIndex();
  if (idx) {
    const hit = idx.get(k);
    if (hit && (hit.v3_score_100 != null || hit.v3_score != null)) {
      const v3 = hit.v3_score_100 ?? hit.v3_score;
      return {
        v3Score: typeof v3 === "number" ? v3 : null,
        snowflakeTotal: hit.snowflake_total ?? null,
        surveillance: hit.v2_breakdown?.surveillance ?? null,
        v3Verdict: hit.v3_verdict ?? null,
        compositeScore: hit.score ?? null,
        v1Verdict: hit.verdict ?? null,
        source: "primary",
        mtime: _universeCache?.mtimeMs ?? null,
      };
    }
  }

  // Tier 2 — per-ticker deep file.
  const deep = loadSWSDeep(k);
  if (deep) {
    try {
      const scored = scoreStock({ ...deep, ticker: k });
      return {
        v3Score: scored.v3_score_100 ?? null,
        snowflakeTotal: scored.overview?.snowflake_total ?? null,
        surveillance: scored.v2_breakdown?.surveillance ?? null,
        v3Verdict: scored.v3_verdict ?? null,
        compositeScore: scored.composite_score_100 ?? null,
        v1Verdict: scored.verdict ?? null,
        source: "primary",
        mtime: null,
      };
    } catch (err) {
      console.warn(`[combinedScore] deep-score failed for ${k}: ${err.message}`);
    }
  }

  // Tier 3 — V2-fundamentals fallback.
  try {
    const fb = buildFallbackHolding({ ticker: k, name: null, sector: null, holding: {} });
    if (fb && fb.sws) {
      return {
        v3Score: fb.sws.v3_score ?? null,
        snowflakeTotal: fb.sws.snowflake_total ?? null,
        surveillance: null,
        v3Verdict: fb.sws.v3_verdict ?? null,
        compositeScore: fb.sws.score ?? null,
        v1Verdict: fb.sws.verdict ?? null,
        source: "fallback",
        mtime: null,
      };
    }
  } catch (err) {
    console.warn(`[combinedScore] fallback failed for ${k}: ${err.message}`);
  }

  return _missingResult();
}

function _missingResult() {
  return {
    v3Score: null,
    snowflakeTotal: null,
    surveillance: null,
    v3Verdict: null,
    compositeScore: null,
    v1Verdict: null,
    source: "missing",
    mtime: null,
  };
}

/**
 * Bulk lookup — preferred for scanner endpoints. Reads the universe index
 * once, returns a Map<symbolKey, lookupResult>. Symbols missing from the
 * bulk index fall through to per-ticker lookup so partial coverage still
 * works.
 *
 * @param {string[]} symbols — array of ticker strings (suffixes ok).
 * @returns {Map<string, ReturnType<typeof lookupSwsScore>>}
 */
export function lookupSwsScoreBulk(symbols) {
  const out = new Map();
  if (!Array.isArray(symbols) || symbols.length === 0) return out;
  const idx = _loadUniverseIndex();
  for (const sym of symbols) {
    const k = _key(sym);
    if (!k) {
      out.set(sym, _missingResult());
      continue;
    }
    const hit = idx?.get(k);
    if (hit && (hit.v3_score_100 != null || hit.v3_score != null)) {
      const v3 = hit.v3_score_100 ?? hit.v3_score;
      out.set(sym, {
        v3Score: typeof v3 === "number" ? v3 : null,
        snowflakeTotal: hit.snowflake_total ?? null,
        surveillance: hit.v2_breakdown?.surveillance ?? null,
        v3Verdict: hit.v3_verdict ?? null,
        compositeScore: hit.score ?? null,
        v1Verdict: hit.verdict ?? null,
        source: "primary",
        mtime: _universeCache?.mtimeMs ?? null,
      });
      continue;
    }
    // Bulk miss → fall through to single lookup (handles fresh-listed
    // tickers not yet in the daily index).
    out.set(sym, lookupSwsScore(sym));
  }
  return out;
}

// ─────────────────────── Combined score math ───────────────────────

/**
 * Compute the combined score for a stock.
 *
 * @param {object} args
 * @param {number|null} args.techScore       — 0..100, e.g. analysis.score
 * @param {number|null} args.fundScore       — 0..100, fundamentalsV2 composite
 * @param {number|null} args.swsScore        — 0..100, SWS v3_score_100
 * @param {string}      args.scannerType     — buynow | midterm | sell | fund | smallcap | uniform
 * @param {object|null} [args.surveillanceFlag]  — surveillance row, attached for audit only
 * @returns {object} {
 *   combinedScore: number 0..100 | null,
 *   weightsUsed:   {tech, fund, sws}        // pro-rata-reweighted if any dim missing
 *   contributingDims: string[],             // which dims were present
 *   dataConfidence: "high" | "medium" | "low",
 *   divergence: boolean,                    // max-min > DIVERGENCE_THRESHOLD
 *   divergenceSpread: number,               // max-min over present dims
 *   swsFallback: boolean,                   // true if SWS came from V2 fallback
 * }
 */
export function computeCombinedScore({
  techScore = null,
  fundScore = null,
  swsScore = null,
  scannerType = "uniform",
  surveillanceFlag = null,
  swsFallback = false,
} = {}) {
  const baseWeights = WEIGHTS[scannerType] || WEIGHTS.uniform;

  // Build present-dim list with raw weights.
  const dims = [];
  if (Number.isFinite(techScore)) dims.push({ key: "tech", score: techScore, weight: baseWeights.tech });
  if (Number.isFinite(fundScore)) dims.push({ key: "fund", score: fundScore, weight: baseWeights.fund });
  if (Number.isFinite(swsScore))  dims.push({ key: "sws",  score: swsScore,  weight: baseWeights.sws  });

  if (dims.length === 0) {
    return {
      combinedScore: null,
      weightsUsed: baseWeights,
      contributingDims: [],
      dataConfidence: "low",
      divergence: false,
      divergenceSpread: 0,
      swsFallback,
      surveillanceFlag,
      methodologyVersion: METHODOLOGY_VERSION,
    };
  }

  // Pro-rata reweight when any dim missing. Σw must always = 1.0 for a
  // 0..100 result to make sense as a percentage.
  const sumW = dims.reduce((a, d) => a + d.weight, 0);
  const weighted = dims.reduce((a, d) => a + d.score * (d.weight / sumW), 0);
  const combinedScore = Math.max(0, Math.min(100, Math.round(weighted * 10) / 10));

  // Effective per-dim weights actually applied (after reweighting).
  const weightsUsed = { tech: 0, fund: 0, sws: 0 };
  for (const d of dims) weightsUsed[d.key] = +(d.weight / sumW).toFixed(3);

  // Confidence flag.
  const dataConfidence = dims.length === 3 ? "high" : dims.length === 2 ? "medium" : "low";

  // Divergence: the spread among present components. Two-dim spread is
  // already meaningful (Tech vs SWS dispersion) so we compute it whenever
  // dims.length >= 2.
  let divergenceSpread = 0;
  if (dims.length >= 2) {
    const scores = dims.map((d) => d.score);
    divergenceSpread = Math.max(...scores) - Math.min(...scores);
  }
  const divergence = divergenceSpread > DIVERGENCE_THRESHOLD;

  return {
    combinedScore,
    weightsUsed,
    contributingDims: dims.map((d) => d.key),
    dataConfidence,
    divergence,
    divergenceSpread: +divergenceSpread.toFixed(1),
    swsFallback,
    surveillanceFlag,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

// ─────────────────────── Methodology disclosure ───────────────────────

/**
 * Methodology blob shipped with every scanner response. Drives the UI
 * footer + the audit log. Required by SEBI IA Reg 2013 Reg 15(2).
 */
export function getMethodology(scannerType = "uniform") {
  const weights = WEIGHTS[scannerType] || WEIGHTS.uniform;
  const refresh = _loadLastRefresh();
  return {
    version: METHODOLOGY_VERSION,
    scannerType,
    weights,
    weightsPercent: {
      tech: Math.round(weights.tech * 100),
      fund: Math.round(weights.fund * 100),
      sws: Math.round(weights.sws * 100),
    },
    fallbackPolicy: "pro-rata reweight on missing dim; V2-fundamentals synthetic SWS as last resort",
    sources: SOURCES,
    lastSwsRefresh: refresh?.finished_at ?? null,
    swsScoredCount: refresh?.scored_count ?? null,
    divergenceThreshold: DIVERGENCE_THRESHOLD,
  };
}

// ─────────────────────── Shadow-diff writer ───────────────────────

const SHADOW_DIFF_PATH = path.resolve(__dirname, "..", "data", "sws", "combined-shadow-diff.json");
// Cap the shadow-diff file at 30 days of history. The file is read by
// scripts/combined-shadow-summary.mjs to drive the Phase-1 → Phase-2 gate
// decision; older entries aren't needed once the soak window passes.
const SHADOW_DIFF_MAX_AGE_DAYS = 30;
// Throttle: at most one capture per (scannerType, symbol) pair per hour.
// Without this the buynow scanner would write the same picks every cache miss.
const SHADOW_DIFF_THROTTLE_MS = 60 * 60 * 1000;
const _lastCaptureKey = new Map();

function _legacyVerdictFromScore(score) {
  if (score == null) return null;
  if (score >= 70) return "STRONG_BUY";
  if (score >= 55) return "BUY";
  if (score >= 40) return "HOLD";
  if (score >= 25) return "WEAK";
  return "AVOID";
}

function _combinedVerdictFromScore(score) {
  // Same band edges as legacy so verdict-flip rate measures real
  // disagreement rather than a band-mismatch artefact.
  return _legacyVerdictFromScore(score);
}

/**
 * Append a row to the combined-shadow-diff.json log. Best-effort, never
 * throws — shadow-mode capture should never break a scanner request.
 *
 * Throttled per (scannerType, symbol) pair to one row per hour to keep
 * the file size manageable across the 14-day soak window.
 */
export function captureShadowDiff({
  scannerType,
  symbol,
  legacyScore,
  combinedScore,
  swsScore,
  swsSource,
  combinedDivergence,
  combinedDataConfidence,
  weightsUsed,
}) {
  if (combinedScore == null || legacyScore == null) return;
  const key = `${scannerType}:${symbol}`;
  const now = Date.now();
  const last = _lastCaptureKey.get(key);
  if (last && now - last < SHADOW_DIFF_THROTTLE_MS) return;
  _lastCaptureKey.set(key, now);

  const entry = {
    captured_at: new Date(now).toISOString(),
    scannerType,
    symbol,
    legacyScore: +Number(legacyScore).toFixed(1),
    combinedScore: +Number(combinedScore).toFixed(1),
    legacyVerdict: _legacyVerdictFromScore(legacyScore),
    combinedVerdict: _combinedVerdictFromScore(combinedScore),
    swsScore: swsScore != null ? +Number(swsScore).toFixed(1) : null,
    swsSource: swsSource || null,
    combinedDivergence: !!combinedDivergence,
    combinedDataConfidence: combinedDataConfidence || null,
    weightsUsed: weightsUsed || null,
    methodologyVersion: METHODOLOGY_VERSION,
  };

  // Read-modify-write. Cheap (file is ~1MB max, only appended); under
  // 14-day soak it stays well under that. Best-effort: catch and warn.
  try {
    let store = { schema: "combined-shadow-diff-v1", entries: [] };
    if (fs.existsSync(SHADOW_DIFF_PATH)) {
      try {
        const raw = fs.readFileSync(SHADOW_DIFF_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries)) store = parsed;
      } catch {
        // Corrupt file — start fresh rather than fail the scan.
      }
    }
    store.entries.push(entry);

    // Trim entries older than the cap.
    const cutoff = now - SHADOW_DIFF_MAX_AGE_DAYS * 24 * 3600 * 1000;
    store.entries = store.entries.filter((e) => {
      const t = new Date(e.captured_at || 0).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });

    fs.writeFileSync(SHADOW_DIFF_PATH, JSON.stringify(store), "utf-8");
  } catch (err) {
    console.warn(`[combinedScore] shadow-diff write failed: ${err.message}`);
  }
}

/**
 * Bulk capture — one call per scanner request, scattering throttled
 * entries across the picks. Wraps captureShadowDiff().
 */
export function captureShadowDiffBulk(picks, scannerType) {
  if (!Array.isArray(picks)) return;
  for (const p of picks) {
    if (!p || p.combinedScore == null) continue;
    const legacyScore =
      scannerType === "fund" || scannerType === "smallcap"
        ? (p.adjustedScore ?? p.adjustedMidtermScore ?? p.score)
        : (p.legacyAdjustedScore ?? p.adjustedScore ?? p.score);
    const symbol = p.symbol || p.snapshot?.symbol;
    if (!symbol) continue;
    captureShadowDiff({
      scannerType,
      symbol,
      legacyScore,
      combinedScore: p.combinedScore,
      swsScore: p.swsScore,
      swsSource: p.swsSource,
      combinedDivergence: p.combinedDivergence,
      combinedDataConfidence: p.combinedDataConfidence,
      weightsUsed: p.combinedWeights,
    });
  }
}

// ─────────────────────── Compact audit blob ───────────────────────

/**
 * Build the per-stock combined-score audit tuple. Embedded in
 * services/swsAuditTrail.js output under `combined_score_audit` so SEBI
 * RA Reg 2014 Reg 16(1) record-keeping covers the new score.
 */
export function buildCombinedAudit({ symbol, scannerType, techScore, fundScore, swsScore, result }) {
  return {
    symbol: symbol ?? null,
    scanner_type: scannerType ?? null,
    methodology_version: METHODOLOGY_VERSION,
    components: {
      tech: techScore ?? null,
      fund: fundScore ?? null,
      sws: swsScore ?? null,
    },
    weights_used: result?.weightsUsed ?? null,
    combined_score: result?.combinedScore ?? null,
    contributing_dims: result?.contributingDims ?? [],
    data_confidence: result?.dataConfidence ?? null,
    divergence: !!result?.divergence,
    divergence_spread: result?.divergenceSpread ?? 0,
    sws_fallback: !!result?.swsFallback,
    timestamp: new Date().toISOString(),
  };
}
