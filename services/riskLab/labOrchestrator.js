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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PICKS_PATH = path.join(REPO_ROOT, "data", "sws", "picks-latest.json");
const REGIME_PATH = path.join(REPO_ROOT, "data", "macroRegime.json");
const OUT_DIR = path.join(REPO_ROOT, "data", "risk-lab");
const OUT_PICKS_PATH = path.join(OUT_DIR, "picks-adjusted-latest.json");

const SCHEMA_VERSION = "risk-lab-picks-v1";

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
 * Build the lab output payload from picks + regime. Returns a structure
 * suitable for direct JSON.stringify and projection by the API in PR 8.
 */
export function buildLabPayload(picks, regime, opts = {}) {
  const now = opts.now || new Date();
  const rows = collectUniqueRows(picks);

  const adjustments = rows.map((row) => {
    try {
      return adjustedScoreForRow(row, regime, opts);
    } catch (err) {
      // Defence-in-depth: a malformed row shouldn't break the whole batch
      return {
        ticker: row?.ticker || null,
        original_score: Number(row?.v3_score_100 ?? row?.score ?? 0),
        original_verdict: row?.v3_verdict || null,
        macro_score_delta: 0,
        macro_adjusted_score: Number(row?.v3_score_100 ?? row?.score ?? 0),
        macro_adjusted_verdict: row?.v3_verdict || null,
        macro_veto: { vetoed: false, reason: null, regime: null, severity: null, sectorImpact: 0 },
        error: err.message,
      };
    }
  });

  // Summary metrics for the UI banner and PR 13 telemetry
  const vetoed = adjustments.filter((a) => a.macro_veto?.vetoed).length;
  const flagged = adjustments.filter((a) => a.macro_score_delta !== 0).length;
  const stale = adjustments.filter((a) => a.regime_stale).length;

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
      flagged_count: flagged,
      vetoed_count: vetoed,
      stale_skipped_count: stale,
    },
    stocks: adjustments,
  };
}

/**
 * Top-level runner: read files, compute, write output. Returns the
 * payload that was written so the caller can log a one-liner.
 */
export function runRiskLab(opts = {}) {
  const picksPath = opts.picksPath || PICKS_PATH;
  const regimePath = opts.regimePath || REGIME_PATH;
  const outPath = opts.outPath || OUT_PICKS_PATH;

  const picks = readJsonSafe(picksPath);
  const regime = readJsonSafe(regimePath);

  const payload = buildLabPayload(picks, regime, opts);

  if (!opts.dryRun) {
    writeJsonAtomic(outPath, payload);
  }

  return { payload, outPath, dryRun: !!opts.dryRun };
}
