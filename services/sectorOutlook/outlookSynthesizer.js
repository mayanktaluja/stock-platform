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
 * Trust model:
 *   HIGH — trust_score >= 75
 *   MED  — trust_score >= 45
 *   LOW  — trust_score < 45
 */

import { normalizeSector } from "../../macroRegime.js";
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

// ── trust thresholds + weights ──
const TRUST_HIGH_FLOOR = 75;
const TRUST_MED_FLOOR = 45;
const TRUST_WEIGHTS = Object.freeze({
  evidence: 25,
  breadth: 20,
  stability: 15,
  agreement: 15,
  classifier_quality: 10,
  price_confirmation: 10,
  freshness: 5,
});
const EVIDENCE_CAP_90D = 50;

/* ──────────────────────── helpers ────────────────────────────── */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v) {
  return Math.round(v * 100) / 100;
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
    return { score: 0, reason: null, regime: macroRegime?.regime || null, status: "UNCORROBORATED" };
  }
  const canonicalSector = normalizeSector(sector) || sector;
  const entry = macroRegime.sectorImpacts.find((s) => (
    s.sector === sector ||
    s.sector === canonicalSector ||
    (normalizeSector(s.sector) || s.sector) === canonicalSector
  ));
  if (!entry) return { score: 0, reason: null, regime: macroRegime.regime, status: "UNCORROBORATED" };
  // Normalize impact (-3..+3) to score in [-1, +1] for math symmetry.
  const score = clamp(Number(entry.impact || 0) / 3, -1, 1);
  return { score, reason: entry.reason || null, regime: macroRegime.regime, status: score === 0 ? "UNCORROBORATED" : "AVAILABLE" };
}

function emptyWindowSummary() {
  return {
    theme_distribution: Object.fromEntries(THEME_LABELS.map((t) => [t, 0])),
    signed_index: 0,
    breadth_pct: 0,
    catalyst_proximity_count: 0,
    evidence_top5: [],
    n_tickers: 0,
    n_news: 0,
  };
}

