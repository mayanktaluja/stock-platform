// What-if simulator — given the analyzer's cached scored holdings + a
// list of {ticker, deltaRupees} mutations, recompute the portfolio
// metrics that would result and return a baseline/scenario/delta blob
// the UI can render side-by-side. No re-scoring, no SWS-engine call —
// the simulator works on the already-scored snapshot, so each slider
// tick is a sub-100ms recompute.
//
// The simulator is the surface that turns the analyzer from a research
// dossier into a recommendation engine. Investors get to ask "if I
// trim ₹20K of HAL and deploy ₹20K in NETWEB, what changes?" without
// uploading a new portfolio file.
//
// PURE FUNCTION. No I/O, no LLM. Inputs are already-scored holdings +
// a list of mutations + tax + today context. Outputs are deterministic.
//
// Mutation shape:
//   { ticker, deltaRupees }     — positive = top-up, negative = trim/exit
//
// Output shape:
//   {
//     baseline:       { ...metrics }
//     scenario:       { ...metrics, mutationApplied: true }
//     deltas:         { healthScore, beta, illiquidPct, totalValue,
//                       concentrationPct, sectorMix: { sector → ±pct } }
//     realisedTax:    ₹ tax cost from all trim mutations
//     warnings:       [] of strings (over-trim, unknown ticker, etc.)
//   }

import { num } from "./swsScoring.js";
import { computeExitTax } from "../taxEngine.js";
import { bucketByDaysToExit } from "./liquidityTail.js";

// ─── Metrics ─────────────────────────────────────────────────────
//
// Health score formula (deterministic, simulator-grade):
//   50 base
//   + 0.3 × avgV3            (weighted by current value, ~0-30 contribution)
//   + diversification        (0-20, HHI-derived)
//   + concentration penalty  (0 to -15 if any position > 15%)
//   + illiquid penalty       (-1.5 × illiquidPct)
// Clamped to [0, 100].
//
// This is intentionally a SIMPLER scorer than the full
// portfolioIntelligence.computeHealthScore — that one needs daily
// return series + macro regime which the simulator doesn't have at
// hand. The point is to show DIRECTION OF CHANGE (does my trim help
// or hurt?), not produce a SEBI-grade absolute number; the analyzer's
// own health card already does that.

function _computeMetrics(holdings) {
  // ─── Sector map + concentration ───
  const sectorValue = new Map();
  let totalValue = 0;
  let weightedV3Sum = 0;
  let weightedV3Weight = 0;
  let weightedBetaSum = 0;
  let weightedBetaWeight = 0;
  let largestPositionPct = 0;

  for (const h of holdings) {
    const cv = num(h.currentValue, 0);
    if (cv <= 0) continue;
    totalValue += cv;
    const sector = h.sws?.sector || "Unclassified";
    sectorValue.set(sector, (sectorValue.get(sector) || 0) + cv);

    const v3 = num(h.sws?.v3_score, null);
    if (v3 != null) {
      weightedV3Sum += v3 * cv;
      weightedV3Weight += cv;
    }
    const beta = num(h.sws?.beta, null);
    if (beta != null) {
      weightedBetaSum += beta * cv;
      weightedBetaWeight += cv;
    }
  }

  if (totalValue <= 0) {
    return {
      totalValue: 0, holdingsCount: holdings.length,
      sectorMix: {}, hhi: 0, diversification: 0,
      avgV3: null, weightedBeta: null,
      largestPositionPct: 0, top5Pct: 0, concentrationPct: 0,
      illiquidPct: 0,
      healthScore: 50,
    };
  }

  // ─── Sector mix (% of book per sector) ───
  const sectorMix = {};
  let hhi = 0;
  for (const [sector, value] of sectorValue.entries()) {
    const pct = +((value / totalValue) * 100).toFixed(1);
    sectorMix[sector] = pct;
    hhi += Math.pow(pct / 100, 2);
  }
  // Diversification: HHI 0.1 (10 sectors evenly) → 20pts; HHI 1 → 0.
  const diversification = Math.max(0, Math.min(20, Math.round((1 - hhi) * 22)));

  // ─── Concentration ───
  // Sort holdings by current value, get top-5 sum + largest position pct.
  const sortedByValue = [...holdings]
    .filter((h) => num(h.currentValue, 0) > 0)
    .sort((a, b) => num(b.currentValue, 0) - num(a.currentValue, 0));
  const top5Value = sortedByValue.slice(0, 5).reduce((s, h) => s + num(h.currentValue, 0), 0);
  const top5Pct = +((top5Value / totalValue) * 100).toFixed(1);
  if (sortedByValue.length > 0) {
    largestPositionPct = +((num(sortedByValue[0].currentValue, 0) / totalValue) * 100).toFixed(1);
  }
  const concentrationPenalty = largestPositionPct > 15 ? -15 : largestPositionPct > 10 ? -5 : 0;

  // ─── Illiquid ───
  const liquidityTail = bucketByDaysToExit(holdings);
  const illiquidPct = liquidityTail.illiquidPct;
  const illiquidPenalty = -1.5 * illiquidPct;

  // ─── Average v3 (weighted) ───
  const avgV3 = weightedV3Weight > 0 ? +(weightedV3Sum / weightedV3Weight).toFixed(1) : null;
  const weightedBeta = weightedBetaWeight > 0 ? +(weightedBetaSum / weightedBetaWeight).toFixed(2) : null;

  // ─── Health score ───
  const v3Component = avgV3 != null ? avgV3 * 0.3 : 0;
  const rawHealth = 50 + v3Component + diversification + concentrationPenalty + illiquidPenalty;
  const healthScore = Math.max(0, Math.min(100, +rawHealth.toFixed(1)));

  return {
    totalValue: Math.round(totalValue),
    holdingsCount: holdings.length,
    sectorMix,
    hhi: +hhi.toFixed(3),
    diversification,
    avgV3,
    weightedBeta,
    largestPositionPct,
    top5Pct,
    concentrationPct: top5Pct,
    illiquidPct,
    healthScore,
  };
}

