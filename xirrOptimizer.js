/**
 * XIRR Optimizer — converts a portfolio + holdings analysis into a ranked
 * set of tax-aware moves designed to lift the portfolio's annualised XIRR.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This module is the "what should I do about this depressing XIRR?" layer.
 * Inputs come from portfolioAnalyzer.buildReport (per-holding scores + actions
 * + risk metrics + sector allocation). Output is a structured `optimizer`
 * block consumed by the Analyzer UI.
 *
 *   computePortfolioXirr  — robust XIRR with graceful degradation for missing
 *                           dates and MF back-solve from Groww-published values
 *   identifyDrag          — composite-drag detection (≥2 of 5 conditions)
 *   generateMoves         — EXIT / TRIM / SWITCH candidates for each drag holding
 *   greedySelect          — apply hard constraints + noise-floor + presets
 *   computeProjectedXirr  — what XIRR would the book do if we executed the moves
 *   runXirrOptimizer      — main entrypoint called by buildReport / API endpoint
 *
 * Pure / LLM-free. Deterministic for the same inputs. No I/O.
 */

import { xirr } from "./riskMetrics.js";
import { computeTargetPositionSize } from "./portfolioIntelligence.js";
import {
  computeExitTax,
  inferAssetClass,
  buildFyContext,
  checkElssLockIn,
  TAX_RULES,
  DEFAULT_SLAB_PCT,
} from "./taxEngine.js";
import mfCandidatesData from "./mfCandidates.json" with { type: "json" };

// ──────────────────── Constants ────────────────────

export const PRESETS = {
  conservative: {
    label: "Conservative",
    noiseFloorBps: 50,
    singleStockCapPct: 10,
    sectorCapPct: 25,
    allowFyBudgetBypass: false,
    allowElssExitWhenLockExpired: false,
    onlyNegativePnl: false,
    targetUpliftBps: 250,
  },
  balanced: {
    label: "Balanced",
    noiseFloorBps: 25,
    singleStockCapPct: 10,
    sectorCapPct: 25,
    allowFyBudgetBypass: false,
    allowElssExitWhenLockExpired: true,
    onlyNegativePnl: false,
    targetUpliftBps: 400,
  },
  aggressive: {
    label: "Aggressive",
    noiseFloorBps: 10,
    singleStockCapPct: 12,
    sectorCapPct: 28,
    allowFyBudgetBypass: true,
    allowElssExitWhenLockExpired: true,
    onlyNegativePnl: false,
    targetUpliftBps: 600,
  },
  "tax-loss-harvest": {
    label: "Tax-loss harvest",
    noiseFloorBps: 0,
    singleStockCapPct: 10,
    sectorCapPct: 25,
    allowFyBudgetBypass: false,
    allowElssExitWhenLockExpired: true,
    onlyNegativePnl: true,
    targetUpliftBps: 9999, // effectively unbounded — surface every loss-harvest candidate
  },
  "lock-in-aware": {
    label: "Lock-in aware",
    noiseFloorBps: 25,
    singleStockCapPct: 10,
    sectorCapPct: 25,
    allowFyBudgetBypass: false,
    allowElssExitWhenLockExpired: true,
    onlyNegativePnl: false,
    targetUpliftBps: 400,
    filterRemainingLockMonths: 6,
  },
};

// Score-tier ladder (per user choice) — anchored to last 5y category benchmark CAGRs.
// Used as the "what would redeployed cash earn" proxy in uplift estimates.
export const RETURN_LADDER = {
  // Decile thresholds → expected forward annualised return as a decimal (1.0 = 100%)
  stocks: [
    { minScore: 90, ret: 0.18 }, // top 10%
    { minScore: 70, ret: 0.14 },
    { minScore: 40, ret: 0.11 },
    { minScore: 20, ret: 0.08 },
    { minScore: 0,  ret: 0.05 }, // bottom 20%
  ],
  equity_mf: [
    { minScore: 90, ret: 0.16 },
    { minScore: 70, ret: 0.13 },
    { minScore: 40, ret: 0.11 },
    { minScore: 20, ret: 0.08 },
    { minScore: 0,  ret: 0.06 },
  ],
  debt_mf: [
    { minScore: 90, ret: 0.08 },
    { minScore: 70, ret: 0.075 },
    { minScore: 40, ret: 0.07 },
    { minScore: 20, ret: 0.065 },
    { minScore: 0,  ret: 0.06 },
  ],
};

export const SEBI_COMPLIANCE_COPY = {
  tooltip: "Optimization is analytical, not advisory. Moves shown are mathematically-derived candidates for review with your IA/RA. Tax estimates use current law and may not reflect your full circumstances.",
  moveActionVerbs: {
    EXIT: "Candidate exit",
    TRIM: "Candidate trim",
    SWITCH: "Candidate switch",
    ADD: "Candidate add",
    CONSOLIDATE: "Candidate consolidate",
  },
};

