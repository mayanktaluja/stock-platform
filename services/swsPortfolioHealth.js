// Portfolio Health Score (0–100) — earned-points composite with macro overlay.
//
// SEBI-style framing: the score is fully *earned* from zero across seven
// components (Quality 25 + Valuation 15 + Diversification 15 +
// Concentration 10 + Risk 15 + Loss control 10 + Macro 10 = 100), then
// clamped by hard caps for severe red flags (large concentration,
// surveillance, pledge, aggregate loss).
//
// Reads from:
//   • snapshot (output of buildSnapshot in swsPortfolioAggregate) — totals,
//     holdingsCount, coveredCount, sector distribution (computed locally).
//   • scoredHoldings[] — output of swsHoldingEngine.scoreHolding(); each row
//     carries h.sws (snowflake/v3/upside/surveillance/indianRisk), h.action,
//     h.positionWeight, h.sector, h.pnlPercent, h.swsCovered, h.currentValue.
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

function verdictFromScore(score) {
  if (score >= 80) return "HEALTHY";
  if (score >= 65) return "GOOD";
  if (score >= 50) return "NEEDS_ATTENTION";
  if (score >= 35) return "AT_RISK";
  return "CRITICAL";
}

// Sector weights from holdings → Map<sector, weightFraction>.
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

// Quality: weighted avg v4_score → 0..25. Linear map 0→0, 50→12.5, 100→25.
function _quality(scoredHoldings) {
  const avg = weightedAvg(scoredHoldings, (h) => (h.swsCovered ? num(h.sws?.v4_score, null) : null));
  if (avg == null) return { delta: 0, avg: null };
  return { delta: +mapRange(avg, 0, 100, 0, 25).toFixed(2), avg: +avg.toFixed(1) };
}

// Valuation: weighted avg upside_pct → 0..15 (piecewise). Fair value (0%)
// lands at the midpoint 7.5; deep discount (≥+30%) → 15; deep premium
// (≤-20%) → 0.
function _valuation(scoredHoldings) {
  const avg = weightedAvg(scoredHoldings, (h) => (h.swsCovered ? num(h.sws?.upside_pct, null) : null));
  if (avg == null) return { delta: 0, avg: null };
  const delta = avg <= 0
    ? mapRange(avg, -20, 0, 0, 7.5)
    : mapRange(avg, 0, 30, 7.5, 15);
  return { delta: +delta.toFixed(2), avg: +avg.toFixed(1) };
}

// Diversification: (1 − HHI_sector) × 15 → 0..15.
function _diversification(scoredHoldings) {
  const w = sectorWeights(scoredHoldings);
  if (w.size === 0) return { delta: 0, hhi: null, sectorCount: 0 };
  const h = hhi(w);
  const delta = +((1 - h) * 15).toFixed(2);
  return { delta, hhi: +h.toFixed(3), sectorCount: w.size };
}

// Concentration: stepped on top-1 single-position weight → 0..10.
//   ≤8% → 10, ≤12% → 7, ≤18% → 4, ≤25% → 1, >25% → 0.
function _concentration(scoredHoldings) {
  const top1 = topNConcentration(scoredHoldings, 1);
  const top3 = topNConcentration(scoredHoldings, 3);
  let delta;
  if (top1 <= 8) delta = 10;
  else if (top1 <= 12) delta = 7;
  else if (top1 <= 18) delta = 4;
  else if (top1 <= 25) delta = 1;
  else delta = 0;
  return { delta, top1: +top1.toFixed(1), top3: +top3.toFixed(1) };
}

// Risk: starts at 15 (no flags), deducts per per-holding action /
// surveillance / pledge flag, floors at 0. Full 15 = clean book.
function _risk(scoredHoldings) {
  let delta = 15;
  let exitCount = 0;
  let reductionCount = 0;
  let surveillanceCount = 0;
  let pledgeCount = 0;
  for (const h of scoredHoldings) {
    const action = h.action;
    if (action === "EXIT" || action === "EXIT-now") {
      delta -= 4;
      exitCount++;
    } else if (action === "EXIT-staged") {
      delta -= 3;
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
      delta -= 4;
      surveillanceCount++;
    } else if (surv?.list === "ASM") {
      delta -= 1;
      surveillanceCount++;
    }

    const pledge = num(h.sws?.indianRisk?.governance_snapshot?.promoter_pledge, null);
    if (pledge != null && pledge > 0.30) {
      delta -= 3;
      pledgeCount++;
    } else if (pledge != null && pledge > 0.10) {
      delta -= 1;
      pledgeCount++;
    }
  }
  delta = clamp(delta, 0, 15);
  return { delta, exitCount, reductionCount, surveillanceCount, pledgeCount };
}