// ─── Simulator ────────────────────────────────────────────────────

/**
 * Run a what-if simulation against a scored portfolio.
 *
 * @param {object} input
 * @param {object[]} input.scoredHoldings      Holdings from the SWS engine (each with sws.ticker, currentValue, invested, sws.sector, etc.)
 * @param {object[]} input.mutations           [{ ticker, deltaRupees }, ...]
 * @param {object[]} [input.freshPicks]        Outside-portfolio picks the user can deploy into (each with ticker, sector, market_cap_inr, snowflake, v3_score)
 * @param {object} [input.fyContext]           buildFyContext output for tax math
 * @param {Date|string} [input.today]
 * @param {string} [input.assetClass]          Default "equity"
 * @returns {{ baseline, scenario, deltas, realisedTax, mutationsApplied, warnings }}
 */
export function simulate({
  scoredHoldings,
  mutations = [],
  freshPicks = [],
  fyContext,
  today,
  assetClass = "equity",
}) {
  const warnings = [];
  const baseline = _computeMetrics(scoredHoldings);

  // Build a working copy of holdings, indexed by ticker for fast mutation lookup.
  const byTicker = new Map();
  const mutated = scoredHoldings.map((h) => {
    const tk = h.sws?.ticker || h.symbol || h.ticker;
    const copy = { ...h, sws: { ...h.sws } };
    if (tk) byTicker.set(tk, copy);
    return copy;
  });

  let realisedTax = 0;
  const mutationsApplied = [];

  for (const m of (mutations || [])) {
    const ticker = m?.ticker;
    const delta = num(m?.deltaRupees, 0);
    if (!ticker || delta === 0) continue;

    const existing = byTicker.get(ticker);
    if (existing) {
      const cv = num(existing.currentValue, 0);
      const inv = num(existing.invested, 0);
      const newCv = cv + delta;
      if (newCv < 0) {
        warnings.push(`${ticker}: trim of ₹${Math.abs(delta).toLocaleString("en-IN")} exceeds current value ₹${cv.toLocaleString("en-IN")} — capping at full exit.`);
        // Treat as a full exit
        if (delta < 0 && cv > 0) {
          if (existing.purchaseDate) {
            const t = computeExitTax({
              investedRupees: inv,
              currentValueRupees: cv,
              exitFractionPct: 100,
              purchaseDate: existing.purchaseDate,
              fyContext, today, assetClass,
            });
            realisedTax += t.taxCostRupees;
          }
          existing.currentValue = 0;
          existing.invested = 0;
          mutationsApplied.push({ ticker, deltaRupees: -cv, kind: "full-exit", warning: "capped" });
        }
        continue;
      }
      if (delta < 0) {
        // Trim — realise tax pro-rata
        const trimPct = Math.min(100, (-delta / cv) * 100);
        if (existing.purchaseDate) {
          const t = computeExitTax({
            investedRupees: inv,
            currentValueRupees: cv,
            exitFractionPct: trimPct,
            purchaseDate: existing.purchaseDate,
            fyContext, today, assetClass,
          });
          realisedTax += t.taxCostRupees;
        }
        // Cost basis reduces pro-rata too (so net unrealised P&L stays scaled).
        existing.currentValue = newCv;
        existing.invested = inv * (newCv / cv);
        mutationsApplied.push({ ticker, deltaRupees: delta, kind: "trim", trimPct: +trimPct.toFixed(1) });
      } else {
        // Top-up — adds capital basis 1:1 (no tax event).
        existing.currentValue = newCv;
        existing.invested = inv + delta;
        mutationsApplied.push({ ticker, deltaRupees: delta, kind: "top-up" });
      }
    } else if (delta > 0) {
      // New position — must come from freshPicks for sector / market cap context.
      const fp = (freshPicks || []).find((p) => p?.ticker === ticker);
      if (!fp) {
        warnings.push(`${ticker}: not in portfolio and not in fresh-picks list — skipped.`);
        continue;
      }
      const newRow = {
        sws: {
          ticker,
          name: fp.name || ticker,
          sector: fp.sector || "Unclassified",
          market_cap_inr: fp.market_cap_inr ?? null,
          snowflake: fp.snowflake ?? null,
          snowflake_total: fp.snowflake_total ?? fp.snowflake?.total ?? null,
          v3_score: fp.v3_score ?? null,
          beta: fp.beta ?? null,
          surveillance: null,
        },
        swsCovered: true,
        currentValue: delta,
        invested: delta,
        action: "Top-up-100%",
        symbol: ticker,
        ticker,
      };
      mutated.push(newRow);
      byTicker.set(ticker, newRow);
      mutationsApplied.push({ ticker, deltaRupees: delta, kind: "fresh-buy" });
    } else {
      warnings.push(`${ticker}: not in portfolio — can't trim.`);
    }
  }

  // ─── Compute scenario metrics ───
  const scenario = _computeMetrics(mutated);

  // ─── Sector mix delta (signed pct points per sector) ───
  const sectorDelta = {};
  const allSectors = new Set([...Object.keys(baseline.sectorMix), ...Object.keys(scenario.sectorMix)]);
  for (const s of allSectors) {
    const before = baseline.sectorMix[s] ?? 0;
    const after = scenario.sectorMix[s] ?? 0;
    const d = +(after - before).toFixed(1);
    if (d !== 0) sectorDelta[s] = d;
  }

  return {
    baseline,
    scenario: { ...scenario, mutationApplied: mutationsApplied.length > 0 },
    deltas: {
      healthScore: +(scenario.healthScore - baseline.healthScore).toFixed(1),
      avgV3: scenario.avgV3 != null && baseline.avgV3 != null
        ? +(scenario.avgV3 - baseline.avgV3).toFixed(1)
        : null,
      weightedBeta: scenario.weightedBeta != null && baseline.weightedBeta != null
        ? +(scenario.weightedBeta - baseline.weightedBeta).toFixed(2)
        : null,
      illiquidPct: +(scenario.illiquidPct - baseline.illiquidPct).toFixed(1),
      totalValue: scenario.totalValue - baseline.totalValue,
      // Two concentration metrics:
      //   • concentrationPct = top-5 sum (broad concentration)
      //   • largestPositionPct = biggest single-name weight
      // Top-5 is insensitive when N≤5 (always 100%); largestPositionPct
      // is the sensitive single-name signal — both surfaced so the UI
      // can display the relevant one based on portfolio shape.
      concentrationPct: +(scenario.concentrationPct - baseline.concentrationPct).toFixed(1),
      largestPositionPct: +(scenario.largestPositionPct - baseline.largestPositionPct).toFixed(1),
      sectorMix: sectorDelta,
    },
    realisedTax: Math.round(realisedTax),
    mutationsApplied,
    warnings,
  };
}
