/**
 * Risk Lab — Macro Lens adjusted scorer.
 *
 * Pure function: given a stock row from picks-latest.json and the live
 * macro regime, returns an "adjusted view" that layers two corrections
 * on top of the production score:
 *
 *   1. Soft delta: macro_score_delta = lab impact * 0.5 (capped at -5..+5,
 *      since the lab is conservative initially — penalty-heavy not bullish).
 *   2. Hard veto: when severity ≥ 4 AND worst impact ≤ -3 AND v3_verdict
 *      is TOP_PICK, set macro_veto = true.
 *
 * The original v3_score_100 and v3_verdict fields are NEVER mutated. The
 * returned object carries both originals and adjusted views side by side,
 * which the UI uses to render the diff.
 *
 * Stale-regime gate: if the regime is older than the configured ceiling
 * (default 12h), the lab treats it as CALM and returns zero adjustment.
 * Better to say "we don't know" than to lock a vetoed verdict against a
 * regime call from yesterday that may no longer hold.
 */

import { mergeLabImpacts } from "./sectorTemplates.js";
import { resolveSectorsForTicker, hasOverride } from "./sectorOverrides.js";

const DEFAULT_STALE_HOURS = 12;
const SEVERE_REGIME_THRESHOLD = 4;
const SEVERE_IMPACT_THRESHOLD = -3;
const DELTA_MULTIPLIER = 0.5;
const DELTA_CAP_LO = -5;
const DELTA_CAP_HI = 5;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute lab macro delta for a single sector against the merged regime.
 * Returns { delta, impact, reason, sector } or { delta: 0, ... } for misses.
 */
function deltaForSector(mergedImpacts, sector, regime) {
  if (!sector || !Array.isArray(mergedImpacts) || mergedImpacts.length === 0) {
    return { delta: 0, impact: 0, reason: null, sector: sector || null };
  }
  const hit = mergedImpacts.find((s) => s.sector === sector);
  if (!hit) {
    return { delta: 0, impact: 0, reason: null, sector };
  }

  const severity = Number(regime?.severity ?? 1) || 1;
  const confidence = Number(regime?.confidence ?? 0.5) || 0.5;
  const impact = Number(hit.impact || 0);

  // Same scaling formula shape as macroRegime.computeMacroDelta (impact *
  // 2.5 * severity/3 * confidence), but DELTA_MULTIPLIER halves the result
  // so the lab caps at ±5 instead of the production ±10. This is the soft
  // discount — meaningful but bounded; the hard veto is the real action.
  const raw = impact * 2.5 * (severity / 3) * confidence * DELTA_MULTIPLIER;
  const delta = clamp(Number(raw.toFixed(2)), DELTA_CAP_LO, DELTA_CAP_HI);

  return {
    delta,
    impact,
    reason: `${sector}: ${hit.reason || "lab template impact"}`,
    sector,
  };
}

/**
 * Pick the worst-case delta when a stock has multiple sectors (diversified
 * names — RIL, ITC, L&T). Returns the deltaForSector record whose delta
 * is most negative; for ties on delta, prefers more-negative impact.
 */
function worstSectorImpact(mergedImpacts, sectors, regime) {
  if (!Array.isArray(sectors)) {
    return deltaForSector(mergedImpacts, sectors, regime);
  }
  let worst = null;
  for (const sector of sectors) {
    const result = deltaForSector(mergedImpacts, sector, regime);
    if (!worst || result.delta < worst.delta) {
      worst = result;
    }
  }
  return worst || { delta: 0, impact: 0, reason: null, sector: null };
}

/**
 * Compute the lab adjustment for a single pick row.
 *
 * @param {object} row — a row from data/sws/picks-latest.json sections
 * @param {object} regime — content of data/macroRegime.json
 * @param {object} opts — { staleHours?: number, now?: Date }
 * @returns {object} adjustment view (see fields below)
 */
export function adjustedScoreForRow(row, regime, opts = {}) {
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS;
  const now = opts.now || new Date();
  const ticker = row?.ticker || null;
  const originalScore = Number(row?.v3_score_100 ?? row?.score ?? 0);
  const originalVerdict = row?.v3_verdict || row?.verdict || null;

  const base = {
    ticker,
    name: row?.name || null,
    original_score: originalScore,
    original_verdict: originalVerdict,
    original_sector: row?.sector || null,
    macro_score_delta: 0,
    macro_adjusted_score: originalScore,
    macro_adjusted_verdict: originalVerdict,
    macro_veto: { vetoed: false, reason: null, regime: null, severity: null, sectorImpact: 0 },
    sector_used: null,
    sector_overridden: false,
    lab_template_used: false,
    regime: regime?.regime || null,
    regime_severity: regime?.severity || null,
    regime_stale: false,
  };

  // Stale-regime gate
  if (!regime || !regime.regime || regime.regime === "CALM") {
    return base;
  }
  if (regime.generatedAt) {
    const ageHours = (now.getTime() - new Date(regime.generatedAt).getTime()) / (1000 * 60 * 60);
    if (ageHours > staleHours) {
      return { ...base, regime_stale: true };
    }
  }
  // Severity gate — don't pollute output with zero-impact deltas during low
  // severity. The Lab UI hides badges where macro_score_delta === 0.
  if (Number(regime.severity ?? 0) < 2) {
    return base;
  }

  // Resolve sector(s) — overrides win
  const resolved = resolveSectorsForTicker(ticker, row?.sector);
  if (!resolved) return base;

  const mergedImpacts = mergeLabImpacts(regime);
  const worst = worstSectorImpact(mergedImpacts, resolved, regime);

  const macroVeto = {
    vetoed:
      Number(regime.severity || 0) >= SEVERE_REGIME_THRESHOLD &&
      worst.impact <= SEVERE_IMPACT_THRESHOLD &&
      originalVerdict === "TOP_PICK",
    reason: worst.reason,
    regime: regime.regime,
    severity: regime.severity,
    sectorImpact: worst.impact,
  };

  const adjustedScore = clamp(Number((originalScore + worst.delta).toFixed(2)), 0, 100);

  // If vetoed, the adjusted verdict shifts to MACRO_HOLD so the UI knows to
  // suppress the TOP_PICK label entirely (per UI plan in D7). If just a
  // soft delta, the original verdict label still stands.
  const adjustedVerdict = macroVeto.vetoed ? "MACRO_HOLD" : originalVerdict;

  return {
    ...base,
    macro_score_delta: worst.delta,
    macro_adjusted_score: adjustedScore,
    macro_adjusted_verdict: adjustedVerdict,
    macro_veto: macroVeto,
    sector_used: worst.sector,
    sector_overridden: hasOverride(ticker),
    lab_template_used: !!mergedImpacts.find(
      (s) => s.sector === worst.sector && !regime.sectorImpacts?.some((rs) => rs.sector === worst.sector),
    ),
  };
}

/**
 * Compute lab adjustments for every row in a section of picks-latest.
 * Returns a fresh array — input is never mutated.
 */
export function adjustedScoresForRows(rows, regime, opts = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => adjustedScoreForRow(row, regime, opts));
}