const DEFAULT_ASSUMED_HOLDING_MONTHS = 24;
const NOISE_FLOOR_DEFAULT_BPS = 25;

// ──────────────────── Helpers ────────────────────

function todayIso(today) {
  const d = today ? new Date(today) : new Date();
  return d.toISOString().slice(0, 10);
}

function shiftMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function returnLadderLookup(scoreOrPercentile, assetKind) {
  const ladder = RETURN_LADDER[assetKind] || RETURN_LADDER.stocks;
  for (const tier of ladder) {
    if (scoreOrPercentile >= tier.minScore) return tier.ret;
  }
  return ladder[ladder.length - 1].ret;
}

// Map mfHolding.category text → mfCandidates.json key
function mfCategoryKey(holding) {
  const cat = String(holding.category || "").toLowerCase();
  const sub = String(holding.subCategory || "").toLowerCase();
  const name = String(holding.name || holding.rawName || "").toLowerCase();
  const blob = `${cat} ${sub} ${name}`;
  if (/elss|tax\s*saver/.test(blob)) return "elss";
  if (/large.*cap|bluechip/.test(blob)) return "large_cap";
  if (/flexi.*cap|multi.*cap/.test(blob)) return "flexi_cap";
  if (/small.*cap/.test(blob)) return "small_cap";
  if (/mid.*cap/.test(blob)) return "mid_cap";
  if (/aggressive.*hybrid|equity.*debt|hybrid.*equity/.test(blob)) return "hybrid_aggressive";
  if (/conservative.*hybrid|hybrid.*debt|regular.*savings/.test(blob)) return "hybrid_conservative";
  if (/liquid/.test(blob)) return "liquid";
  if (/short.*duration|short.*term.*debt/.test(blob)) return "short_duration";
  if (/corporate.*bond|corp.*bond/.test(blob)) return "corporate_bond";
  if (/index|nifty\s*50/.test(blob)) return "index_nifty50";
  return null;
}

function getMfCandidates(holding) {
  const key = mfCategoryKey(holding);
  if (!key) return [];
  const list = mfCandidatesData?.categories?.[key] || [];
  return list.map((c) => ({ ...c, _categoryKey: key }));
}

// ──────────────────── 1. Portfolio XIRR (graceful) ────────────────────

/**
 * Build a robust portfolio XIRR. Handles the two real-world data gaps:
 *   (a) Missing purchase dates → assumes purchase at today - assumedHoldingMonths
 *   (b) MF holdings with Groww-published per-scheme XIRR but no SIP txns →
 *       back-solves a synthetic single flow that replicates the published XIRR
 *
 * @param {object} input
 * @param {Array} input.stockHoldings - report holdings (equity / etf)
 * @param {Array} [input.mfHoldings]  - { invested, currentValue, publishedXirrPct?, purchaseDate?, name }
 * @param {string|Date} [input.today]
 * @param {number} [input.assumedHoldingMonths] - default 24
 * @returns {{
 *   xirr: number|null, xirrPct: number|null, confidence: "high"|"medium"|"low",
 *   missingDateCount: number, mfBackSolveCount: number,
 *   assumedHoldingMonths: number, flows: Array
 * }}
 */
