/**
 * Portfolio Analyzer — Phase 5.
 *
 * Wraps the production `portfolioIntelligence.js` decision engine with
 * the report-grade detail a SEBI-practitioner view needs: structured
 * red-flag extraction, multi-horizon outlook narratives, exit-plan
 * levels, tax notes, and per-holding catalyst info.
 *
 * This module is deliberately LLM-free. Every narrative is a
 * deterministic function of the inputs, so running the analyzer on the
 * same portfolio twice produces identical output.
 *
 * Design: the server enriches each holding with a live quote + technical
 * analysis + fundamentals + macro delta, then passes the bundle to
 * `analyzeHolding()`. Aggregation is in `buildReport()`.
 */

import { computeAction, computePortfolioCombinedScore } from "./portfolioIntelligence.js";
import {
  dailyReturns,
  computeBeta,
  maxDrawdown,
  historicalVaR,
  annualizedVolatility,
  sharpeRatio,
  portfolioReturnSeries,
  correlationMatrix,
  averagePairwiseCorrelation,
  stressScenario,
} from "./riskMetrics.js";

// ──────────────────── Red flags (structured) ────────────────────

function extractRedFlags({ fundamentals, analysis, quote, midTerm, positionWeight, earningsNearby }) {
  const flags = [];

  // Fundamentals-based
  if (fundamentals?.debtToEquity != null && fundamentals.debtToEquity > 2) {
    flags.push({
      severity: "high",
      category: "fundamentals",
      message: `Debt/Equity = ${fundamentals.debtToEquity.toFixed(2)} — high leverage; earnings are sensitive to the rate cycle and a credit shock could be fatal.`,
    });
  }
  if (fundamentals?.roe != null && fundamentals.roe < 0.10) {
    flags.push({
      severity: "medium",
      category: "fundamentals",
      message: `ROE = ${(fundamentals.roe * 100).toFixed(1)}% — below the 10% quality threshold. Capital isn't compounding at a rate that justifies equity risk.`,
    });
  }
  if (fundamentals?.profitMargin != null && fundamentals.profitMargin < 0) {
    flags.push({
      severity: "high",
      category: "fundamentals",
      message: `Negative profit margin — the business is currently lossmaking.`,
    });
  }
  if (fundamentals?.revenueGrowth != null && fundamentals.revenueGrowth < 0) {
    flags.push({
      severity: "medium",
      category: "fundamentals",
      message: `Revenue YoY growth = ${(fundamentals.revenueGrowth * 100).toFixed(1)}% — top line is shrinking, not just margins compressing.`,
    });
  }
  if (fundamentals?.pe != null && fundamentals?.sectorPe != null &&
      fundamentals.pe > 0 && fundamentals.sectorPe > 0 &&
      fundamentals.pe > fundamentals.sectorPe * 2) {
    flags.push({
      severity: "medium",
      category: "valuation",
      message: `P/E ${fundamentals.pe.toFixed(1)} is over 2× sector median (${fundamentals.sectorPe.toFixed(1)}) — priced for perfection, small misses punished hard.`,
    });
  }

  // Technical-based
  const trend = analysis?.indicators?.trend;
  if (trend?.strength === "strong_bearish") {
    flags.push({
      severity: "high",
      category: "technical",
      message: `Long-term trend = Strong Downtrend — price is below every major moving average. Being contrarian here requires a very specific catalyst.`,
    });
  }
  if (quote && quote.fiftyTwoWeekHigh && quote.fiftyTwoWeekLow && quote.regularMarketPrice) {
    const posInRange = (quote.regularMarketPrice - quote.fiftyTwoWeekLow) /
      (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow);
    if (posInRange >= 0.95) {
      flags.push({
        severity: "medium",
        category: "technical",
        message: `Price at or above 95% of 52-week range — late-cycle euphoria risk. Adding here pays the highest prices the stock has ever seen.`,
      });
    }
    if (posInRange <= 0.05) {
      flags.push({
        severity: "medium",
        category: "technical",
        message: `Price at or below 5% of 52-week range — could be a bottom OR a falling knife. Confirm with at least one reversal signal before adding.`,
      });
    }
  }
  if (midTerm?.slConfirmed) {
    flags.push({
      severity: "high",
      category: "exit-trigger",
      message: `Stop-loss CONFIRMED — 2 consecutive daily closes below the SL level. The position management rule says exit now.`,
    });
  }

  // Position-level
  if (positionWeight != null && positionWeight > 15) {
    flags.push({
      severity: "medium",
      category: "position",
      message: `Position is ${positionWeight.toFixed(1)}% of portfolio — concentration risk. If this one stock has a bad day, your whole portfolio feels it.`,
    });
  }

  // Catalyst
  if (earningsNearby) {
    flags.push({
      severity: "medium",
      category: "event",
      message: `Earnings scheduled ${earningsNearby.date} — gap risk. ATR-based stops can't defend against an earnings-day gap move.`,
    });
  }

  return flags;
}