// Macro: weighted sector tilt → 0..10. Neutral macro (no regime) = 5.
// Full tailwind across the book → 10; full headwind → 0.
function _macro(scoredHoldings, macroRegime) {
  if (!macroRegime || !_computeMacroDelta) return { delta: 5, regime: null, weightedDelta: 0 };
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
  // weightedDelta is in [-10..+10]. Map 0 → 5, +10 → 10, -10 → 0.
  const delta = +clamp(5 + weightedDelta / 2, 0, 10).toFixed(2);
  return { delta, regime: macroRegime.regime || null, weightedDelta: +weightedDelta.toFixed(2) };
}

// Loss control: % of book *value* in red positions → 0..10 (stepped).
// ≤10% → 10, ≤25% → 7, ≤40% → 4, ≤55% → 1, >55% → 0.
function _lossControl(scoredHoldings) {
  if (scoredHoldings.length === 0) return { delta: 0, redValuePct: 0, redCount: 0 };
  let totalValue = 0;
  let redValue = 0;
  let redCount = 0;
  for (const h of scoredHoldings) {
    const cv = num(h.currentValue, 0);
    if (cv <= 0) continue;
    totalValue += cv;
    if (num(h.pnlPercent, 0) < 0) {
      redValue += cv;
      redCount++;
    }
  }
  const ratio = totalValue > 0 ? redValue / totalValue : 0;
  let delta;
  if (ratio <= 0.10) delta = 10;
  else if (ratio <= 0.25) delta = 7;
  else if (ratio <= 0.40) delta = 4;
  else if (ratio <= 0.55) delta = 1;
  else delta = 0;
  return { delta, redValuePct: +(ratio * 100).toFixed(1), redCount };
}

// Aggregate P&L (value-weighted) — only used for cap detection.
function _aggregatePnLPct(scoredHoldings) {
  let totalCurrent = 0;
  let totalInvested = 0;
  for (const h of scoredHoldings) {
    const cv = num(h.currentValue, 0);
    const pnlPct = num(h.pnlPercent, 0);
    if (cv <= 0 || !Number.isFinite(pnlPct)) continue;
    const denom = 1 + pnlPct / 100;
    if (denom <= 0) continue;
    const inv = cv / denom;
    if (!Number.isFinite(inv) || inv <= 0) continue;
    totalCurrent += cv;
    totalInvested += inv;
  }
  if (totalInvested <= 0) return null;
  return ((totalCurrent - totalInvested) / totalInvested) * 100;
}

// Hard caps — clamp the additive score for severe red flags. Lowest cap
// wins when multiple fire.
function _computeCaps(scoredHoldings) {
  const caps = [];

  const top1 = topNConcentration(scoredHoldings, 1);
  if (top1 > 40) {
    caps.push({ rule: "top1>40", capValue: 55, reason: `Top holding ${top1.toFixed(0)}% of book` });
  } else if (top1 > 30) {
    caps.push({ rule: "top1>30", capValue: 65, reason: `Top holding ${top1.toFixed(0)}% of book` });
  }

  const aggPnL = _aggregatePnLPct(scoredHoldings);
  if (aggPnL != null && aggPnL < -25) {
    caps.push({ rule: "aggPnL<-25", capValue: 70, reason: `Aggregate P&L ${aggPnL.toFixed(1)}%` });
  }

  const secW = sectorWeights(scoredHoldings);
  let maxSecWeight = 0;
  let maxSecName = "";
  for (const [name, w] of secW) {
    if (w > maxSecWeight) {
      maxSecWeight = w;
      maxSecName = name;
    }
  }
  if (maxSecWeight > 0.55) {
    caps.push({
      rule: "sector>55",
      capValue: 70,
      reason: `${maxSecName} ${(maxSecWeight * 100).toFixed(0)}% of book`,
    });
  }

  const gsmHolding = scoredHoldings.find((h) => {
    const surv = h.sws?.surveillance || h.sws?.indianRisk?.surveillance || null;
    return surv?.list === "GSM";
  });
  if (gsmHolding) {
    const tk = gsmHolding.sws?.ticker || gsmHolding.symbol || "?";
    caps.push({ rule: "gsm", capValue: 70, reason: `${tk} on GSM surveillance` });
  }

  for (const h of scoredHoldings) {
    const pledge = num(h.sws?.indianRisk?.governance_snapshot?.promoter_pledge, null);
    const wPct = num(h.positionWeight, 0);
    if (pledge != null && pledge > 0.30 && wPct > 5) {
      const tk = h.sws?.ticker || h.symbol || "?";
      caps.push({
        rule: "pledge>30+w>5",
        capValue: 75,
        reason: `${tk} pledge ${(pledge * 100).toFixed(0)}%, weight ${wPct.toFixed(0)}%`,
      });
      break;
    }
  }

  return caps;
}