export function computePortfolioXirr({ stockHoldings = [], mfHoldings = [], today, assumedHoldingMonths = DEFAULT_ASSUMED_HOLDING_MONTHS }) {
  const flows = [];
  const todayStr = todayIso(today);
  let missingDateCount = 0;
  let mfBackSolveCount = 0;

  let totalCurrent = 0;

  for (const h of stockHoldings) {
    const invested = Number(h.invested);
    const currentValue = Number(h.currentValue ?? h.invested);
    if (!Number.isFinite(invested) || invested <= 0) continue;
    totalCurrent += Number.isFinite(currentValue) ? currentValue : invested;
    let purchaseDate = h.purchaseDate;
    if (!purchaseDate) {
      purchaseDate = shiftMonths(todayStr, -assumedHoldingMonths);
      missingDateCount += 1;
    }
    flows.push({ date: purchaseDate, amount: -invested });
  }

  for (const m of mfHoldings) {
    const invested = Number(m.invested);
    const currentValue = Number(m.currentValue ?? m.invested);
    if (!Number.isFinite(invested) || invested <= 0) continue;
    totalCurrent += Number.isFinite(currentValue) ? currentValue : invested;

    // Prefer Groww-published per-scheme XIRR if we have it. Back-solve a
    // single synthetic flow {date: today - X, amount: -invested} so that
    // (-invested) at that date + (currentValue) today => XIRR matches.
    // For the simple two-flow case, X (years) = ln(currentValue/invested) / ln(1 + r).
    if (Number.isFinite(m.publishedXirrPct) && currentValue > 0) {
      const r = m.publishedXirrPct / 100;
      let yearsBack;
      if (Math.abs(r) < 1e-6) {
        // r = 0 → cash unchanged; need any positive holding window
        yearsBack = assumedHoldingMonths / 12;
      } else if (currentValue <= invested && r > 0) {
        // Inconsistent with positive return claim — fall back to assumed window
        yearsBack = assumedHoldingMonths / 12;
      } else if (currentValue >= invested && r < 0) {
        yearsBack = assumedHoldingMonths / 12;
      } else {
        yearsBack = Math.log(currentValue / invested) / Math.log(1 + r);
        if (!Number.isFinite(yearsBack) || yearsBack <= 0 || yearsBack > 30) {
          yearsBack = assumedHoldingMonths / 12;
        }
      }
      const months = Math.max(1, Math.round(yearsBack * 12));
      const purchaseDate = shiftMonths(todayStr, -months);
      flows.push({ date: purchaseDate, amount: -invested });
      mfBackSolveCount += 1;
    } else {
      // No published XIRR → fall back to assumed window
      const purchaseDate = m.purchaseDate || shiftMonths(todayStr, -assumedHoldingMonths);
      if (!m.purchaseDate) missingDateCount += 1;
      flows.push({ date: purchaseDate, amount: -invested });
    }
  }

  if (flows.length === 0 || totalCurrent <= 0) {
    return {
      xirr: null,
      xirrPct: null,
      confidence: "low",
      missingDateCount,
      mfBackSolveCount,
      assumedHoldingMonths,
      flows,
    };
  }

  flows.push({ date: todayStr, amount: totalCurrent });

  let rate = null;
  try {
    rate = xirr(flows);
  } catch {
    rate = null;
  }

  // Confidence band: high when ≥80% of flows have known dates;
  // medium when MF back-solve dominates; low otherwise.
  const totalFlows = flows.length - 1; // exclude terminal
  const withRealDates = totalFlows - missingDateCount;
  const realDateShare = totalFlows > 0 ? withRealDates / totalFlows : 0;
  const confidence = realDateShare >= 0.8 ? "high"
    : realDateShare >= 0.4 ? "medium"
    : "low";

  return {
    xirr: Number.isFinite(rate) ? rate : null,
    xirrPct: Number.isFinite(rate) ? +(rate * 100).toFixed(2) : null,
    confidence,
    missingDateCount,
    mfBackSolveCount,
    assumedHoldingMonths,
    flows,
  };
}

// ──────────────────── 2. Composite drag detection ────────────────────

/**
 * Identify holdings that are dragging portfolio XIRR by ≥2 of 5 conditions.
 * Single-condition flags are informational; composite is what generates moves.
 *
 * Conditions:
 *   (1) combinedScore in bottom quartile of portfolio
 *   (2) action is CUT_LOSS / SELL / TRIM
 *   (3) pnlPct < -10 AND held > 12 months (laggard, not just drawdown)
 *   (4) sector contribution to portfolio drag > 1% (sector down + position oversized)
 *   (5) For MFs: published XIRR < (category benchmark - 300bps)
 *
 * @param {Array} holdings - report.holdings (post-buildReport stripping)
 * @param {Array} mfHoldings
 * @param {object} sectorMap - { sectorName: { pct, value, momentum? } }
 * @param {string|Date} today
 */