// ──────────────────── Multi-horizon outlook ────────────────────

function buildOutlook({ analysis, midTerm, fundamentals, longTerm, macroDelta }) {
  const techScore = analysis?.score ?? null;
  const macroTilt = Number.isFinite(macroDelta) ? macroDelta : 0;

  // Short-term (1-3 months) — dominated by technicals + macro
  let shortDir = "neutral";
  let shortConf = "low";
  if (techScore != null) {
    const adj = techScore + macroTilt * 0.7;
    if (adj >= 70) { shortDir = "up"; shortConf = "medium"; }
    else if (adj >= 60) { shortDir = "up"; shortConf = "low"; }
    else if (adj <= 30) { shortDir = "down"; shortConf = "medium"; }
    else if (adj <= 40) { shortDir = "down"; shortConf = "low"; }
  }

  // Mid-term (3-6 months) — blend technical + midTerm + trend
  let midDir = "neutral";
  let midConf = "low";
  if (midTerm?.score != null) {
    if (midTerm.score >= 65) { midDir = "up"; midConf = "medium"; }
    else if (midTerm.score >= 55) { midDir = "up"; midConf = "low"; }
    else if (midTerm.score <= 35) { midDir = "down"; midConf = "medium"; }
    else if (midTerm.score <= 45) { midDir = "down"; midConf = "low"; }
  }

  // Long-term (6-12 months) — dominated by fundamentals + structural trend
  let longDir = "neutral";
  let longConf = "low";
  if (longTerm?.score != null) {
    if (longTerm.score >= 70) { longDir = "up"; longConf = "high"; }
    else if (longTerm.score >= 60) { longDir = "up"; longConf = "medium"; }
    else if (longTerm.score <= 35) { longDir = "down"; longConf = "medium"; }
    else if (longTerm.score <= 45) { longDir = "down"; longConf = "low"; }
  } else if (fundamentals?.verdict) {
    if (fundamentals.verdict === "DEEP_VALUE" || fundamentals.verdict === "QUALITY_GROWTH") {
      longDir = "up";
      longConf = "medium";
    } else if (fundamentals.verdict === "OVERVALUED") {
      longDir = "down";
      longConf = "medium";
    }
  }

  return {
    shortTerm: { horizon: "1-3 months", direction: shortDir, confidence: shortConf },
    midTerm:   { horizon: "3-6 months", direction: midDir,   confidence: midConf },
    longTerm:  { horizon: "6-12 months", direction: longDir, confidence: longConf },
  };
}

// ──────────────────── Exit plan ────────────────────

