// Risk Lab → Earnings Watch projection (PR A1, Phase 2).
//
// Loads the Risk Lab's two data products and shapes them into a per-ticker
// `lab_view` object that the /api/earnings/upcoming endpoint attaches to
// each event. Production verdicts are NOT touched — this is a read-only
// second-opinion surface (SEBI Reg 19 risk disclosure).
//
// Failure-graceful: missing files, disabled kill-switch, parse errors all
// return null and the API serves events unchanged. The Earnings Watch UI
// already renders correctly when lab_view is absent.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const PICKS_PATH = path.join(REPO_ROOT, "data", "risk-lab", "picks-adjusted-latest.json");
export const QUALITY_FLAGS_PATH = path.join(REPO_ROOT, "data", "risk-lab", "quality-flags-latest.json");

export function isLabEnabled(env = process.env) {
  // Mirror server.js isRiskLabEnabled() — default ON, RISK_LAB_ENABLED=false disables.
  const v = env?.RISK_LAB_ENABLED;
  if (v === undefined || v === null || v === "") return true;
  return !/^(false|0|off|no)$/i.test(String(v).trim());
}

function _safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    console.warn(`[earnings-lab-view] failed to read ${p}: ${err.message}`);
    return null;
  }
}

export function loadRiskLabViewMap({
  picksPath = PICKS_PATH,
  qualityPath = QUALITY_FLAGS_PATH,
  env = process.env,
} = {}) {
  if (!isLabEnabled(env)) return null;
  const picks = _safeReadJson(picksPath);
  const quality = _safeReadJson(qualityPath);
  if (!picks && !quality) return null;

  const map = new Map();

  if (picks && Array.isArray(picks.stocks)) {
    for (const s of picks.stocks) {
      if (!s?.ticker) continue;
      map.set(String(s.ticker).toUpperCase(), {
        ticker: s.ticker,
        original_verdict: s.original_verdict || null,
        macro_score_delta: s.macro_score_delta ?? 0,
        macro_adjusted_verdict: s.macro_adjusted_verdict || null,
        macro_veto: s.macro_veto || null,
        regime: s.regime || null,
        regime_severity: s.regime_severity ?? null,
        regime_stale: s.regime_stale === true,
        quality_verdict: s.quality_verdict || null,
        quality_score_delta: s.quality_score_delta ?? 0,
        quality_adjusted_confidence: s.quality_adjusted_confidence ?? null,
        combined_verdict: s.combined_verdict || null,
        quality_veto: s.quality_veto || null,
        quality_flags: Array.isArray(s.quality_flags) ? s.quality_flags : [],
      });
    }
  }

  if (quality && Array.isArray(quality.stocks)) {
    for (const s of quality.stocks) {
      if (!s?.ticker) continue;
      const key = String(s.ticker).toUpperCase();
      const existing = map.get(key) || { ticker: s.ticker, quality_flags: [] };
      // quality-flags-latest.json is authoritative for quality fields and uses
      // `flags` (not `quality_flags`) for the array — merge accordingly.
      map.set(key, {
        ...existing,
        ticker: existing.ticker || s.ticker,
        quality_verdict: s.quality_verdict ?? existing.quality_verdict ?? null,
        quality_score_delta: s.quality_score_delta ?? existing.quality_score_delta ?? 0,
        quality_adjusted_confidence:
          s.quality_adjusted_confidence ?? existing.quality_adjusted_confidence ?? null,
        combined_verdict: s.combined_verdict || existing.combined_verdict || null,
        quality_veto: s.quality_veto || existing.quality_veto || null,
        quality_flags: Array.isArray(s.flags) ? s.flags : existing.quality_flags || [],
      });
    }
  }

  // Stash regime + generated_at on the map for the API response (non-enumerable
  // so they don't pollute a Map.entries() iteration if anyone does that).
  Object.defineProperty(map, "_regime", { value: picks?.regime || null });
  Object.defineProperty(map, "_generated_at", { value: picks?.generated_at || quality?.generated_at || null });

  return map;
}

// Compute the per-event lab_view from a populated Map and an event object.
// The "disagrees" heuristic is intentionally conservative: lab disagrees with
// the production prediction when production says BEAT and the lab either
// finds quality flags, has a macro overlay (delta or veto), or drops
// confidence by ≥10pp. Everything else is "Risk Lab notes" (informational).
export function buildLabViewForEvent(event, labMap) {
  if (!labMap || !event || !event.symbol) return null;
  const view = labMap.get(String(event.symbol).toUpperCase());
  if (!view) return null;

  const prediction = event.prediction || null;
  const predictedVerdict = prediction?.verdict || null;
  const prodConf = typeof prediction?.confidence_pct === "number" ? prediction.confidence_pct : null;
  const labConf = typeof view.quality_adjusted_confidence === "number"
    ? view.quality_adjusted_confidence
    : null;

  const flagCount = (view.quality_flags || []).length;
  const hasMacroOverlay =
    (view.macro_score_delta || 0) !== 0 || view.macro_veto?.vetoed === true;
  const hasQualityOverlay = flagCount > 0 || view.quality_veto?.vetoed === true;
  const confDropMaterial =
    labConf !== null && prodConf !== null && labConf <= prodConf - 10;

  const disagrees =
    predictedVerdict === "BEAT" &&
    (hasQualityOverlay || hasMacroOverlay || confDropMaterial);

  // Most-negative flags first; preserve stable sort for ties.
  const topReasons = (view.quality_flags || [])
    .slice()
    .map((f, i) => ({ ...f, _idx: i }))
    .sort((a, b) => (a.severity ?? 0) - (b.severity ?? 0) || a._idx - b._idx)
    .slice(0, 3)
    .map((f) => ({
      category: f.category || null,
      summary: f.summary || f.evidence || null,
      severity: f.severity ?? 0,
      source: f.source || null,
    }));

  return {
    ...view,
    disagrees_with_prediction: disagrees,
    has_macro_overlay: hasMacroOverlay,
    has_quality_overlay: hasQualityOverlay,
    confidence_delta_pct: labConf !== null && prodConf !== null ? Math.round(labConf - prodConf) : null,
    top_reasons: topReasons,
  };
}

export default { loadRiskLabViewMap, buildLabViewForEvent, isLabEnabled };