export function identifyDrag({ holdings = [], mfHoldings = [], sectorMap = {}, today }) {
  const drag = [];
  const todayStr = todayIso(today);

  // Compute bottom quartile threshold for combinedScore
  const scores = holdings.map((h) => h.combinedScore).filter((s) => Number.isFinite(s));
  const bottomQuartileThreshold = scores.length >= 4
    ? [...scores].sort((a, b) => a - b)[Math.floor(scores.length * 0.25)]
    : null;

  for (const h of holdings) {
    const reasons = [];
    if (Number.isFinite(h.combinedScore) && bottomQuartileThreshold != null
        && h.combinedScore <= bottomQuartileThreshold) {
      reasons.push({ code: "BOTTOM_QUARTILE_SCORE", detail: `combinedScore ${h.combinedScore} in bottom quartile (≤${bottomQuartileThreshold})` });
    }
    if (["CUT_LOSS", "SELL", "TRIM", "BOOK_PROFIT"].includes(h.action)) {
      reasons.push({ code: "ENGINE_ACTION", detail: `Decision engine: ${h.action}` });
    }
    if (Number.isFinite(h.pnlPercent) && h.pnlPercent < -10) {
      let daysHeld = null;
      if (h.purchaseDate) {
        const ms = new Date(todayStr).getTime() - new Date(h.purchaseDate).getTime();
        daysHeld = Math.floor(ms / (24 * 60 * 60 * 1000));
      }
      if (daysHeld == null || daysHeld > 365) {
        reasons.push({ code: "LAGGARD", detail: `pnlPct ${h.pnlPercent.toFixed(1)}% on a ${daysHeld != null ? `${daysHeld}-day` : "long"} hold` });
      }
    }
    const sector = h.sector;
    const sectorPct = sectorMap[sector]?.pct;
    if (Number.isFinite(sectorPct) && sectorPct > 25 && Number.isFinite(h.pnlPercent) && h.pnlPercent < 0) {
      reasons.push({ code: "SECTOR_OVERWEIGHT_LOSS", detail: `${sector} is ${sectorPct.toFixed(1)}% of portfolio and this position is in loss` });
    }

    if (reasons.length >= 2) {
      drag.push({
        symbol: h.symbol,
        name: h.name,
        kind: "stock",
        ref: h,
        reasons,
      });
    }
  }

  for (const m of mfHoldings) {
    const reasons = [];
    const xirrPct = Number(m.publishedXirrPct);
    if (Number.isFinite(xirrPct) && xirrPct < 8) {
      // Below the long-run equity-MF benchmark by ~400bps+
      reasons.push({ code: "LOW_XIRR", detail: `Published XIRR ${xirrPct.toFixed(2)}% — material category lag` });
    }
    // Compare to category leader if we can map
    const candidates = getMfCandidates(m);
    if (candidates.length > 0) {
      const leader = candidates[0];
      if (Number.isFinite(xirrPct) && Number.isFinite(leader.approxXirr5yPct)
          && (leader.approxXirr5yPct - xirrPct) > 3) {
        reasons.push({ code: "CATEGORY_LAG", detail: `Lags ${leader.name} (5y CAGR ~${leader.approxXirr5yPct}%) by ${(leader.approxXirr5yPct - xirrPct).toFixed(1)}pp` });
      }
    }
    // Returns/PnL-driven
    const pnlPct = Number(m.pnlPercent);
    if (Number.isFinite(pnlPct) && pnlPct < -5) {
      reasons.push({ code: "PNL_LOSS", detail: `Position return ${pnlPct.toFixed(1)}%` });
    }
    if (reasons.length >= 2 || (reasons.length === 1 && reasons[0].code === "CATEGORY_LAG")) {
      // Single-reason for CATEGORY_LAG is enough — a fund persistently lagging
      // its category leader by 300bps+ is the textbook case for SWITCH.
      drag.push({
        symbol: m.isin || m.name,
        name: m.name,
        kind: "mf",
        ref: m,
        reasons,
      });
    }
  }

  return drag;
}

// ──────────────────── 3. Move candidate generation ────────────────────

function expectedForwardReturn(holding, kind) {
  if (kind === "stock") {
    return returnLadderLookup(holding.combinedScore ?? 50, "stocks");
  }
  if (kind === "mf") {
    const assetClass = inferAssetClass(holding);
    if (assetClass === "debt_mf" || assetClass === "hybrid_debt") {
      return returnLadderLookup(50, "debt_mf");
    }
    // For MFs, prefer published XIRR if available (it's the actual track record)
    if (Number.isFinite(holding.publishedXirrPct)) return holding.publishedXirrPct / 100;
    return returnLadderLookup(50, "equity_mf");
  }
  return 0.10;
}