function buildExitPlan({ midTerm, longTerm, quote, analysis, avgPrice }) {
  const plan = {
    stopLoss: null,
    slConfirmationRule: null,
    target: null,
    trailingStop: null,
    atrPct: null,
    rationale: [],
  };

  if (!quote?.regularMarketPrice) return plan;

  // SL + target from the mid-term engine (ATR-based)
  if (midTerm?.stopLoss != null) {
    plan.stopLoss = midTerm.stopLoss;
    plan.slConfirmationRule = "Exit on 2 consecutive daily closes below this level (wick-below doesn't count).";
    plan.rationale.push(`Mid-term stop-loss: ${midTerm.stopLoss} = 3× ATR below current.`);
  }
  if (midTerm?.target != null) {
    plan.target = midTerm.target;
    plan.rationale.push(`Mid-term target: ${midTerm.target} = 7× ATR above current.`);
  }
  if (midTerm?.volatilityPct != null) plan.atrPct = midTerm.volatilityPct;

  if (midTerm?.trailingStop) {
    plan.trailingStop = {
      activated: midTerm.trailingStop.activated ?? false,
      activationLevel: midTerm.trailingStop.activationThreshold ?? null,
      currentLevel: midTerm.trailingStop.currentLevel ?? null,
      rule: midTerm.trailingStop.rule,
    };
    if (midTerm.trailingStop.activated) {
      plan.rationale.push(`Trailing stop ACTIVE at ${midTerm.trailingStop.currentLevel}. Move it up as price climbs; exit on daily close below.`);
    } else if (midTerm.trailingStop.activationThreshold) {
      plan.rationale.push(`Trailing stop engages after close above ${midTerm.trailingStop.activationThreshold} (entry + 2× ATR). Until then, fixed SL is in force.`);
    }
  }

  // Long-term structural SL if we have it (tighter of ATR-based and structural)
  if (longTerm?.stopLoss && (!plan.stopLoss || longTerm.stopLoss > plan.stopLoss)) {
    plan.rationale.push(`Structural long-term SL: ${longTerm.stopLoss} (max of 200-DMA / 52W low / −20% floor). Higher than ATR SL, so using structural.`);
    plan.stopLoss = longTerm.stopLoss;
  }

  // Long-term valuation target
  if (longTerm?.target) {
    plan.rationale.push(`Long-term valuation target: ${longTerm.target} (${longTerm.valuationBasis}).`);
    plan.longTermTarget = longTerm.target;
  }

  // Cost-basis context: is SL above or below entry price?
  if (plan.stopLoss && avgPrice) {
    if (plan.stopLoss < avgPrice) {
      plan.rationale.push(`SL is BELOW your avg price of ${avgPrice} — you'd exit at a loss of ${(((plan.stopLoss - avgPrice) / avgPrice) * 100).toFixed(1)}% if triggered today.`);
    } else {
      plan.rationale.push(`SL is ABOVE your avg price of ${avgPrice} — position has already rallied enough that the SL protects a locked-in gain.`);
    }
  }

  return plan;
}

// ──────────────────── Tax note (heuristic) ────────────────────

function buildTaxNote({ pnlAmount, purchaseDate }) {
  // Two modes:
  //   (a) purchaseDate present → we can tell LT vs ST precisely and
  //       even estimate how many days until the LTCG switchover
  //   (b) purchaseDate missing → conditional reminder (upload statements
  //       from Groww don't carry purchase dates)
  if (pnlAmount == null) return null;

  let daysHeld = null;
  let daysToLT = null;
  if (purchaseDate) {
    const pd = new Date(purchaseDate);
    if (!Number.isNaN(pd.getTime())) {
      const ms = Date.now() - pd.getTime();
      daysHeld = Math.floor(ms / (24 * 60 * 60 * 1000));
      daysToLT = daysHeld >= 365 ? 0 : 365 - daysHeld;
    }
  }

  if (pnlAmount <= 0) {
    const base = {
      summary: "Position is in loss — selling now realises a capital loss (short-term or long-term depending on holding period).",
      detail: "STCG losses can offset STCG gains only. LTCG losses can offset LTCG gains only. Unabsorbed losses carry forward 8 years.",
    };
    if (daysHeld != null) {
      base.holdingPeriod = `${daysHeld} days held — ${daysHeld >= 365 ? "long-term" : "short-term"} as of today.`;
    }
    return base;
  }

  // Gains path
  if (daysHeld != null) {
    if (daysHeld < 365) {
      return {
        summary: `Short-term holding (${daysHeld}/365 days) — exit today = 20% STCG on the full gain (Budget 2024 rate). LTCG ≥12 months would be 12.5% over ₹1.25L/year exempt.`,
        detail: daysToLT <= 45
          ? `Only ${daysToLT} days to LTCG — waiting could save ~7.5 percentage points of tax on the gain. Weigh that against market risk over the next ${daysToLT} days.`
          : `${daysToLT} more days until the position qualifies for LTCG. Unless there's a thesis-breaking signal, the tax-efficient exit is after day 365.`,
        holdingPeriod: `${daysHeld} days held — short-term.`,
      };
    }
    return {
      summary: `Long-term holding (${daysHeld} days, ${(daysHeld / 365).toFixed(1)} years) — gains taxed at 12.5% LTCG over ₹1.25L/year exempt.`,
      detail: "You're past the 12-month gate — no short-term tax penalty from exiting now. The ₹1.25L LTCG exemption resets each financial year, so splitting a large exit across 31-Mar can double the exemption.",
      holdingPeriod: `${daysHeld} days held — long-term.`,
    };
  }

  return {
    summary: "Position is in gain — tax treatment depends on holding period. Short-term (<12 months): 20% STCG (Budget 2024 rate). Long-term (≥12 months): 12.5% LTCG on gains over ₹1.25L/year exempt.",
    detail: "Your upload didn't include purchase dates — if you've held over 12 months, LTCG is significantly cheaper. A Zerodha 'Tradebook' or a Groww 'Transactions' export would let us compute this exactly.",
  };
}

