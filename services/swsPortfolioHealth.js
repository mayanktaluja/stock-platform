// Portfolio Health Score (0–100) — SWS-weighted composite with macro overlay.
//
// Reads from:
//   • snapshot (output of buildSnapshot in swsPortfolioAggregate) — totals,
//     holdingsCount, coveredCount, sector distribution (computed locally).
//   • scoredHoldings[] — output of swsHoldingEngine.scoreHolding(); each row
//     carries h.sws (snowflake/v3/upside/surveillance/indianRisk), h.action,
//     h.positionWeight, h.sector, h.pnlPercent, h.swsCovered.
//   • opts.macroRegime (optional) — passed through to macroRegime.computeMacroDelta.
//
// Pure function. No I/O, no globals.

import { num } from "./swsScoring.js";

// Lazy macro-regime import — same pattern as swsPortfolioAggregate. Failing
// import degrades to no macro tilt rather than throwing.
let _computeMacroDelta = null;
try {
  const mod = await import("../macroRegime.js");
  if (typeof mod.computeMacroDelta === "function") _computeMacroDelta = mod.computeMacroDelta;
} catch {}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Linear map of x in [a,b] → [outA, outB], clamped.
function mapRange(x, a, b, outA, outB) {
  if (!Number.isFinite(x)) return outA;
  const t = (x - a) / (b - a);
  const c = clamp(t, 0, 1);
  return outA + (outB - outA) * c;
}

function bandFromScore(score) {
  if (score >= 85) return { grade: "A", band: "Resilient", color: "#22c55e" };
  if (score >= 70) return { grade: "B", band: "Healthy", color: "#60a5fa" };
  if (score >= 55) return { grade: "C", band: "Mixed", color: "#fbbf24" };
  if (score >= 40) return { grade: "D", band: "Fragile", color: "#fb923c" };
  return { grade: "E", band: "Action Required", color: "#ef4444" };
}

// Sector weights from holdings → Map<sector, weightFraction>.
// Weights sum to 1 (or ~1 if total currentValue > 0).
function sectorWeights(scoredHoldings) {
  const bySector = new Map();
  let total = 0;
  for (const h of scoredHoldings) {
    const cv = num(h.currentValue, 0);
    if (cv <= 0) continue;
    const sector = h.sector || (h.swsCovered ? h.sws?.sector : null) || "Unclassified";
    bySector.set(sector, (bySector.get(sector) || 0) + cv);
    total += cv;
  }
  if (total <= 0) return new Map();
  for (const [k, v] of bySector) bySector.set(k, v / total);
  return bySector;
}

// Herfindahl–Hirschman Index across sectors. Range: 1/N → 1.
function hhi(sectorWeightMap) {
  let s = 0;
  for (const w of sectorWeightMap.values()) s += w * w;
  return s;
}

// Top-N concentration by single-position weight (uses h.positionWeight in %).
function topNConcentration(scoredHoldings, n) {
  const weights = scoredHoldings
    .map((h) => num(h.positionWeight, 0))
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => b - a);
  return weights.slice(0, n).reduce((s, w) => s + w, 0);
}

// Weighted average of a per-holding scalar by positionWeight. Returns null
// when no holding contributes.
function weightedAvg(scoredHoldings, getValue) {
  let wSum = 0;
  let vSum = 0;
  for (const h of scoredHoldings) {
    const w = num(h.positionWeight, 0);
    const v = getValue(h);
    if (!Number.isFinite(w) || w <= 0 || v == null || !Number.isFinite(v)) continue;
    wSum += w;
    vSum += v * w;
  }
  return wSum > 0 ? vSum / wSum : null;
}

// ─── Component computations ──────────────────────────────────────────

// Quality: weighted avg v3_score → +0..35 mapped 0→0, 50→17.5, 100→35.
function _quality(scoredHoldings) {
  const avg = weightedAvg(scoredHoldings, (h) => (h.swsCovered ? num(h.sws?.v3_score, null) : null));
  if (avg == null) return { delta: 0, avg: null };
  return { delta: +mapRange(avg, 0, 100, 0, 35).toFixed(2), avg: +avg.toFixed(1) };
}

// Valuation: weighted avg upside_pct, capped [-20, +30] → +0..15. Piecewise
// so the midpoint (fair value, 0% upside) lands at 7.5 — discount half is
// [0..7.5], premium half is [7.5..15], which mirrors the user-facing spec.
function _valuation(scoredHoldings) {
  const avg = weightedAvg(scoredHoldings, (h) => (h.swsCovered ? num(h.sws?.upside_pct, null) : null));
  if (avg == null) return { delta: 0, avg: null };
  const delta = avg <= 0
    ? mapRange(avg, -20, 0, 0, 7.5)
    : mapRange(avg, 0, 30, 7.5, 15);
  return { delta: +delta.toFixed(2), avg: +avg.toFixed(1) };
}