function generateMoves({ dragList, portfolio, fyContext, taxSlabPct, today, options = {} }) {
  const moves = [];
  let moveCounter = 0;

  for (const item of dragList) {
    const { kind, ref } = item;
    const assetClass = kind === "stock" ? "equity" : inferAssetClass(ref);
    const investedRupees = Number(ref.invested) || 0;
    const currentValueRupees = Number(ref.currentValue ?? ref.invested) || 0;
    if (currentValueRupees <= 0) continue;

    // Forward return on the existing capital (what we'd "give up" by exiting)
    const forwardReturnOld = expectedForwardReturn(ref, kind);

    // Asset-class-specific candidate generation
    if (kind === "mf") {
      const candidates = getMfCandidates(ref);
      // Pick top 1-2 by approxXirr5yPct that's strictly better than current's published XIRR
      const currentXirr = Number(ref.publishedXirrPct);
      const targets = candidates
        .filter((c) => !Number.isFinite(currentXirr) || c.approxXirr5yPct - currentXirr > 1.5)
        .slice(0, 2);

      for (const target of targets) {
        moveCounter += 1;
        const taxResult = computeExitTax({
          assetClass,
          investedRupees,
          currentValueRupees,
          exitFractionPct: 100,
          purchaseDate: ref.purchaseDate,
          today,
          fyContext,
          taxSlabPct,
        });
        const netRedeployable = taxResult.netProceedsRupees;
        const forwardReturnNew = (target.approxXirr5yPct || 12) / 100;
        const grossUplift = (forwardReturnNew - forwardReturnOld) * netRedeployable;
        const taxDragAnnualised = taxResult.taxCostRupees / Math.max(1, options.assumedHoldingMonths || DEFAULT_ASSUMED_HOLDING_MONTHS) * 12;
        const netUplift = grossUplift - taxDragAnnualised;
        const portfolioCurrent = portfolio.totalCurrent || 1;
        const netUpliftBps = (netUplift / portfolioCurrent) * 10000;
        const conservativeUpliftBps = ((forwardReturnNew - (portfolio.currentXirr || 0.05)) * netRedeployable / portfolioCurrent) * 10000;

        moves.push({
          id: `mv-${moveCounter}`,
          type: "SWITCH",
          kind: "mf",
          instrument: { name: ref.name, isin: ref.isin || null, kind: "mf", category: ref.category || null },
          rationale: `Composite drag: ${item.reasons.map((r) => r.detail).join("; ")}.`,
          grossProceedsRupees: Math.round(taxResult.grossProceedsRupees),
          taxCostRupees: Math.round(taxResult.taxCostRupees),
          netRedeployableRupees: Math.round(netRedeployable),
          redeployTo: [{
            name: target.name,
            isin: target.isin || null,
            allocPct: 100,
            categoryRank5y: target.categoryRank5y || null,
            approxXirr5yPct: target.approxXirr5yPct || null,
            lockInMonths: target.lockInMonths || 0,
          }],
          estUpliftBps: Math.round(netUpliftBps),
          estUpliftBpsConservative: Math.round(conservativeUpliftBps),
          taxRegime: taxResult.regime,
          lockInBreach: taxResult.lockInBreach,
          lockInUntil: taxResult.lockInUntil || null,
          taxNotes: taxResult.notes,
          dragReasons: item.reasons,
        });
      }

      // Always also offer EXIT-only (without redeploy) for tax-loss harvest preset
      if (Number.isFinite(ref.pnlPercent) && ref.pnlPercent < 0) {
        moveCounter += 1;
        const taxResult = computeExitTax({
          assetClass,
          investedRupees,
          currentValueRupees,
          exitFractionPct: 100,
          purchaseDate: ref.purchaseDate,
          today,
          fyContext,
          taxSlabPct,
        });
        moves.push({
          id: `mv-${moveCounter}`,
          type: "EXIT",
          kind: "mf",
          instrument: { name: ref.name, isin: ref.isin || null, kind: "mf", category: ref.category || null },
          rationale: `Tax-loss harvest opportunity: position is in loss; realising it now lets the loss offset other capital gains this FY.`,
          grossProceedsRupees: Math.round(taxResult.grossProceedsRupees),
          taxCostRupees: 0,
          netRedeployableRupees: Math.round(taxResult.netProceedsRupees),
          redeployTo: [],
          estUpliftBps: 0, // direct uplift via tax savings, not return delta
          estUpliftBpsConservative: 0,
          taxRegime: taxResult.regime,
          lockInBreach: taxResult.lockInBreach,
          lockInUntil: taxResult.lockInUntil || null,
          taxNotes: taxResult.notes,
          dragReasons: item.reasons,
          isLossHarvest: true,
          lossRupees: Math.round(Math.abs(taxResult.gainRupees)),
        });
      }
    } else {
      // Stock candidates: TRIM (to target weight) and EXIT
      const targetSizing = computeTargetPositionSize(ref.combinedScore, ref.positionWeight ?? 0);
      const isOverweight = targetSizing.status === "overweight" || targetSizing.status === "slightly_overweight";

      if (isOverweight) {
        // TRIM down to targetMax * 1.0 (the top of the "appropriate" range)
        const currentWeight = ref.positionWeight ?? 0;
        const targetWeight = targetSizing.targetMax;
        const trimFractionPct = currentWeight > 0
          ? Math.max(0, Math.min(100, ((currentWeight - targetWeight) / currentWeight) * 100))
          : 0;
        if (trimFractionPct > 5) {
          moveCounter += 1;
          const taxResult = computeExitTax({
            assetClass: "equity",
            investedRupees,
            currentValueRupees,
            exitFractionPct: trimFractionPct,
            purchaseDate: ref.purchaseDate,
            today,
            fyContext,
            taxSlabPct,
          });
          const netRedeployable = taxResult.netProceedsRupees;
          // Trimming releases capital — assume redeployed at portfolio top-tier return
          const forwardReturnNew = returnLadderLookup(80, "stocks");
          const grossUplift = (forwardReturnNew - forwardReturnOld) * netRedeployable;
          const taxDragAnnualised = taxResult.taxCostRupees / Math.max(1, options.assumedHoldingMonths || DEFAULT_ASSUMED_HOLDING_MONTHS) * 12;
          const netUplift = grossUplift - taxDragAnnualised;
          const portfolioCurrent = portfolio.totalCurrent || 1;
          const netUpliftBps = (netUplift / portfolioCurrent) * 10000;
          const conservativeUpliftBps = ((forwardReturnNew - (portfolio.currentXirr || 0.05)) * netRedeployable / portfolioCurrent) * 10000;

          moves.push({
            id: `mv-${moveCounter}`,
            type: "TRIM",
            kind: "stock",
            instrument: { symbol: ref.symbol, name: ref.name, sector: ref.sector || null, kind: "stock" },
            rationale: `Composite drag + position is overweight (${currentWeight.toFixed(1)}% vs ${targetSizing.targetRange} target for combinedScore ${ref.combinedScore}).`,
            currentWeightPct: +currentWeight.toFixed(2),
            targetWeightPct: +targetWeight.toFixed(2),
            trimFractionPct: +trimFractionPct.toFixed(1),
            grossProceedsRupees: Math.round(taxResult.grossProceedsRupees),
            taxCostRupees: Math.round(taxResult.taxCostRupees),
            netRedeployableRupees: Math.round(netRedeployable),
            redeployTo: [],
            estUpliftBps: Math.round(netUpliftBps),
            estUpliftBpsConservative: Math.round(conservativeUpliftBps),
            taxRegime: taxResult.regime,
            taxNotes: taxResult.notes,
            dragReasons: item.reasons,
          });
        }
      }

      // EXIT (full liquidation) candidate — always generate; selection layer filters
      moveCounter += 1;
      const exitTaxResult = computeExitTax({
        assetClass: "equity",
        investedRupees,
        currentValueRupees,
        exitFractionPct: 100,
        purchaseDate: ref.purchaseDate,
        today,
        fyContext,
        taxSlabPct,
      });
      const netRedeployable = exitTaxResult.netProceedsRupees;
      const forwardReturnNew = returnLadderLookup(80, "stocks"); // assume top-tier replacement
      const grossUplift = (forwardReturnNew - forwardReturnOld) * netRedeployable;
      const taxDragAnnualised = exitTaxResult.taxCostRupees / Math.max(1, options.assumedHoldingMonths || DEFAULT_ASSUMED_HOLDING_MONTHS) * 12;
      const netUplift = grossUplift - taxDragAnnualised;
      const portfolioCurrent = portfolio.totalCurrent || 1;
      const netUpliftBps = (netUplift / portfolioCurrent) * 10000;
      const conservativeUpliftBps = ((forwardReturnNew - (portfolio.currentXirr || 0.05)) * netRedeployable / portfolioCurrent) * 10000;

      moves.push({
        id: `mv-${moveCounter}`,
        type: ref.action === "CUT_LOSS" ? "EXIT" : (Number.isFinite(ref.pnlPercent) && ref.pnlPercent < 0 ? "EXIT" : "EXIT"),
        kind: "stock",
        instrument: { symbol: ref.symbol, name: ref.name, sector: ref.sector || null, kind: "stock" },
        rationale: `Composite drag: ${item.reasons.map((r) => r.detail).join("; ")}.`,
        grossProceedsRupees: Math.round(exitTaxResult.grossProceedsRupees),
        taxCostRupees: Math.round(exitTaxResult.taxCostRupees),
        netRedeployableRupees: Math.round(netRedeployable),
        redeployTo: [], // stock-level redeploy targets need scanner integration — Phase 2
        redeployNote: "Redeploy candidate requires running a scanner — see Discover tab for current top-decile picks in this sector.",
        estUpliftBps: Math.round(netUpliftBps),
        estUpliftBpsConservative: Math.round(conservativeUpliftBps),
        taxRegime: exitTaxResult.regime,
        taxNotes: exitTaxResult.notes,
        dragReasons: item.reasons,
        isLossHarvest: Number.isFinite(ref.pnlPercent) && ref.pnlPercent < 0,
        lossRupees: Number.isFinite(exitTaxResult.gainRupees) && exitTaxResult.gainRupees < 0
          ? Math.round(Math.abs(exitTaxResult.gainRupees)) : 0,
      });
    }
  }

  return moves;
}

