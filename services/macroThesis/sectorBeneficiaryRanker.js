// Sector beneficiary ranker (PR B3).
//
// Given a regime + scenario projection, rank Indian sectors by EXPECTED
// MAGNITUDE of impact and direction (BENEFICIARY vs HIT). The Risk Lab's
// existing services/riskLab/macro/sectorTemplates.js is primarily
// defensive (negative deltas only); this layer adds the symmetric
// upside view used by offensive thesis cards.
//
// Sector → sign per regime is derived from two sources in priority order:
//   1. The analog backtester's empirical distribution (B1.4) — if a
//      sector has n_analogs ≥ MIN_SAFE_N AND median return is materially
//      non-zero (|median| ≥ 1%), use that sign + magnitude.
//   2. The expert-coded template below — used when analog data is thin
//      (n < 3) so the UI can still show a directional opinion with a
//      "no-historical-evidence" warning.

import { MIN_SAFE_N } from "./historicalAnalogFinder.js";

// Expert-coded beneficiary template — fallback only when analog data
// is insufficient. Each regime maps to a {sector → expected_delta}
// where positive = beneficiary, negative = hit. Magnitudes are
// directional (-3 to +3); the UI translates to "STRONG BENEFICIARY",
// "MILD HIT" etc. — never to absolute return forecasts.
export const REGIME_BENEFICIARY_TEMPLATE = Object.freeze({
  WAR_ESCALATION: {
    "Energy": +2,
    "Metals & Mining": +2,
    "Capital Goods": +1,
    "Software": -1,
    "Real Estate": -3,
    "Automobiles": -2,
    "Consumer Staples": +1,
    "Pharmaceuticals": +1,
  },
  OIL_SHOCK: {
    "Energy": +3,
    "Automobiles": -2,
    "Software": -1,
    "Consumer Staples": +1,
    "Real Estate": -1,
  },
  RATE_HIKE: {
    "PSU Banks": +2,
    "Private Banks": +1,
    "Real Estate": -3,
    "Automobiles": -2,
    "Capital Goods": -1,
  },
  RATE_CUT: {
    "Real Estate": +3,
    "Automobiles": +2,
    "Capital Goods": +2,
    "PSU Banks": -1,
  },
  CURRENCY_WEAKNESS: {
    "Software": +2,
    "Pharmaceuticals": +1,
    "Energy": -1,
    "Consumer Staples": -1,
  },
  POLICY_STIMULUS: {
    "Capital Goods": +2,
    "Metals & Mining": +1,
    "PSU Banks": +1,
    "Real Estate": +1,
    "Consumer Staples": -1,
  },
  REGULATORY_SHOCK: {
    "Real Estate": -2,
    "Consumer Staples": -2,
    "Banks": -1,
    "Software": +1,
  },
  GLOBAL_RISK_OFF: {
    "Banks": -2,
    "Real Estate": -3,
    "Metals & Mining": -2,
    "Automobiles": -2,
    "Pharmaceuticals": +1,
    "Consumer Staples": +2,
    "Software": -1,
  },
  CALM: {},
});

const MATERIAL_RETURN_PCT = 1.0; // analog median below this is "noise"

export function rankSectorsFromAnalog({
  regime,
  scenarioBranchKey,
  scenarioProjection,
  horizonDays = 30,
  template = REGIME_BENEFICIARY_TEMPLATE,
}) {
  const projection = scenarioProjection || {};
  const ranked = [];
  // First pass: empirical from analog distributions (preferred).
  for (const [sectorKey, blob] of Object.entries(projection)) {
    const h = blob?.horizons?.[horizonDays];
    if (!h || typeof h.median !== "number" || h.n < MIN_SAFE_N) continue;
    if (Math.abs(h.median) < MATERIAL_RETURN_PCT) continue;
    ranked.push({
      sector_index_key: sectorKey,
      sector_label: blob.label,
      sector_bucket: blob.sector,
      expected_return_pct: h.median,
      p25: h.p25,
      p75: h.p75,
      n_analogs: h.n,
      source: "analog",
      direction: h.median > 0 ? "BENEFICIARY" : "HIT",
    });
  }

  // Second pass: fill from template for sectors not covered by analog
  // (or with sub-MATERIAL_RETURN_PCT analog readings). Marked source:
  // "template" so the UI distinguishes evidence levels.
  const tpl = template[regime] || {};
  for (const [sectorBucket, delta] of Object.entries(tpl)) {
    if (ranked.some((r) => r.sector_bucket === sectorBucket)) continue;
    if (delta === 0) continue;
    ranked.push({
      sector_index_key: null,
      sector_label: sectorBucket,
      sector_bucket: sectorBucket,
      expected_return_pct: null,
      template_delta: delta,
      n_analogs: 0,
      source: "template",
      direction: delta > 0 ? "BENEFICIARY" : "HIT",
    });
  }

  // Sort: analog first, then template; within each, by absolute magnitude.
  ranked.sort((a, b) => {
    if (a.source !== b.source) return a.source === "analog" ? -1 : 1;
    const ra = a.expected_return_pct != null ? Math.abs(a.expected_return_pct) : Math.abs(a.template_delta || 0);
    const rb = b.expected_return_pct != null ? Math.abs(b.expected_return_pct) : Math.abs(b.template_delta || 0);
    return rb - ra;
  });

  return { regime, branch: scenarioBranchKey, horizon_days: horizonDays, ranked };
}

export default { REGIME_BENEFICIARY_TEMPLATE, rankSectorsFromAnalog, MATERIAL_RETURN_PCT };