// ──────────────────── Per-holding analysis ────────────────────

/**
 * Build the full report object for a single holding.
 * @param {object} input — see server wiring for shape
 * @returns {object} reportEntry
 */
export function analyzeHolding(input) {
  const {
    symbol, name, sector, isin, quantity, avgPrice,
    quote, analysis, fundamentals, midTerm, longTerm,
    macroInfo, earningsNearby, positionWeight, sectorWeight, rawName, matchType,
    historical, benchReturns, purchaseDate,
  } = input;

  const price = quote?.regularMarketPrice ?? null;
  const invested = avgPrice * quantity;
  const currentValue = price != null ? price * quantity : null;
  const pnlAmount = currentValue != null ? currentValue - invested : null;
  const pnlPercent = currentValue != null && invested > 0
    ? (pnlAmount / invested) * 100
    : null;

  const techScore = analysis?.score ?? null;
  const fundScore = fundamentals?.score ?? null;
  const fundVerdict = fundamentals?.verdict ?? null;
  const macroDelta = macroInfo?.delta ?? 0;
  const combinedScore = computePortfolioCombinedScore(techScore, fundScore, macroDelta);

  const action = computeAction(
    { symbol, name, pnlPercent: pnlPercent ?? 0, investedValue: invested, currentValue: currentValue ?? invested, sector },
    { combinedScore, technicalScore: techScore, fundamentalScore: fundScore, fundamentalVerdict: fundVerdict },
    {
      positionWeight,
      sectorWeight,
      hasLiveData: price != null,
      macroInfo: (macroInfo && Math.abs(macroInfo.impact || 0) >= 2 && (macroInfo.severity || 0) >= 3) ? macroInfo : null,
    },
  );

  const redFlags = extractRedFlags({
    fundamentals: fundamentals?.snapshot ?? null,
    analysis, quote, midTerm,
    positionWeight, earningsNearby,
  });

  const outlook = buildOutlook({
    analysis, midTerm, fundamentals, longTerm, macroDelta,
  });

  const exitPlan = buildExitPlan({ midTerm, longTerm, quote, analysis, avgPrice });

  const taxNote = buildTaxNote({ pnlAmount, purchaseDate });

  // ── Risk metrics at the holding level ──
  // Compute stock's own daily returns once — feeds beta + vol + VaR + max-DD.
  // Stash on the return object so the portfolio aggregator can reuse them
  // without re-fetching historical data.
  const closes = Array.isArray(historical) && historical.length > 0
    ? historical.map((d) => d.close).filter((c) => Number.isFinite(c))
    : [];
  const stockReturns = closes.length >= 2 ? dailyReturns(closes) : [];
  const beta = (stockReturns.length > 0 && Array.isArray(benchReturns) && benchReturns.length > 0)
    ? computeBeta(stockReturns, benchReturns)
    : null;
  const annVol = stockReturns.length >= 30 ? annualizedVolatility(stockReturns) : null;
  const oneYearDD = closes.length >= 30 ? maxDrawdown(closes.slice(-252)) : null;
  const var95 = stockReturns.length >= 30 ? historicalVaR(stockReturns, 0.05) : null;

  const holdingRisk = {
    beta: beta != null ? +beta.toFixed(2) : null,
    annualizedVolatility: annVol != null ? +(annVol * 100).toFixed(1) : null, // as %
    maxDrawdown1y: oneYearDD != null ? +(oneYearDD * 100).toFixed(1) : null,   // as % (negative)
    var95Daily: var95 != null ? +(var95 * 100).toFixed(2) : null,              // as % (negative)
    sampleSize: stockReturns.length,
  };

  return {
    // Identity
    symbol, isin, name, sector,
    rawName, matchType,
    // Position
    quantity, avgPrice,
    currentPrice: price,
    invested,
    currentValue,
    pnlAmount,
    pnlPercent,
    positionWeight,
    // Scoring
    technicalScore: techScore,
    fundamentalScore: fundScore,
    fundamentalVerdict: fundVerdict,
    combinedScore,
    recommendation: analysis?.recommendation ?? null,
    // Action
    action: action.action,
    displayAction: action.displayAction,
    actionColor: action.color,
    actionUrgency: action.urgency,
    actionReasoning: action.reasoning,
    actionFactors: action.factors,
    macroWarning: action.macroWarning ?? null,
    macroTailwind: action.macroTailwind ?? null,
    // Report extras
    outlook,
    redFlags,
    exitPlan,
    taxNote,
    earningsNearby,
    // Risk
    risk: holdingRisk,
    purchaseDate: purchaseDate ?? null,
    // Internal — used by buildReport() for portfolio-level aggregation,
    // not shown in UI
    _stockReturns: stockReturns,
    // Debug
    macroDelta,
  };
}