// ──────────────────── 4. Greedy selection with constraints ────────────────────

function greedySelect({ moves, portfolio, preset, fyContext }) {
  const selected = [];
  const blocked = [];
  const constraintsBinding = [];

  // Track running sector / single-stock weights
  const sectorWeights = { ...portfolio.sectorWeightsPct };
  const symbolWeights = new Map(
    portfolio.holdings.map((h) => [h.symbol || h.name, h.positionWeight ?? 0]),
  );

  // Track FY LTCG budget consumption
  let fyLtcgUsed = 0;
  const fyBudget = fyContext?.ltcgBudgetRemainingRupees ?? TAX_RULES.LTCG_EQUITY_EXEMPTION_RUPEES;

  // Sort by netUpliftBps descending (greedy)
  const sorted = [...moves].sort((a, b) => (b.estUpliftBps || 0) - (a.estUpliftBps || 0));

  for (const move of sorted) {
    // Lock-in gate
    if (move.lockInBreach) {
      if (!preset.allowElssExitWhenLockExpired || move.lockInUntil) {
        blocked.push({ ...move, blockedReason: `Lock-in not expired — until ${move.lockInUntil}` });
        constraintsBinding.push({
          type: "ELSS_LOCK_IN",
          instrument: move.instrument.name,
          until: move.lockInUntil,
        });
        continue;
      }
    }

    // Lock-in remaining filter (lock-in-aware preset)
    if (preset.filterRemainingLockMonths != null && move.kind === "mf") {
      // We don't have remainingLockMonths on the move; conservative pass-through
      // for now (can be added when MF parser provides remainingLockMonths field)
    }

    // Tax-loss-harvest preset only accepts moves where the underlying position has loss
    if (preset.onlyNegativePnl && !move.isLossHarvest) continue;

    // Noise floor (skip for tax-loss harvest where uplift is from carry-forward)
    if (!move.isLossHarvest && (move.estUpliftBps || 0) < preset.noiseFloorBps) continue;

    // FY LTCG budget check (equity LTCG only)
    if (move.taxRegime === "ltcg") {
      // Estimated exemption use — included in taxNotes but not directly summable
      // here. Use the (gross gain, capped) as a quick approximation.
      const estGain = (move.grossProceedsRupees || 0) - ((move.grossProceedsRupees || 0) - (move.netRedeployableRupees || 0)) - (move.taxCostRupees || 0);
      // (rough — actual exemptionUsed is computed in computeExitTax notes)
      const estExemptionUsed = Math.min(Math.max(0, estGain), Math.max(0, fyBudget - fyLtcgUsed));
      fyLtcgUsed += estExemptionUsed;
      if (fyLtcgUsed > fyBudget && !preset.allowFyBudgetBypass) {
        // Suggest FY split — flag and continue
        constraintsBinding.push({
          type: "FY_LTCG_BUDGET",
          remaining: Math.max(0, fyBudget - fyLtcgUsed),
          fyEndsOn: fyContext?.fyEndsOn,
        });
        // Don't reject — the optimizer suggests the move + flags FY split need
      }
    }

    // Sector / single-stock cap checks (only for stock SWITCH/ADD moves;
    // EXIT moves only release weight, never breach caps)
    if ((move.type === "ADD" || move.type === "SWITCH") && move.kind === "stock") {
      const sym = move.instrument.symbol;
      const currentSym = symbolWeights.get(sym) || 0;
      // Estimate increment as the % of portfolioCurrent the move adds
      const portfolioCurrent = portfolio.totalCurrent || 1;
      const incrementPct = ((move.netRedeployableRupees || 0) / portfolioCurrent) * 100;
      if (currentSym + incrementPct > preset.singleStockCapPct) {
        blocked.push({ ...move, blockedReason: `Single-stock cap (${preset.singleStockCapPct}%) breach.` });
        continue;
      }
      const sec = move.instrument.sector;
      if (sec && (sectorWeights[sec] || 0) + incrementPct > preset.sectorCapPct) {
        blocked.push({ ...move, blockedReason: `Sector cap (${preset.sectorCapPct}%) breach for ${sec}.` });
        continue;
      }
      symbolWeights.set(sym, currentSym + incrementPct);
      if (sec) sectorWeights[sec] = (sectorWeights[sec] || 0) + incrementPct;
    }

    selected.push(move);

    // Stop early if we've hit the cumulative uplift target
    const cumulativeUpliftBps = selected.reduce((s, m) => s + (m.estUpliftBps || 0), 0);
    if (cumulativeUpliftBps >= preset.targetUpliftBps) break;
  }

  return { selected, blocked, constraintsBinding };
}