// Diversification: (1 − HHI_sector) × 15.
function _diversification(scoredHoldings) {
  const w = sectorWeights(scoredHoldings);
  if (w.size === 0) return { delta: 0, hhi: null, sectorCount: 0 };
  const h = hhi(w);
  const delta = +((1 - h) * 15).toFixed(2);
  return { delta, hhi: +h.toFixed(3), sectorCount: w.size };
}

// Concentration: top1 / top3 thresholds, summed and clamped to [-10, 0].
function _concentration(scoredHoldings) {
  const top1 = topNConcentration(scoredHoldings, 1);
  const top3 = topNConcentration(scoredHoldings, 3);
  let delta = 0;
  if (top1 > 35) delta -= 6;
  else if (top1 > 25) delta -= 3;
  if (top3 > 70) delta -= 4;
  else if (top3 > 60) delta -= 2;
  delta = clamp(delta, -10, 0);
  return { delta, top1: +top1.toFixed(1), top3: +top3.toFixed(1) };
}

// Risk: per-holding action + surveillance + pledge contributions, clamped to [-10, 0].
function _risk(scoredHoldings) {
  let delta = 0;
  let exitCount = 0;
  let reductionCount = 0;
  let surveillanceCount = 0;
  let pledgeCount = 0;
  for (const h of scoredHoldings) {
    const action = h.action;
    if (action === "EXIT" || action === "EXIT-now") {
      delta -= 3;
      exitCount++;
    } else if (action === "EXIT-staged") {
      delta -= 2;
      exitCount++;
    } else if (action === "Reduction-66%") {
      delta -= 2;
      reductionCount++;
    } else if (action === "Reduction-50%") {
      delta -= 1;
      reductionCount++;
    }

    const surv = h.sws?.surveillance || h.sws?.indianRisk?.surveillance || null;
    if (surv?.list === "GSM") {
      delta -= 3;
      surveillanceCount++;
    } else if (surv?.list === "ASM") {
      delta -= 1;
      surveillanceCount++;
    }

    // promoter_pledge is a fraction (0..1) on indianRisk.governance_snapshot.
    const pledge = num(h.sws?.indianRisk?.governance_snapshot?.promoter_pledge, null);
    if (pledge != null && pledge > 0.30) {
      delta -= 2;
      pledgeCount++;
    } else if (pledge != null && pledge > 0.10) {
      delta -= 1;
      pledgeCount++;
    }
  }
  delta = clamp(delta, -10, 0);
  return { delta, exitCount, reductionCount, surveillanceCount, pledgeCount };
}

// Macro: Σ over holdings of computeMacroDelta(regime, sector) × positionWeight.
// positionWeight is in %, so divide by 100 before summing. Clamped to [-10, +10].
function _macro(scoredHoldings, macroRegime) {
  if (!macroRegime || !_computeMacroDelta) return { delta: 0, regime: null };
  let weightedDelta = 0;
  for (const h of scoredHoldings) {
    const sector = h.sector || (h.swsCovered ? h.sws?.sector : null);
    if (!sector) continue;
    const wPct = num(h.positionWeight, 0);
    if (!Number.isFinite(wPct) || wPct <= 0) continue;
    const tilt = _computeMacroDelta(macroRegime, sector);
    if (!tilt || !Number.isFinite(tilt.delta)) continue;
    weightedDelta += tilt.delta * (wPct / 100);
  }
  const delta = +clamp(weightedDelta, -10, 10).toFixed(2);
  return { delta, regime: macroRegime.regime || null };
}

// P&L drag: > 50% of holdings in red → -5; > 35% → -2.
function _pnl(scoredHoldings) {
  if (scoredHoldings.length === 0) return { delta: 0, redCount: 0, redRatio: 0 };
  let red = 0;
  for (const h of scoredHoldings) {
    if (num(h.pnlPercent, 0) < 0) red++;
  }
  const ratio = red / scoredHoldings.length;
  let delta = 0;
  if (ratio > 0.50) delta = -5;
  else if (ratio > 0.35) delta = -2;
  return { delta, redCount: red, redRatio: +ratio.toFixed(2) };
}

// Coverage taper. SWS-derived components scale by max(0.6, covered/total).
function _coverageFactor(scoredHoldings) {
  if (scoredHoldings.length === 0) return 1;
  const covered = scoredHoldings.filter((h) => h.swsCovered).length;
  return Math.max(0.6, covered / scoredHoldings.length);
}

// ─── Driver / drag string builders ───────────────────────────────────