// Coverage taper. SWS-derived components (quality, valuation) scale by
// max(0.6, covered/total).
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
  if (c.top1 > 25) return `Top-1 concentration ${c.top1.toFixed(0)}%`;
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
  return m.weightedDelta >= 0 ? `Macro tailwind (${m.regime})` : `Macro headwind (${m.regime})`;
}
function _lossControlLabel(l) {
  if (l.redValuePct === 0) return "All holdings green";
  return `${Math.round(l.redValuePct)}% of book in red`;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Compute the Portfolio Health Score (0–100) with grade band, verdict,
 * components, hard caps, and ranked driver/drag lists.
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
  const l = _lossControl(scoredHoldings);
  const cov = _coverageFactor(scoredHoldings);

  // Coverage taper applies only to SWS-derived signals (quality, valuation).
  // Risk flags (action/surveillance/pledge) are independent of SWS coverage,
  // and concentration/diversification/loss-control/macro come from book
  // structure or independent feeds.
  const qScaled = +(q.delta * cov).toFixed(2);
  const vScaled = +(v.delta * cov).toFixed(2);

  // Earned-points sum (no base — score is fully earned from zero).
  const summed = qScaled + vScaled + d.delta + c.delta + r.delta + l.delta + m.delta;
  let raw = clamp(summed, 0, 100);

  // Hard caps for severe red flags.
  const caps = _computeCaps(scoredHoldings);
  let capAppliedAt = null;
  if (caps.length > 0) {
    const lowest = Math.min(...caps.map((cap) => cap.capValue));
    if (raw > lowest) {
      capAppliedAt = lowest;
      raw = lowest;
    }
  }

  const score = clamp(Math.round(raw), 0, 100);
  const { grade, band, color } = bandFromScore(score);
  const verdict = verdictFromScore(score);

  // Build per-component contribution list. Drivers/drags are computed
  // relative to each component's mid-point so the user sees "what's
  // helping vs hurting" relative to a balanced book, not just absolute pts.
  const contribs = [
    { key: "quality",         label: _qualityLabel(q),         earned: qScaled,  mid: 12.5 },
    { key: "valuation",       label: _valuationLabel(v),       earned: vScaled,  mid: 7.5 },
    { key: "diversification", label: _diversificationLabel(d), earned: d.delta,  mid: 7.5 },
    { key: "concentration",   label: _concentrationLabel(c),   earned: c.delta,  mid: 5 },
    { key: "risk",            label: _riskLabel(r),            earned: r.delta,  mid: 12 },
    { key: "macro",           label: _macroLabel(m),           earned: m.delta,  mid: 5 },
    { key: "lossControl",     label: _lossControlLabel(l),     earned: l.delta,  mid: 7 },
  ].map((row) => ({ ...row, delta: +(row.earned - row.mid).toFixed(2) }));

  const topDrivers = contribs
    .filter((x) => x.delta >= 1.0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map((x) => ({ label: x.label, delta: +x.delta.toFixed(1) }));

  const topDrags = contribs
    .filter((x) => x.delta <= -1.0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3)
    .map((x) => ({ label: x.label, delta: +x.delta.toFixed(1) }));

  // Edge-case explanatory notes.
  const notes = [];
  if (scoredHoldings.length === 1) {
    notes.push("Single-holding book — diversification scored 0 by definition.");
  }
  const coveredCount = scoredHoldings.filter((h) => h.swsCovered).length;
  if (cov <= 0.6 && coveredCount / scoredHoldings.length < 0.6) {
    notes.push("Low SWS coverage — quality and valuation tapered.");
  }
  if (capAppliedAt != null) {
    notes.push(`Score capped at ${capAppliedAt}: ${caps.map((x) => x.reason).join("; ")}`);
  }

  return {
    score,
    grade,
    band,
    color,
    verdict,
    caps: caps.length ? caps : undefined,
    capAppliedAt,
    components: {
      quality: qScaled,
      valuation: vScaled,
      diversification: d.delta,
      concentration: c.delta,
      risk: r.delta,
      lossControl: l.delta,
      macro: m.delta,
      coverageFactor: +cov.toFixed(2),
    },
    topDrivers,
    topDrags,
    notes,
    asOf,
    methodologyNote:
      "Earned-points health: Quality 25 + Valuation 15 + Diversification 15 + Concentration 10 + Risk 15 + Loss control 10 + Macro 10. Hard caps for outsized concentration, GSM surveillance, pledged equity, or aggregate losses. Educational content only.",
  };
}