// ──────────────────── 5. Projected XIRR after moves ────────────────────

function computeProjectedXirr({ portfolio, moves, returnLadderKind = "stocks" }) {
  const portfolioCurrent = portfolio.totalCurrent || 1;
  const currentXirr = portfolio.currentXirr || 0;
  // Each accepted move shifts a slice of capital from forwardReturnOld → forwardReturnNew,
  // net of tax cost amortised over assumedHoldingMonths.
  // Sum the bps uplifts and add to current XIRR.
  const totalNetUpliftBps = moves.reduce((s, m) => s + (m.estUpliftBps || 0), 0);
  const projectedXirr = currentXirr + totalNetUpliftBps / 10000;
  return {
    projectedXirr,
    projectedXirrPct: +(projectedXirr * 100).toFixed(2),
    upliftBps: Math.round(totalNetUpliftBps),
  };
}

function computeProjectedXirrConservative({ portfolio, moves }) {
  const totalConservativeBps = moves.reduce((s, m) => s + (m.estUpliftBpsConservative || 0), 0);
  const currentXirr = portfolio.currentXirr || 0;
  const projectedXirr = currentXirr + totalConservativeBps / 10000;
  return {
    projectedXirr,
    projectedXirrPct: +(projectedXirr * 100).toFixed(2),
    upliftBps: Math.round(totalConservativeBps),
  };
}

// ──────────────────── 6. Main entrypoint ────────────────────

/**
 * Run the XIRR optimizer for a portfolio analysis report.
 *
 * @param {object} input
 * @param {Array} input.holdings - report.holdings (post stripInternal)
 * @param {Array} input.unmatched - rows the parser skipped (we use this to detect MFs)
 * @param {object} [input.mfReport] - { holdings: [...] } if the caller has a parsed MF report
 * @param {Array} [input.sectorAllocation] - report.sectorAllocation
 * @param {string} [input.preset] - preset key, default "balanced"
 * @param {number} [input.taxSlabPct] - default 30
 * @param {number} [input.assumedHoldingMonths] - default 24
 * @param {number} [input.ltcgRealisedYtdRupees] - LTCG already booked this FY (default 0)
 * @param {string|Date} [input.today]
 * @returns {object} the `optimizer` block to attach to report
 */