function _qualityLabel(q) {
  if (q.avg == null) return "Quality unscored";
  return `Avg quality (v3 ${q.avg.toFixed(1)})`;
}
function _valuationLabel(v) {
  if (v.avg == null) return "Valuation unscored";
  if (v.avg > 0) return `Discount to FV (avg upside ${v.avg.toFixed(1)}%)`;
  return `Premium to FV (avg upside ${v.avg.toFixed(1)}%)`;
}
function _diversificationLabel(d) {
  if (d.hhi == null) return "Diversification unscored";
  return `Sector spread (HHI ${d.hhi.toFixed(2)}, ${d.sectorCount} sectors)`;
}
function _concentrationLabel(c) {
  if (c.top1 > 35) return `Top-1 concentration ${c.top1.toFixed(0)}%`;
  if (c.top3 > 60) return `Top-3 concentration ${c.top3.toFixed(0)}%`;
  return `Concentration (top-1 ${c.top1.toFixed(0)}%, top-3 ${c.top3.toFixed(0)}%)`;
}
function _riskLabel(r) {
  const parts = [];
  if (r.exitCount) parts.push(`${r.exitCount} EXIT`);
  if (r.reductionCount) parts.push(`${r.reductionCount} Reduction`);
  if (r.surveillanceCount) parts.push(`${r.surveillanceCount} on surveillance`);
  if (r.pledgeCount) parts.push(`${r.pledgeCount} with pledge`);
  return parts.length ? parts.join(", ") : "No flagged risks";
}
function _macroLabel(m) {
  if (!m.regime) return "Macro neutral";
  return m.delta >= 0 ? `Macro tailwind (${m.regime})` : `Macro headwind (${m.regime})`;
}
function _pnlLabel(p) {
  if (p.redRatio === 0) return "All holdings green";
  return `${Math.round(p.redRatio * 100)}% of book in red`;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Compute the Portfolio Health Score (0–100) with grade band, components,
 * and ranked driver/drag lists.
 *
 * @param {object} snapshot  output of buildSnapshot (read for totals, not strictly required)
 * @param {Array}  scoredHoldings  per-holding rows from scoreHolding()
 * @param {object} [opts]
 * @param {object} [opts.macroRegime]  current regime object (or null)
 * @param {string} [opts.asOf]         ISO timestamp (default now)
 * @returns {object|null}  null when scoredHoldings is empty
 */
export function computePortfolioHealth(snapshot, scoredHoldings, opts = {}) {
  if (!Array.isArray(scoredHoldings) || scoredHoldings.length === 0) return null;

  const asOf = opts.asOf || new Date().toISOString();
  const macroRegime = opts.macroRegime || null;

  const q = _quality(scoredHoldings);
  const v = _valuation(scoredHoldings);
  const d = _diversification(scoredHoldings);
  const c = _concentration(scoredHoldings);
  const r = _risk(scoredHoldings);
  const m = _macro(scoredHoldings, macroRegime);
  const p = _pnl(scoredHoldings);
  const cov = _coverageFactor(scoredHoldings);

  // Coverage taper applies only to SWS-derived components.
  const qScaled = +(q.delta * cov).toFixed(2);
  const vScaled = +(v.delta * cov).toFixed(2);
  const rScaled = +(r.delta * cov).toFixed(2);

  const base = 60;
  const raw = base + qScaled + vScaled + d.delta + c.delta + rScaled + m.delta + p.delta;
  const score = clamp(Math.round(raw), 0, 100);
  const { grade, band, color } = bandFromScore(score);

  // Build the per-component contribution list (sorted by abs delta).
  const contribs = [
    { key: "quality",         label: _qualityLabel(q),         delta: qScaled },
    { key: "valuation",       label: _valuationLabel(v),       delta: vScaled },
    { key: "diversification", label: _diversificationLabel(d), delta: d.delta },
    { key: "concentration",   label: _concentrationLabel(c),   delta: c.delta },
    { key: "risk",            label: _riskLabel(r),            delta: rScaled },
    { key: "macro",           label: _macroLabel(m),           delta: m.delta },
    { key: "pnl",             label: _pnlLabel(p),             delta: p.delta },
  ];

  const topDrivers = contribs
    .filter((x) => x.delta > 0.5)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map((x) => ({ label: x.label, delta: +x.delta.toFixed(1) }));

  const topDrags = contribs
    .filter((x) => x.delta < -0.5)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3)
    .map((x) => ({ label: x.label, delta: +x.delta.toFixed(1) }));

  // Edge-case explanatory notes appended to the driver list as a soft signal.
  const notes = [];
  if (scoredHoldings.length === 1) {
    notes.push("Single-holding book — diversification scored 0 by definition.");
  }
  if (cov <= 0.6 && cov < (scoredHoldings.filter((h) => h.swsCovered).length / scoredHoldings.length || 0) + 0.001) {
    notes.push("No SWS coverage — score reflects diversification and P&L only.");
  }

  return {
    score,
    grade,
    band,
    color,
    components: {
      base,
      quality: qScaled,
      valuation: vScaled,
      diversification: d.delta,
      concentration: c.delta,
      risk: rScaled,
      macro: m.delta,
      pnl: p.delta,
      coverageFactor: +cov.toFixed(2),
    },
    topDrivers,
    topDrags,
    notes,
    asOf,
    methodologyNote:
      "Weighted from SWS quality, valuation, diversification, risk and macro fit. Mental model only — not a recommendation.",
  };
}
