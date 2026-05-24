// Sector-fit scoring for Tier B "Perfect Fit" top-ups.
//
// Turns the user's current sectorOverlay + picks-latest + (optional)
// macroRegime into per-sector and per-stock fit decisions.
//
// Fit score is added to v4_score so a candidate filling a missing,
// tailwind sector outranks a higher-v3 candidate in an already-saturated
// sector. This is the difference between "best stocks in the universe"
// and "best add for *this* portfolio".
//
// Three tailwind layers (each +6, summed into a 0..18 tailwindBonus):
//   1. Structural (India 2026 multi-year theses — capex / PLI / energy
//      transition / generics / China+1)
//   2. FV-upside-driven (sectors where SWS's top picks have ≥30% avg
//      upside — the data layer)
//   3. Regime-driven (macroRegime.sectorImpacts ≥ +2)
//
// Pure functions only. No I/O.

import { normalizeSector, computeMacroDelta } from "../macroRegime.js";

export const PERFECT_FIT_FLOOR = { v4: 47, snowflake_total: 16, upside_pct: 8 };
export const OVERWEIGHT_PCT_THRESHOLD = 20;
export const UNDERWEIGHT_PCT_THRESHOLD = 6;
export const TAILWIND_FV_PICK_COUNT_MIN = 3;
export const TAILWIND_FV_AVG_UPSIDE_MIN = 30;
export const TAILWIND_FV_AVG_V3_MIN = 55;

// Layer 1: structural multi-year theses (canonical sector → reason).
// These are the India 2026 narratives with the most cross-cutting evidence
// (govt capex, PLI schemes, energy transition, drug-price tailwinds,
// China+1 specialty chem). Defence is explicit per the user's note.
const STRUCTURAL_TAILWIND = {
  "Defence":        "Indigenisation push + multi-year orderbooks",
  "Capital Goods":  "Private capex cycle + PLI tailwind",
  "Power":          "500GW non-fossil target + T&D capex",
  "Infrastructure": "Gati Shakti / NIP rollout",
  "Pharma":         "US generics + biosimilars + domestic formulations",
  "Chemicals":      "China+1 specialty chemicals",
};

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Aggregate top_ranked_30_v3 by canonical sector to find which sectors
 * have the highest average FV upside in current SWS top picks.
 *
 * Returns Map<canonicalSector, { count, avgUpside, avgV3, examples[] }>.
 */
function aggregatePicksBySector(picks) {
  const top = picks?.sections?.top_ranked_30_v3 || picks?.sections?.top_ranked_30 || [];
  const bySector = new Map();
  for (const p of top) {
    const canonical = normalizeSector(p?.sector);
    if (!canonical) continue;
    const upside = num(p.upside_pct, NaN);
    const v3 = num(p.v4_score_100 ?? p.v4_score, NaN);
    if (!Number.isFinite(upside) || !Number.isFinite(v3)) continue;
    if (!bySector.has(canonical)) {
      bySector.set(canonical, { count: 0, _upSum: 0, _v3Sum: 0, examples: [] });
    }
    const row = bySector.get(canonical);
    row.count++;
    row._upSum += upside;
    row._v3Sum += v3;
    if (row.examples.length < 3) row.examples.push(p.ticker);
  }
  for (const [s, row] of bySector) {
    row.avgUpside = row._upSum / row.count;
    row.avgV3 = row._v3Sum / row.count;
  }
  return bySector;
}

/**
 * Three-layer tailwind detection. Returns Map<canonicalSector, {
 *   score: 0..18, evidence: [{ layer, reason }]
 * }>.
 *
 * Each layer contributes +6. Evidence array preserves the reason strings
 * so the UI can surface "why this sector matters".
 */