// ──────────────────── Portfolio-level aggregation ────────────────────

function sectorAllocation(holdings) {
  const totals = new Map();
  let total = 0;
  for (const h of holdings) {
    if (h.currentValue == null) continue;
    total += h.currentValue;
    totals.set(h.sector, (totals.get(h.sector) || 0) + h.currentValue);
  }
  const out = [];
  for (const [sector, value] of totals) {
    out.push({ sector, value, pct: total > 0 ? (value / total) * 100 : 0 });
  }
  out.sort((a, b) => b.value - a.value);
  return { sectors: out, total };
}

function verdictMix(holdings) {
  const counts = { DEEP_VALUE: 0, QUALITY_GROWTH: 0, FAIR_VALUE: 0, FULLY_VALUED: 0, OVERVALUED: 0, UNRATED: 0 };
  const value = { DEEP_VALUE: 0, QUALITY_GROWTH: 0, FAIR_VALUE: 0, FULLY_VALUED: 0, OVERVALUED: 0, UNRATED: 0 };
  for (const h of holdings) {
    const v = h.fundamentalVerdict || "UNRATED";
    counts[v] = (counts[v] || 0) + 1;
    value[v] = (value[v] || 0) + (h.currentValue || 0);
  }
  return { counts, value };
}

function portfolioHealthScore(holdings, totalValue, sectors) {
  // Empty-portfolio guard — scoring a zero-holding book gives misleading
  // "good" results from the diversification bonus alone.
  if (!holdings || holdings.length === 0 || totalValue <= 0) {
    return { score: null, components: null };
  }
  // Weighted avg combined score (0-40 pts)
  let scoreSum = 0;
  let scoreWeight = 0;
  for (const h of holdings) {
    if (h.combinedScore == null || h.currentValue == null) continue;
    scoreSum += h.combinedScore * h.currentValue;
    scoreWeight += h.currentValue;
  }
  const avgScore = scoreWeight > 0 ? scoreSum / scoreWeight : 50;
  const scoreBand = Math.max(0, Math.min(40, (avgScore - 40) * 1.33)); // 40→0, 70→40

  // Diversification bonus (0-20 pts). Herfindahl-index-based.
  const n = sectors.length;
  let hhi = 0;
  for (const s of sectors) hhi += Math.pow(s.pct / 100, 2);
  const diversity = Math.max(0, Math.min(20, (1 - hhi) * 25));

  // Concentration penalty (-15 if any stock >20%)
  const maxWeight = Math.max(...holdings.map((h) => h.positionWeight ?? 0));
  const concPenalty = maxWeight > 20 ? -15 : maxWeight > 15 ? -8 : 0;

  // Loss ratio penalty (-10 if >50% of value is in red positions)
  const lossValue = holdings
    .filter((h) => (h.pnlPercent ?? 0) < 0)
    .reduce((s, h) => s + (h.currentValue || 0), 0);
  const lossPct = totalValue > 0 ? lossValue / totalValue * 100 : 0;
  const lossPenalty = lossPct > 50 ? -10 : lossPct > 35 ? -5 : 0;

  // Base 50 + bands
  const raw = 50 + scoreBand + diversity + concPenalty + lossPenalty;
  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    components: {
      avgScore: Math.round(avgScore),
      scoreBand: Math.round(scoreBand),
      diversity: Math.round(diversity),
      concPenalty,
      lossPenalty,
    },
  };
}