export function runXirrOptimizer({
  holdings = [],
  unmatched = [],
  mfHoldings = [],
  sectorAllocation = [],
  preset: presetKey = "balanced",
  taxSlabPct = DEFAULT_SLAB_PCT,
  assumedHoldingMonths = DEFAULT_ASSUMED_HOLDING_MONTHS,
  ltcgRealisedYtdRupees = 0,
  stcgRealisedYtdRupees = 0,
  today,
}) {
  const preset = PRESETS[presetKey] || PRESETS.balanced;
  const fyContext = buildFyContext(today, ltcgRealisedYtdRupees, stcgRealisedYtdRupees);

  // Compute robust portfolio XIRR
  const xirrResult = computePortfolioXirr({
    stockHoldings: holdings,
    mfHoldings,
    today,
    assumedHoldingMonths,
  });

  const totalCurrent = holdings.reduce((s, h) => s + (Number(h.currentValue) || Number(h.invested) || 0), 0)
    + mfHoldings.reduce((s, m) => s + (Number(m.currentValue) || Number(m.invested) || 0), 0);

  // Build sector map for drag detection + cap checks
  const sectorMap = {};
  const sectorWeightsPct = {};
  for (const s of sectorAllocation) {
    sectorMap[s.sector] = { pct: s.pct, value: s.value };
    sectorWeightsPct[s.sector] = s.pct;
  }

  const portfolio = {
    totalCurrent,
    currentXirr: xirrResult.xirr,
    holdings,
    sectorWeightsPct,
  };

  // Drag detection
  const dragList = identifyDrag({
    holdings,
    mfHoldings,
    sectorMap,
    today,
  });

  // Move generation
  const allMoves = generateMoves({
    dragList,
    portfolio,
    fyContext,
    taxSlabPct,
    today,
    options: { assumedHoldingMonths },
  });

  // Greedy selection
  const { selected, blocked, constraintsBinding } = greedySelect({
    moves: allMoves,
    portfolio,
    preset,
    fyContext,
  });

  const projection = computeProjectedXirr({ portfolio, moves: selected });
  const projectionConservative = computeProjectedXirrConservative({ portfolio, moves: selected });

  // Deduplicate constraints
  const dedupedConstraints = [];
  const seen = new Set();
  for (const c of constraintsBinding) {
    const key = `${c.type}:${c.instrument || c.fyEndsOn}`;
    if (!seen.has(key)) { seen.add(key); dedupedConstraints.push(c); }
  }

  return {
    currentXirr: xirrResult.xirr,
    currentXirrPct: xirrResult.xirrPct,
    currentXirrConfidence: xirrResult.confidence,
    currentXirrAssumptions: {
      missingDateCount: xirrResult.missingDateCount,
      mfBackSolveCount: xirrResult.mfBackSolveCount,
      assumedHoldingMonths,
    },
    preset: presetKey,
    presetLabel: preset.label,
    taxSlabPct,
    projectedXirr: projection.projectedXirr,
    projectedXirrPct: projection.projectedXirrPct,
    projectedXirrConservative: projectionConservative.projectedXirr,
    projectedXirrConservativePct: projectionConservative.projectedXirrPct,
    projectedUpliftBps: projection.upliftBps,
    projectedUpliftBpsConservative: projectionConservative.upliftBps,
    moves: selected,
    blockedMoves: blocked,
    candidateMoveCount: allMoves.length,
    constraintsBinding: dedupedConstraints,
    fyContext: {
      currentFy: fyContext.currentFy,
      ltcgBudgetRemainingRupees: fyContext.ltcgBudgetRemainingRupees,
      fyEndsOn: fyContext.fyEndsOn,
      stcgYtdRupees: fyContext.stcgYtdRupees,
    },
    assumptions: [
      `Forward returns use a score-tier ladder anchored to 5y category benchmarks; conservative band shown alongside.`,
      `Tax computed at LTCG 12.5% over ₹1.25L exempt / STCG 20% (Budget 2024); debt instruments at ${taxSlabPct}% slab (Finance Act 2023).`,
      xirrResult.mfBackSolveCount > 0
        ? `${xirrResult.mfBackSolveCount} MF holding(s) used Groww-published XIRR back-solved to a synthetic single flow.`
        : null,
      xirrResult.missingDateCount > 0
        ? `${xirrResult.missingDateCount} holding(s) had no purchase date — assumed ${assumedHoldingMonths}-month holding period.`
        : null,
    ].filter(Boolean),
    sebiCompliance: SEBI_COMPLIANCE_COPY.tooltip,
  };
}