function emptySectorAggregate(sector) {
  return {
    sector,
    n_tickers_total: 0,
    windows: {
      "30d": emptyWindowSummary(),
      "90d": emptyWindowSummary(),
      "365d": emptyWindowSummary(),
    },
  };
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

function classifyOutlookLabel(composite, { crossCheck = null, confidence = null } = {}) {
  const strongAgreement = crossCheck === "STRONG" && confidence === "HIGH";
  if (composite >= STRONG_TAILWIND_FLOOR) return strongAgreement ? "STRONG_TAILWIND" : "TAILWIND";
  if (composite >= TAILWIND_FLOOR) return "TAILWIND";
  if (composite <= STRONG_HEADWIND_CEIL) return strongAgreement ? "STRONG_HEADWIND" : "HEADWIND";
  if (composite <= HEADWIND_CEIL) return "HEADWIND";
  return "NEUTRAL";
}

function classifyConfidenceFromTrust(trustScore) {
  if (trustScore >= TRUST_HIGH_FLOOR) return "HIGH";
  if (trustScore >= TRUST_MED_FLOOR) return "MED";
  return "LOW";
}

function signalStability(windows, blended) {
  const values = ["30d", "90d", "365d"]
    .map((k) => windows[k]?.signed_index)
    .filter((v) => Number.isFinite(Number(v)))
    .map(Number);
  if (values.length < 2) return 0.5;
  const avgDelta = values.reduce((sum, v) => sum + Math.abs(v - blended), 0) / values.length;
  const signs = values.filter((v) => Math.abs(v) >= 0.05).map((v) => Math.sign(v));
  const signPenalty = signs.length > 1 && new Set(signs).size > 1 ? 0.75 : 1;
  return clamp((1 - avgDelta / 1.2) * signPenalty, 0, 1);
}

function agreementFactor(bottomUp, topDownScore, externalScore = null) {
  const candidates = [];
  for (const score of [topDownScore, externalScore]) {
    if (!Number.isFinite(Number(score)) || Math.abs(Number(score)) < 0.05) continue;
    candidates.push(Number(score));
  }
  const bottomSign = Math.abs(bottomUp) >= 0.05 ? Math.sign(bottomUp) : 0;
  if (bottomSign === 0 || candidates.length === 0) {
    return { score: 0.55, status: "UNCORROBORATED", detail: "No decisive macro/external sector signal." };
  }
  const aligned = candidates.filter((score) => Math.sign(score) === bottomSign);
  if (aligned.length === 0) {
    return { score: 0.05, status: "DIVERGENT", detail: "Macro/external signal points opposite to bottom-up news." };
  }
  const avgMagnitude = aligned.reduce((sum, score) => sum + Math.abs(score), 0) / aligned.length;
  return {
    score: clamp(0.65 + avgMagnitude * 0.35, 0, 1),
    status: aligned.length === candidates.length ? "CONFIRMING" : "MIXED",
    detail: aligned.length === candidates.length
      ? "Macro/external signal confirms the bottom-up direction."
      : "Some macro/external evidence confirms, but not all inputs agree.",
  };
}

function priceFactor(bottomUp, priceContext) {
  if (!priceContext || !Number.isFinite(Number(priceContext.score)) || Math.abs(Number(priceContext.score)) < 0.05) {
    return { score: 0.55, status: "UNCORROBORATED", detail: "No usable sector-index confirmation yet.", price_context: priceContext || null };
  }
  const bottomSign = Math.abs(bottomUp) >= 0.05 ? Math.sign(bottomUp) : 0;
  const priceScore = Number(priceContext.score);
  if (bottomSign === 0) {
    return { score: 0.55, status: "UNCORROBORATED", detail: "Bottom-up signal is too small for price confirmation.", price_context: priceContext };
  }
  if (Math.sign(priceScore) !== bottomSign) {
    return { score: 0.2, status: "DIVERGENT", detail: "Sector-index relative strength disagrees with the bottom-up signal.", price_context: priceContext };
  }
  return {
    score: clamp(0.65 + Math.abs(priceScore) * 0.35, 0, 1),
    status: "CONFIRMING",
    detail: "Sector-index relative strength confirms the bottom-up signal.",
    price_context: priceContext,
  };
}

function freshnessFactor(macroRegime, nowMs) {
  const generated = macroRegime?.generatedAt ? new Date(macroRegime.generatedAt).getTime() : null;
  if (!Number.isFinite(generated)) {
    return { score: 0.5, status: "UNCORROBORATED", detail: "Macro-regime timestamp unavailable." };
  }
  const ageHours = (nowMs - generated) / (3600 * 1000);
  if (ageHours <= 12) return { score: 1, status: "FRESH", detail: `Macro regime is ${ageHours.toFixed(1)}h old.` };
  if (ageHours <= 36) return { score: 0.8, status: "FRESH", detail: `Macro regime is ${ageHours.toFixed(1)}h old.` };
  if (ageHours <= 72) return { score: 0.5, status: "STALE", detail: `Macro regime is ${ageHours.toFixed(1)}h old.` };
  return { score: 0.2, status: "STALE", detail: `Macro regime is ${ageHours.toFixed(1)}h old.` };
}

function trustFactor(key, label, rawScore, detail, extra = {}) {
  const weight = TRUST_WEIGHTS[key] || 0;
  const score = clamp(Number(rawScore) || 0, 0, 1);
  return {
    key,
    label,
    score: round2(score),
    weight,
    contribution: round2(score * weight),
    detail,
    ...extra,
  };
}

function buildTrust({ sectorAggregate, windows, bottomUp, topDown, nEvidence, breadthPct, macroRegime, opts }) {
  const w90 = windows["90d"] || {};
  const externalSector = opts.externalContext?.sector_signals?.[sectorAggregate.sector] || null;
  const priceContext = opts.externalContext?.sector_price?.sectors?.[sectorAggregate.sector] || null;
  const agreement = agreementFactor(bottomUp, topDown.score, externalSector?.score);
  const price = priceFactor(bottomUp, priceContext);
  const fresh = freshnessFactor(macroRegime, opts.nowMs || Date.now());
  const factors = [
    trustFactor("evidence", "Evidence volume", Math.min(nEvidence / EVIDENCE_CAP_90D, 1), `${nEvidence} classified 90-day news items; cap is ${EVIDENCE_CAP_90D}.`),
    trustFactor("breadth", "Sector breadth", breadthPct, `${Math.round(breadthPct * 100)}% of sector tickers carry a 90-day signal.`),
    trustFactor("stability", "Signal stability", signalStability(windows, bottomUp), "Checks whether 30d, 90d, and 365d signals point in a stable direction."),
    trustFactor("agreement", "Macro / external agreement", agreement.score, agreement.detail, { status: agreement.status }),
    trustFactor("classifier_quality", "Classifier quality", Number(w90.avg_confidence) || 0.65, "Average retained classifier confidence in the 90-day evidence window."),
    trustFactor("price_confirmation", "Sector-index confirmation", price.score, price.detail, { status: price.status, price_context: price.price_context }),
    trustFactor("freshness", "Freshness", fresh.score, fresh.detail, { status: fresh.status }),
  ];
  const trustScore = round2(factors.reduce((sum, factor) => sum + factor.contribution, 0));
  return { trustScore, factors };
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
export function synthesizeSectorAtHorizon(sectorAggregate, macroRegime, horizon, opts = {}) {
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

  // Breadth + evidence count from the 90d window (the middle window
  // best reflects what's been happening "lately").
  const w90 = w["90d"] || {};
  const breadthPct = Number(w90.breadth_pct) || 0;
  const nEvidence = Number(w90.n_news) || 0;
  const trust = buildTrust({
    sectorAggregate,
    windows: w,
    bottomUp,
    topDown: td,
    nEvidence,
    breadthPct,
    macroRegime,
    opts,
  });
  const confidence = classifyConfidenceFromTrust(trust.trustScore);
  const outlook_label = classifyOutlookLabel(composite, { crossCheck, confidence });

  return {
    horizon,
    trust_score: trust.trustScore,
    trust_factors: trust.factors,
    bottom_up: {
      score: bottomUp,
      breadth_pct: breadthPct,
      n_tickers: w90.n_tickers || 0,
      n_news: nEvidence,
      avg_confidence: w90.avg_confidence || 0,
      catalyst_proximity_count: w90.catalyst_proximity_count || 0,
      top_themes: topThemes(themeDist, 3),
    },
    top_down: {
      score: td.score,
      regime: td.regime,
      reason: td.reason,
      status: td.status,
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
  const sectorUniverse = Array.isArray(opts.sectorUniverse)
    ? opts.sectorUniverse.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const sectorNames = [...new Set([...sectorUniverse, ...Object.keys(sectors)])];
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
      synthesizer_version: "sector-outlook-synthesizer-v2-trust",
      trust_model_version: "sector-outlook-trust-v1",
      orphaned_tickers: aggregatorResult?.orphaned_tickers || 0,
      total_entries: aggregatorResult?.total_entries || 0,
      observed_sector_count: Object.keys(sectors).length,
      sector_universe_count: sectorUniverse.length,
      sector_count: sectorNames.length,
      external_context_schema: opts.externalContext?.schema_version || null,
      macro_headlines: opts.externalContext?.macro_headlines || null,
      sector_price_available: Object.keys(opts.externalContext?.sector_price?.sectors || {}).length,
    },
    gate_met: false, // v1 has no walk-forward backtest yet
    caveats: [
      "EXPERIMENTAL — v1 has no formal backtest gate. Signal is indicative based on observed news themes + current macro regime; do not interpret as a prediction or investment advice.",
      "Bottom-up theme aggregation is heuristic-first with LLM refinement only for ambiguous, recent items. Heuristic patterns may miss novel SWS news templates.",
      "Trust score ranks sectors by evidence quality, breadth, stability, macro/external agreement, classifier confidence, available sector-index confirmation, and freshness.",
      "Missing macro or sector-index context is treated as uncorroborated, not as a hard failure. True opposite-sign evidence reduces trust.",
      "Sector rows use the same raw SWS sector labels shown in India Market. Macro cross-checks normalize those labels to broader macro buckets, so closely related display sectors can share the same top-down macro read.",
      "Top-down cross-check uses the CURRENT macro regime only; v1 does not smooth across recent regime history.",
    ],
  };

  for (const sectorName of sectorNames) {
    const agg = sectors[sectorName] || emptySectorAggregate(sectorName);
    const horizons = {};
    for (const h of HORIZONS) {
      horizons[h] = synthesizeSectorAtHorizon(agg, macroRegime, h, opts);
    }
    result.sectors.push({
      sector: sectorName,
      n_tickers_total: agg.n_tickers_total,
      horizons,
    });
  }

  const confidenceRank = { HIGH: 3, MED: 2, LOW: 1 };
  const directionRank = {
    STRONG_TAILWIND: 5,
    STRONG_HEADWIND: 4,
    TAILWIND: 3,
    HEADWIND: 2,
    NEUTRAL: 1,
  };
  result.sectors.sort((a, b) => {
    const ah = a.horizons["3_12m"] || {};
    const bh = b.horizons["3_12m"] || {};
    const cr = (confidenceRank[bh.confidence] || 0) - (confidenceRank[ah.confidence] || 0);
    if (cr !== 0) return cr;
    const tr = (bh.trust_score || 0) - (ah.trust_score || 0);
    if (tr !== 0) return tr;
    const ar = Math.abs(bh.composite || 0) - Math.abs(ah.composite || 0);
    if (ar !== 0) return ar;
    return (directionRank[bh.outlook_label] || 0) - (directionRank[ah.outlook_label] || 0);
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
  TRUST_HIGH_FLOOR,
  TRUST_MED_FLOOR,
  TRUST_WEIGHTS,
  EVIDENCE_CAP_90D,
});

export default {
  synthesizeSectorAtHorizon,
  synthesizeAll,
  TESTING_CONSTANTS,
};