function portfolioLevelActions(holdings, sectors, totalValue, verdictSummary) {
  const actions = [];

  // Sector overweight
  for (const s of sectors) {
    if (s.pct > 30) {
      actions.push({
        type: "sector-overweight",
        severity: "high",
        message: `${s.sector} is ${s.pct.toFixed(1)}% of the portfolio — dangerously concentrated. A sector-specific shock would hit the whole book.`,
      });
    } else if (s.pct > 20) {
      actions.push({
        type: "sector-overweight",
        severity: "medium",
        message: `${s.sector} is ${s.pct.toFixed(1)}% — monitor; above 30% becomes problematic.`,
      });
    }
  }

  // Holding count
  if (holdings.length > 30) {
    actions.push({
      type: "over-diversified",
      severity: "medium",
      message: `${holdings.length} holdings is above the retail sweet spot (15-25). Below-conviction names dilute winners. Consider pruning the bottom 5-10 by combined score.`,
    });
  } else if (holdings.length < 8) {
    actions.push({
      type: "under-diversified",
      severity: "medium",
      message: `Only ${holdings.length} holdings — single-stock risk is high. Adding 5-10 more names across uncorrelated sectors improves risk-adjusted return.`,
    });
  }

  // Quality mix — if > 40% is OVERVALUED or FULLY_VALUED by value
  const expensive = (verdictSummary.value.OVERVALUED || 0) + (verdictSummary.value.FULLY_VALUED || 0);
  if (totalValue > 0 && (expensive / totalValue) > 0.4) {
    actions.push({
      type: "quality-mix",
      severity: "medium",
      message: `${((expensive / totalValue) * 100).toFixed(0)}% of portfolio value sits in OVERVALUED / FULLY_VALUED stocks. Rotate into DEEP_VALUE or QUALITY_GROWTH names over the next few quarters.`,
    });
  }

  // Urgent exits
  const cutLossCount = holdings.filter((h) => h.action === "CUT_LOSS").length;
  if (cutLossCount > 0) {
    actions.push({
      type: "urgent-exits",
      severity: "high",
      message: `${cutLossCount} holding(s) flagged CUT_LOSS — the engine says the thesis is broken and capital is better redeployed. Review the per-stock sections for each.`,
    });
  }

  const bookProfitCount = holdings.filter((h) => h.action === "BOOK_PROFIT").length;
  if (bookProfitCount > 0) {
    actions.push({
      type: "book-profit",
      severity: "medium",
      message: `${bookProfitCount} holding(s) flagged BOOK_PROFIT — up >50% and signals are cooling. Consider trimming to lock in gains, leaving a "runner" position.`,
    });
  }

  return actions;
}

// ──────────────────── Portfolio-level risk block ────────────────────

/**
 * Build a portfolio-level risk block from per-holding returns + weights.
 * Produces the numbers every SEBI-grade review expects: weighted beta,
 * annualised portfolio volatility, Sharpe, max-DD over the covered
 * period, 95% daily VaR, and average pairwise correlation.
 *
 * Uses per-holding `_stockReturns` stashed by `analyzeHolding()` so we
 * don't re-process price history here.
 */
function buildRiskBlock(holdings, benchReturns) {
  const totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
  if (totalValue <= 0) return null;

  // Weighted beta (set missing betas to 1 so risk isn't understated)
  let weightedBeta = 0;
  let coveredWeightForBeta = 0;
  let rawBetaCount = 0;
  for (const h of holdings) {
    const w = (h.currentValue || 0) / totalValue;
    const b = Number.isFinite(h.risk?.beta) ? h.risk.beta : null;
    if (b != null) rawBetaCount++;
    weightedBeta += (b != null ? b : 1) * w;
    coveredWeightForBeta += w;
  }

  // Portfolio daily return series
  const returnsList = holdings.map((h) => h._stockReturns || []);
  const weights = holdings.map((h) => (h.currentValue || 0) / totalValue);
  const portReturns = portfolioReturnSeries(returnsList, weights);

  // Portfolio-level stats
  const portVol = portReturns.length >= 30 ? annualizedVolatility(portReturns) : null;
  const portSharpe = portReturns.length >= 30 ? sharpeRatio(portReturns) : null;
  const portVar95 = portReturns.length >= 30 ? historicalVaR(portReturns, 0.05) : null;
  const portVar99 = portReturns.length >= 30 ? historicalVaR(portReturns, 0.01) : null;

  // Reconstruct a pseudo portfolio price series to get max drawdown —
  // compound the daily returns starting from 100.
  let maxDD = null;
  if (portReturns.length >= 30) {
    const synthClose = [100];
    for (const r of portReturns) synthClose.push(synthClose[synthClose.length - 1] * (1 + r));
    maxDD = maxDrawdown(synthClose);
  }

  // Benchmark comparison (the same stats on the benchmark itself, for
  // context — "is the portfolio riskier than the index?")
  const benchVol = Array.isArray(benchReturns) && benchReturns.length >= 30
    ? annualizedVolatility(benchReturns)
    : null;
  const benchSharpe = Array.isArray(benchReturns) && benchReturns.length >= 30
    ? sharpeRatio(benchReturns)
    : null;
  const benchVar95 = Array.isArray(benchReturns) && benchReturns.length >= 30
    ? historicalVaR(benchReturns, 0.05)
    : null;

  // Average pairwise correlation — "how diversified, really?"
  let avgCorr = null;
  const seriesWithData = returnsList.filter((r) => r && r.length >= 30);
  if (seriesWithData.length >= 2) {
    const matrix = correlationMatrix(seriesWithData);
    avgCorr = averagePairwiseCorrelation(matrix);
  }

  return {
    weightedBeta: +weightedBeta.toFixed(2),
    betaCoverage: rawBetaCount,
    betaTotal: holdings.length,
    portfolioVolatilityPct: portVol != null ? +(portVol * 100).toFixed(1) : null,
    portfolioSharpe: portSharpe != null ? +portSharpe.toFixed(2) : null,
    maxDrawdownPct: maxDD != null ? +(maxDD * 100).toFixed(1) : null,
    var95DailyPct: portVar95 != null ? +(portVar95 * 100).toFixed(2) : null,
    var99DailyPct: portVar99 != null ? +(portVar99 * 100).toFixed(2) : null,
    avgCorrelation: avgCorr != null ? +avgCorr.toFixed(2) : null,
    benchVolatilityPct: benchVol != null ? +(benchVol * 100).toFixed(1) : null,
    benchSharpe: benchSharpe != null ? +benchSharpe.toFixed(2) : null,
    benchVar95DailyPct: benchVar95 != null ? +(benchVar95 * 100).toFixed(2) : null,
    sampleDays: portReturns.length,
    interpretation: interpretRisk({ weightedBeta, portVol, benchVol, avgCorr, maxDD }),
  };
}