export function detectTailwindSectors({ picks, regime } = {}) {
  const out = new Map();
  const add = (sector, layer, reason) => {
    if (!out.has(sector)) out.set(sector, { score: 0, evidence: [] });
    const row = out.get(sector);
    row.score += 6;
    row.evidence.push({ layer, reason });
  };

  // Layer 1 — structural
  for (const [sector, reason] of Object.entries(STRUCTURAL_TAILWIND)) {
    add(sector, "structural", reason);
  }

  // Layer 2 — FV-upside data layer
  const sectorStats = aggregatePicksBySector(picks);
  for (const [sector, stats] of sectorStats) {
    if (
      stats.count >= TAILWIND_FV_PICK_COUNT_MIN &&
      stats.avgUpside >= TAILWIND_FV_AVG_UPSIDE_MIN &&
      stats.avgV3 >= TAILWIND_FV_AVG_V3_MIN
    ) {
      add(
        sector,
        "fv_upside",
        `${stats.count} top picks averaging +${stats.avgUpside.toFixed(0)}% to FV`,
      );
    }
  }

  // Layer 3 — regime
  if (regime?.sectorImpacts && Array.isArray(regime.sectorImpacts)) {
    for (const impact of regime.sectorImpacts) {
      // Use the regime's own ranked sectorImpacts directly (not
      // computeMacroDelta which scales by severity/confidence) — we want
      // the raw "this regime favours X" signal.
      if (num(impact.impact, 0) >= 2 && impact.sector) {
        add(impact.sector, "regime", impact.reason || `${impact.sector} favoured under ${regime.regime || "current regime"}`);
      }
    }
  }

  return out;
}

/**
 * Build the full sector context the basket selection consumes.
 *
 * @param sectorOverlay Output of buildSectorOverlay — array of
 *   { sector, pct, ... } sorted desc.
 * @param picks Output of loadPicksLatest — used for Layer 2.
 * @param macroRegime Optional regime object — used for Layer 3.
 */
export function buildSectorContext(sectorOverlay = [], picks = null, macroRegime = null) {
  const overweight = new Set();
  const healthy = new Set();
  const underweight = new Set();
  const byCanonical = new Map(); // canonical → pct

  for (const row of sectorOverlay) {
    const canonical = normalizeSector(row.sector) || row.sector;
    if (!canonical) continue;
    const pct = num(row.pct, 0);
    // First-write wins per canonical sector (overlay is sorted desc, so
    // larger one survives if two raw labels collide).
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, pct);
    else byCanonical.set(canonical, byCanonical.get(canonical) + pct);
  }

  for (const [sector, pct] of byCanonical) {
    if (pct >= OVERWEIGHT_PCT_THRESHOLD) overweight.add(sector);
    else if (pct < UNDERWEIGHT_PCT_THRESHOLD && pct > 0) underweight.add(sector);
    else healthy.add(sector);
  }

  const tailwind = detectTailwindSectors({ picks, regime: macroRegime });

  return { overweight, healthy, underweight, byCanonical, tailwind };
}

/**
 * Score how well a candidate sector fits the user's portfolio.
 *
 *   score = gapBase + tailwindBonus × gapMultiplier
 *
 *   gapBase:        missing=10, underweight=4, healthy=0, overweight=−999
 *   tailwindBonus:  0..18 (Layer 1 + 2 + 3)
 *   gapMultiplier:  missing=1.0, underweight=0.7, healthy=0.3, overweight=0
 *
 * Returns { score, gapType, currentPct, tailwindScore, evidence, reason }.
 */
export function scoreSectorFit(candidateSectorRaw, ctx) {
  const canonical = normalizeSector(candidateSectorRaw) || candidateSectorRaw || "Unclassified";
  const currentPct = ctx.byCanonical?.get(canonical) ?? 0;

  let gapType, gapBase, gapMultiplier;
  if (ctx.overweight?.has(canonical)) {
    gapType = "overweight"; gapBase = -999; gapMultiplier = 0;
  } else if (currentPct === 0) {
    gapType = "missing";    gapBase = 10;   gapMultiplier = 1.0;
  } else if (ctx.underweight?.has(canonical)) {
    gapType = "underweight";gapBase = 4;    gapMultiplier = 0.7;
  } else {
    gapType = "healthy";    gapBase = 0;    gapMultiplier = 0.3;
  }

  const tw = ctx.tailwind?.get(canonical);
  const tailwindScore = tw?.score ?? 0;
  const evidence = tw?.evidence ?? [];

  const score = gapType === "overweight"
    ? -999
    : Math.round((gapBase + tailwindScore * gapMultiplier) * 10) / 10;

  return {
    score,
    gapType,
    currentPct,
    tailwindScore,
    evidence,
    canonical,
  };
}

