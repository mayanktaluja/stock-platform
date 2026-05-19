/**
 * Sector Outlook — Synthesizer (cross-check engine).
 *
 * Combines the bottom-up SWS news signal (sectorNewsAggregator output)
 * with the top-down macro regime signal (data/macroRegime.json) into a
 * per-sector × per-horizon outlook label + confidence + evidence.
 *
 * Two horizons in v1:
 *   - "3_12m"  — short to medium term (next 3-12 months)
 *   - "12_24m" — medium to long term (1-2 years)
 *
 * The 730d / 24-36m horizon is deliberately deferred to v2 per the
 * adversarial review (macro regime history has 12 rows; honest analog
 * signal at multi-year horizons is statistically untenable).
 *
 * Horizon blends (signed_index) — per the plan:
 *   3-12m : 30d × 0.5 + 90d × 0.3 + 365d × 0.2
 *   12-24m: 30d × 0.1 + 90d × 0.3 + 365d × 0.6
 *
 * Cross-check rules:
 *   STRONG    — same sign in bottom-up + top-down AND both magnitudes ≥ 2
 *   PARTIAL   — same sign, at least one magnitude ≥ 1
 *   NEUTRAL   — at least one side is 0
 *   DIVERGENT — signs disagree
 *
 * Confidence rules:
 *   HIGH — STRONG cross-check AND breadth_pct ≥ 0.4 AND n_news (90d) ≥ 8
 *   LOW  — DIVERGENT OR breadth_pct < 0.15 OR n_news (90d) < 5
 *   MED  — everything else
 */

import { THEME_LABELS } from "./themeTaxonomy.js";

const HORIZON_BLENDS = Object.freeze({
  "3_12m":  { "30d": 0.5, "90d": 0.3, "365d": 0.2 },
  "12_24m": { "30d": 0.1, "90d": 0.3, "365d": 0.6 },
});

const HORIZONS = Object.keys(HORIZON_BLENDS);

// ── outlook label thresholds (on the cross-check composite) ──
const STRONG_TAILWIND_FLOOR = 0.5;
const TAILWIND_FLOOR        = 0.15;
const HEADWIND_CEIL         = -0.15;
const STRONG_HEADWIND_CEIL  = -0.5;

// ── confidence thresholds ──
const HIGH_BREADTH_FLOOR = 0.4;
const HIGH_MIN_EVIDENCE  = 8;
const LOW_BREADTH_CEIL   = 0.15;
const LOW_MIN_EVIDENCE   = 5;

/* ──────────────────────── helpers ────────────────────────────── */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function blendSignedIndex(windows, weights) {
  let totalW = 0;
  let totalV = 0;
  for (const [w, weight] of Object.entries(weights)) {
    const idx = windows[w]?.signed_index;
    if (typeof idx === "number" && Number.isFinite(idx)) {
      totalV += idx * weight;
      totalW += weight;
    }
  }
  if (totalW === 0) return 0;
  return clamp(totalV / totalW, -1, 1);
}

function blendThemeDistribution(windows, weights) {
  const out = Object.fromEntries(THEME_LABELS.map((t) => [t, 0]));
  let totalW = 0;
  for (const [w, weight] of Object.entries(weights)) {
    const dist = windows[w]?.theme_distribution;
    if (!dist) continue;
    for (const t of THEME_LABELS) out[t] += (dist[t] || 0) * weight;
    totalW += weight;
  }
  if (totalW > 0) for (const t of THEME_LABELS) out[t] /= totalW;
  return out;
}

function topThemes(dist, k = 3) {
  return Object.entries(dist)
    .filter(([t]) => t !== "NEUTRAL")
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([theme, pct]) => ({ theme, pct }));
}

function topDownForSector(macroRegime, sector) {
  if (!macroRegime || !Array.isArray(macroRegime.sectorImpacts)) {
    return { score: 0, reason: null, regime: macroRegime?.regime || null };
  }
  const entry = macroRegime.sectorImpacts.find((s) => s.sector === sector);
  if (!entry) return { score: 0, reason: null, regime: macroRegime.regime };
  // Normalize impact (-3..+3) to score in [-1, +1] for math symmetry.
  const score = clamp(Number(entry.impact || 0) / 3, -1, 1);
  return { score, reason: entry.reason || null, regime: macroRegime.regime };
}