/**
 * Short human-readable interpretation of the risk block. Single
 * paragraph, plain English, deterministic.
 */
function interpretRisk({ weightedBeta, portVol, benchVol, avgCorr, maxDD }) {
  const parts = [];
  if (Number.isFinite(weightedBeta)) {
    if (weightedBeta > 1.25) {
      parts.push(`Beta ${weightedBeta.toFixed(2)} — portfolio amplifies the Nifty. A 10% index fall implies ~${(weightedBeta * 10).toFixed(0)}% drop here.`);
    } else if (weightedBeta > 1.05) {
      parts.push(`Beta ${weightedBeta.toFixed(2)} — slightly more volatile than the Nifty.`);
    } else if (weightedBeta > 0.9) {
      parts.push(`Beta ${weightedBeta.toFixed(2)} — roughly index-like sensitivity.`);
    } else if (Number.isFinite(weightedBeta)) {
      parts.push(`Beta ${weightedBeta.toFixed(2)} — defensive, moves less than the index.`);
    }
  }
  if (Number.isFinite(portVol) && Number.isFinite(benchVol)) {
    const ratio = portVol / benchVol;
    if (ratio > 1.2) parts.push(`Annualised vol is ${((ratio - 1) * 100).toFixed(0)}% higher than Nifty.`);
    else if (ratio < 0.8) parts.push(`Annualised vol is ${((1 - ratio) * 100).toFixed(0)}% lower than Nifty.`);
  }
  if (Number.isFinite(avgCorr)) {
    if (avgCorr > 0.7) parts.push(`Average pairwise correlation is ${avgCorr.toFixed(2)} — holdings move together; diversification is thin.`);
    else if (avgCorr < 0.3) parts.push(`Average pairwise correlation is ${avgCorr.toFixed(2)} — holdings are genuinely diversified.`);
  }
  if (Number.isFinite(maxDD) && maxDD < -0.2) {
    parts.push(`Back-tested max drawdown over the period was ${(maxDD * 100).toFixed(1)}% — plan for at least this much peak-to-trough pain again.`);
  }
  return parts.join(" ");
}

/**
 * Stress-test block: project portfolio value under 3 Nifty scenarios
 * using per-holding beta. Intentionally simple (linear CAPM) — not a
 * full factor model — but enough to surface tail risk to the user.
 */