/**
 * Render the per-row "why this fits your portfolio" sentence the UI shows
 * below the FV/PE line. Reads like analyst rationale, not eng jargon.
 */
export function buildPerfectFitReason(row, ctx, sectorFit) {
  const sec = sectorFit.canonical;
  const evidence = sectorFit.evidence?.[0]?.reason;
  const pct = sectorFit.currentPct;

  if (sectorFit.gapType === "overweight") {
    return `${sec} already ${pct.toFixed(1)}% of book — consider trimming first`;
  }
  if (sectorFit.gapType === "missing") {
    return evidence
      ? `Fills missing ${sec} exposure · ${evidence}`
      : `Fills missing ${sec} exposure (0% in book)`;
  }
  if (sectorFit.gapType === "underweight") {
    return evidence
      ? `${sec} only ${pct.toFixed(1)}% of book · ${evidence}`
      : `${sec} only ${pct.toFixed(1)}% of book — room to add`;
  }
  // healthy
  if (evidence) return `${sec} on tailwind · ${evidence}`;
  return `${sec} balanced at ${pct.toFixed(1)}% — high-conviction add`;
}

/**
 * Pick the top N "sector gap" candidates — names that fill missing or
 * underweight sectors AND pass the perfect-fit floor. Caps at 1 row per
 * sector (or 2 if total < 3) so the spotlight diversifies across gaps.
 *
 * Inputs:
 *   candidates — array of basket-row-shaped objects, each with at least
 *                { sector, v4_score, snowflake (or snowflake_total),
 *                  upside_pct, source, ticker }. Pre-filtered to fresh
 *                picks only (holding rows skip the floor in classifyBasket).
 *   ctx        — buildSectorContext output
 *   { limit }  — soft cap, default 5
 */
export function selectSectorGapPicks(candidates, ctx, { limit = 5 } = {}) {
  const eligible = [];
  for (const c of candidates) {
    if (c.source !== "fresh") continue;
    const v4 = num(c.v4_score, 0);
    const snowTotal = num(c.snowflake_total ?? c.snowflake?.total, 0);
    const upside = num(c.upside_pct, NaN);
    if (v4 < PERFECT_FIT_FLOOR.v4) continue;
    if (snowTotal < PERFECT_FIT_FLOOR.snowflake_total) continue;
    if (!Number.isFinite(upside) || upside < PERFECT_FIT_FLOOR.upside_pct) continue;

    const fit = scoreSectorFit(c.sector, ctx);
    if (fit.gapType !== "missing" && fit.gapType !== "underweight") continue;
    eligible.push({
      row: c,
      fit,
      perfectFitScore: v4 + fit.score,
    });
  }

  // Sort priority: missing+tailwind > missing > underweight+tailwind >
  // underweight, then by perfectFitScore desc within each band.
  const priority = (e) => {
    const isMissing = e.fit.gapType === "missing";
    const hasTail = e.fit.tailwindScore > 0;
    if (isMissing && hasTail) return 0;
    if (isMissing) return 1;
    if (hasTail) return 2;
    return 3;
  };
  eligible.sort((a, b) => {
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return b.perfectFitScore - a.perfectFitScore;
  });

  // Diversify across sectors. Allow 2/sector only if total < 3.
  const perSectorCap = eligible.length < 3 ? 2 : 1;
  const seen = new Map();
  const out = [];
  for (const e of eligible) {
    const sec = e.fit.canonical;
    const used = seen.get(sec) || 0;
    if (used >= perSectorCap) continue;
    seen.set(sec, used + 1);
    out.push({
      ...e.row,
      _sectorFit: e.fit,
      perfectFitScore: e.perfectFitScore,
      whyFit: buildPerfectFitReason(e.row, ctx, e.fit),
      gapSector: sec,
      gapType: e.fit.gapType,
    });
    if (out.length >= limit) break;
  }
  return out;
}