function classifyCrossCheck(bottomUp, topDown) {
  const buSign = Math.sign(bottomUp);
  const tdSign = Math.sign(topDown);
  if (buSign === 0 || tdSign === 0) return "NEUTRAL";
  if (buSign !== tdSign) return "DIVERGENT";
  // Same sign — magnitude classifies STRONG vs PARTIAL.
  // Note: bottomUp is in [-1, +1]; topDown is in [-1, +1] (normalized
  // from -3..+3). Comparing absolute magnitudes >= 2/3 (= STRONG_TAILWIND_FLOOR
  // on the topDown side which originally maps to impact >= 2).
  const buMag = Math.abs(bottomUp);
  const tdMag = Math.abs(topDown);
  if (buMag >= 0.4 && tdMag >= 0.5) return "STRONG";
  return "PARTIAL";
}

function classifyOutlookLabel(composite) {
  if (composite >= STRONG_TAILWIND_FLOOR) return "STRONG_TAILWIND";
  if (composite >= TAILWIND_FLOOR) return "TAILWIND";
  if (composite <= STRONG_HEADWIND_CEIL) return "STRONG_HEADWIND";
  if (composite <= HEADWIND_CEIL) return "HEADWIND";
  return "NEUTRAL";
}

function classifyConfidence({ crossCheck, breadthPct, nEvidence }) {
  if (crossCheck === "DIVERGENT") return "LOW";
  if (breadthPct < LOW_BREADTH_CEIL) return "LOW";
  if (nEvidence < LOW_MIN_EVIDENCE) return "LOW";
  if (
    crossCheck === "STRONG" &&
    breadthPct >= HIGH_BREADTH_FLOOR &&
    nEvidence >= HIGH_MIN_EVIDENCE
  ) return "HIGH";
  return "MED";
}

/* ──────────────────────── public API ────────────────────────────── */

/**
 * Synthesize one sector at one horizon.
 *
 * @param {object} sectorAggregate  output of aggregator for ONE sector
 *                                  shape: { sector, n_tickers_total, windows: {30d,90d,365d} }
 * @param {object} macroRegime      content of data/macroRegime.json
 * @param {string} horizon          "3_12m" or "12_24m"
 * @returns {object}
 */
export function synthesizeSectorAtHorizon(sectorAggregate, macroRegime, horizon) {
  const weights = HORIZON_BLENDS[horizon];
  if (!weights) throw new Error(`unknown horizon: ${horizon}`);
  if (!sectorAggregate || !sectorAggregate.windows) {
    return null;
  }
  const w = sectorAggregate.windows;
  const bottomUp = blendSignedIndex(w, weights);
  const themeDist = blendThemeDistribution(w, weights);

  const td = topDownForSector(macroRegime, sectorAggregate.sector);

  const crossCheck = classifyCrossCheck(bottomUp, td.score);
  // Composite is a weighted average of bottom-up + top-down so the label
  // is symmetric. When DIVERGENT, the two cancel toward NEUTRAL — by
  // design (we don't want a strongly-mixed signal to look like a
  // confident TAILWIND).
  const composite = clamp((bottomUp + td.score) / 2, -1, 1);
  const outlook_label = classifyOutlookLabel(composite);

  // Breadth + evidence count from the 90d window (the middle window
  // best reflects what's been happening "lately").
  const w90 = w["90d"] || {};
  const breadthPct = Number(w90.breadth_pct) || 0;
  const nEvidence = Number(w90.n_news) || 0;
  const confidence = classifyConfidence({ crossCheck, breadthPct, nEvidence });

  return {
    horizon,
    bottom_up: {
      score: bottomUp,
      breadth_pct: breadthPct,
      n_tickers: w90.n_tickers || 0,
      n_news: nEvidence,
      catalyst_proximity_count: w90.catalyst_proximity_count || 0,
      top_themes: topThemes(themeDist, 3),
    },
    top_down: {
      score: td.score,
      regime: td.regime,
      reason: td.reason,
    },
    cross_check: crossCheck,
    composite,
    outlook_label,
    confidence,
    evidence_top5: w90.evidence_top5 || [],
  };
}