function buildStressTests(holdings) {
  // Nothing to stress if there are no equity holdings — caller uses the
  // empty array to skip rendering the card entirely.
  if (!holdings || holdings.length === 0) return [];
  const totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
  if (totalValue <= 0) return [];
  const scenarios = [
    { name: "Mild correction", shock: -0.10, tag: "nifty_minus_10" },
    { name: "Standard crash (2020/2008 magnitude)", shock: -0.20, tag: "nifty_minus_20" },
    { name: "Severe crisis", shock: -0.30, tag: "nifty_minus_30" },
  ];
  const input = holdings.map((h) => ({
    beta: h.risk?.beta ?? null,
    currentValue: h.currentValue || 0,
  }));
  const tests = [];
  for (const s of scenarios) {
    const res = stressScenario(input, s.shock);
    tests.push({
      name: s.name,
      tag: s.tag,
      marketShockPct: s.shock * 100,
      projectedLossPct: +res.projectedLossPct.toFixed(1),
      projectedLossAmount: res.projectedLossAmount,
      coveredValue: res.coveredValue,
    });
  }
  return tests;
}

/**
 * Build the complete portfolio report.
 * @param {object[]} enrichedHoldings - results of analyzeHolding() per stock
 * @param {object[]} unmatched - rows the parser couldn't resolve
 * @param {object} meta - { source, parseSummary, regime, warnings, asOfDate, benchReturns, benchSymbol }
 */
export function buildReport(enrichedHoldings, unmatched, meta) {
  const totalInvested = enrichedHoldings.reduce((s, h) => s + h.invested, 0);
  const totalCurrent = enrichedHoldings.reduce((s, h) => s + (h.currentValue ?? h.invested), 0);
  const totalPnL = totalCurrent - totalInvested;
  const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

  // Sort by position weight descending for the main listing
  const sorted = [...enrichedHoldings].sort(
    (a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0),
  );

  const { sectors, total: sectorTotal } = sectorAllocation(enrichedHoldings);
  const verdictSummary = verdictMix(enrichedHoldings);
  const health = portfolioHealthScore(enrichedHoldings, totalCurrent, sectors);
  const portfolioActions = portfolioLevelActions(enrichedHoldings, sectors, totalCurrent, verdictSummary);

  // Urgent-action queue (CUT_LOSS, SELL, BOOK_PROFIT, STRONG_ADD in that priority)
  const urgencyOrder = { high: 0, medium: 1, low: 2, none: 3 };
  const urgent = enrichedHoldings
    .filter((h) => h.action !== "HOLD" && h.action !== "NO_DATA" && h.actionUrgency !== "none")
    .sort((a, b) => {
      const u = urgencyOrder[a.actionUrgency] - urgencyOrder[b.actionUrgency];
      if (u !== 0) return u;
      return Math.abs(b.pnlPercent ?? 0) - Math.abs(a.pnlPercent ?? 0);
    });

  // Top winners and losers
  const withPnL = enrichedHoldings.filter((h) => h.pnlAmount != null);
  const topWinners = [...withPnL].sort((a, b) => b.pnlAmount - a.pnlAmount).slice(0, 5);
  const topLosers = [...withPnL].sort((a, b) => a.pnlAmount - b.pnlAmount).slice(0, 5);

  // Risk + stress tests
  const riskBlock = buildRiskBlock(enrichedHoldings, meta?.benchReturns);
  const stressTests = buildStressTests(enrichedHoldings);

  // Strip the internal `_stockReturns` from per-holding objects so the
  // wire payload stays small (returns ×20 holdings × 120 days = ~2400
  // floats we don't need on the client).
  const stripInternal = (h) => {
    const { _stockReturns, ...rest } = h;
    return rest;
  };

  return {
    generatedAt: new Date().toISOString(),
    asOfDate: meta?.asOfDate ?? null,
    source: meta?.source ?? null,
    macroRegime: meta?.regime ?? null,
    benchmark: meta?.benchSymbol ?? null,
    summary: {
      holdingsCount: enrichedHoldings.length,
      unmatchedCount: unmatched.length,
      totalInvested,
      totalCurrent,
      totalPnL,
      totalPnLPct,
    },
    health,
    risk: riskBlock,
    stressTests,
    sectorAllocation: sectors,
    verdictMix: verdictSummary,
    urgentActions: urgent.map(stripInternal),
    portfolioLevelActions: portfolioActions,
    topWinners: topWinners.map(stripInternal),
    topLosers: topLosers.map(stripInternal),
    holdings: sorted.map(stripInternal),
    unmatched,
    warnings: meta?.warnings ?? [],
    disclaimer:
      "This report is for educational and informational purposes only. StarBhai is NOT a " +
      "SEBI-registered investment adviser; nothing here constitutes personalised investment " +
      "advice. Past performance is not indicative of future results. Always consult a " +
      "SEBI-registered professional before acting on this analysis.",
  };
}