/**
 * Synthesize an entire aggregator output into a per-sector × per-horizon
 * matrix. The result is the document written to outlook-latest.json.
 *
 * @param {object} aggregatorResult  aggregateAllSectors output
 * @param {object} macroRegime       macroRegime.json content
 * @param {object} [opts]
 * @returns {object}
 */
export function synthesizeAll(aggregatorResult, macroRegime, opts = {}) {
  const sectors = aggregatorResult?.sectors || {};
  const result = {
    schema_version: "sector-outlook-v1",
    generated_at: new Date().toISOString(),
    regime_at_generation: macroRegime
      ? {
          regime: macroRegime.regime || null,
          severity: macroRegime.severity ?? null,
          confidence: macroRegime.confidence ?? null,
          generatedAt: macroRegime.generatedAt || null,
        }
      : null,
    sectors: [],
    audit: {
      taxonomy_version: opts.taxonomyVersion || "sector-theme-v1",
      synthesizer_version: "sector-outlook-synthesizer-v1",
      orphaned_tickers: aggregatorResult?.orphaned_tickers || 0,
      total_entries: aggregatorResult?.total_entries || 0,
      sector_count: Object.keys(sectors).length,
    },
    gate_met: false, // v1 has no walk-forward backtest yet
    caveats: [
      "EXPERIMENTAL — v1 has no formal backtest gate. Signal is indicative based on observed news themes + current macro regime; do not interpret as a prediction or investment advice.",
      "Bottom-up theme aggregation is heuristic-first with LLM refinement only for ambiguous, recent items. Heuristic patterns may miss novel SWS news templates.",
      "Top-down cross-check uses the CURRENT macro regime only; v1 does not smooth across recent regime history.",
      "Conglomerate news is routed by body keywords (e.g., Reliance petrochemical → Oil & Gas); fallback to fractional weighting when no keyword matches.",
    ],
  };

  for (const [sectorName, agg] of Object.entries(sectors)) {
    const horizons = {};
    for (const h of HORIZONS) {
      horizons[h] = synthesizeSectorAtHorizon(agg, macroRegime, h);
    }
    result.sectors.push({
      sector: sectorName,
      n_tickers_total: agg.n_tickers_total,
      horizons,
    });
  }

  // Sort sectors: STRONG_TAILWIND first (for 3-12m horizon), then TAILWIND,
  // NEUTRAL, HEADWIND, STRONG_HEADWIND.
  const rank = {
    STRONG_TAILWIND: 0, TAILWIND: 1, NEUTRAL: 2, HEADWIND: 3, STRONG_HEADWIND: 4,
  };
  result.sectors.sort((a, b) => {
    const ra = rank[a.horizons["3_12m"]?.outlook_label || "NEUTRAL"];
    const rb = rank[b.horizons["3_12m"]?.outlook_label || "NEUTRAL"];
    if (ra !== rb) return ra - rb;
    // tiebreak: composite score desc
    const ca = a.horizons["3_12m"]?.composite || 0;
    const cb = b.horizons["3_12m"]?.composite || 0;
    return cb - ca;
  });

  return result;
}

export const TESTING_CONSTANTS = Object.freeze({
  HORIZON_BLENDS,
  HORIZONS,
  STRONG_TAILWIND_FLOOR,
  TAILWIND_FLOOR,
  HEADWIND_CEIL,
  STRONG_HEADWIND_CEIL,
  HIGH_BREADTH_FLOOR,
  HIGH_MIN_EVIDENCE,
  LOW_BREADTH_CEIL,
  LOW_MIN_EVIDENCE,
});

export default {
  synthesizeSectorAtHorizon,
  synthesizeAll,
  TESTING_CONSTANTS,
};
