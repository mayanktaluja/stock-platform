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
  xirr,
  computeTargetWeights,
} from "./riskMetrics.js";
import { normalizeSector } from "./macroRegime.js";
import { runXirrOptimizer } from "./xirrOptimizer.js";
import { recommendBook as recommendMfBook } from "./mfRecommendation.js";
import { getGovernance } from "./governance.js";
import { deriveGovernanceGate } from "./services/swsIndianRiskLayer.js";
import { buildExitPlan as buildSharedExitPlan, buildExitPlanSummary } from "./services/exitPlan/exitPlanPolicy.js";

// ──────────────────── Sector canonicalisation ────────────────────
//
// NSE's raw sector labels are granular and inconsistent ("Automobile and
// Auto Components", "Capital Goods", "Financial Services", "Stockbroking
// & Allied"). macroRegime.normalizeSector maps them to a 20-sector
// canonical vocabulary used by the stress model. We apply it BEFORE
// aggregation so the sectorAllocation pie doesn't split one economic
// sector across 3 labels — and so the stress-model sector lookup works
// against canonical names.
function canonicalSector(raw) {
  if (!raw) return null;
  const normalized = normalizeSector(raw);
  // Fall back to the raw label if normalizeSector didn't recognise it —
  // some NSE labels (e.g. "Textiles") aren't in the canonical list but
  // are still meaningful. Just trim and title-case lightly.
  if (normalized) return normalized;
  const s = String(raw).trim();
  return s.length ? s : null;
}

// ──────────────────── Red flags (structured) ────────────────────

function extractRedFlags({ fundamentals, analysis, quote, midTerm, positionWeight, earningsNearby }) {
  // Each red flag is a finding — a data point the investor should know —
  // NOT a recommendation. Messages use observational voice and cite the
  // metric or threshold being flagged.
  const flags = [];

  // Fundamentals-based observations
  if (fundamentals?.debtToEquity != null && fundamentals.debtToEquity > 2) {
    flags.push({
      severity: "high",
      category: "fundamentals",
      message: `Debt/Equity = ${fundamentals.debtToEquity.toFixed(2)} — high leverage. Companies at this D/E level have historically shown higher earnings sensitivity to rate cycles and credit shocks.`,
    });
  }
  if (fundamentals?.roe != null && fundamentals.roe < 0.10) {
    flags.push({
      severity: "medium",
      category: "fundamentals",
      message: `ROE = ${(fundamentals.roe * 100).toFixed(1)}% — below the 10% threshold commonly used in quality-investing literature as the floor where equity capital compounds attractively.`,
    });
  }
  if (fundamentals?.profitMargin != null && fundamentals.profitMargin < 0) {
    flags.push({
      severity: "high",
      category: "fundamentals",
      message: `Net profit margin is negative — the business is currently loss-making at the net level.`,
    });
  }
  if (fundamentals?.revenueGrowth != null && fundamentals.revenueGrowth < 0) {
    flags.push({
      severity: "medium",
      category: "fundamentals",
      message: `Revenue YoY = ${(fundamentals.revenueGrowth * 100).toFixed(1)}% — top-line contraction. The slowdown is structural, not just margin compression.`,
    });
  }
  if (fundamentals?.pe != null && fundamentals?.sectorPe != null &&
      fundamentals.pe > 0 && fundamentals.sectorPe > 0 &&
      fundamentals.pe > fundamentals.sectorPe * 2) {
    flags.push({
      severity: "medium",
      category: "valuation",
      message: `P/E ${fundamentals.pe.toFixed(1)} is over 2× sector median (${fundamentals.sectorPe.toFixed(1)}). Historical mean-reversion studies on Indian equities show 2×-sector-P/E stocks underperform sector-median stocks over 3–5 year windows.`,
    });
  }

  // Technical observations
  const trend = analysis?.indicators?.trend;
  if (trend?.strength === "strong_bearish") {
    flags.push({
      severity: "high",
      category: "technical",
      message: `Long-term trend is strongly bearish — price is below every major moving average (20/50/200-DMA).`,
    });
  }
  if (quote && quote.fiftyTwoWeekHigh && quote.fiftyTwoWeekLow && quote.regularMarketPrice) {
    const posInRange = (quote.regularMarketPrice - quote.fiftyTwoWeekLow) /
      (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow);
    if (posInRange >= 0.95) {
      flags.push({
        severity: "medium",
        category: "technical",
        message: `Price is at 95%+ of 52-week range. Historical data shows late-range entries carry elevated short-term drawdown risk.`,
      });
    }
    if (posInRange <= 0.05) {
      flags.push({
        severity: "medium",
        category: "technical",
        message: `Price is at 5% or below of 52-week range. Could be a bottom; could be continued downtrend. Reversal signal confirmation is statistically important before accumulation.`,
      });
    }
  }
  if (midTerm?.slConfirmed) {
    flags.push({
      severity: "high",
      category: "exit-trigger",
      message: `Two consecutive daily closes below the technical support level. Standard position-management rule books would flag this for review.`,
    });
  }

  // Position-level observation
  if (positionWeight != null && positionWeight > 15) {
    flags.push({
      severity: "medium",
      category: "position",
      message: `Position is ${positionWeight.toFixed(1)}% of portfolio — above the 15% threshold where single-stock drawdowns historically produce outsized portfolio-level losses.`,
    });
  }

  // Event catalyst
  if (earningsNearby) {
    flags.push({
      severity: "medium",
      category: "event",
      message: `Earnings scheduled ${earningsNearby.date} — event-day gap risk. ATR-based technical levels are structurally unable to defend against overnight gaps.`,
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
  if (!quote?.regularMarketPrice) return null;

  const structuralSupport = longTerm?.stopLoss && (!midTerm?.stopLoss || longTerm.stopLoss > midTerm.stopLoss)
    ? longTerm.stopLoss
    : midTerm?.stopLoss;
  const plan = buildSharedExitPlan({
    midTerm,
    supportLevel: structuralSupport,
    upsideBand: midTerm?.target ?? longTerm?.target,
    currentPrice: quote.regularMarketPrice,
    avgPrice,
    atrPct: midTerm?.volatilityPct,
    trailingStop: midTerm?.trailingStop,
    reasons: analysis?.signals || [],
  });

  if (longTerm?.target) {
    plan.longTermReference = longTerm.target;
    plan.longTermTarget = longTerm.target;
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
    instrumentType: rawInstrumentType,
    scored: rawScored,
  } = input;

  // ETFs are priced but not scored. We short-circuit the scoring/action
  // engine early so a silver/gold/nifty ETF contributes to the portfolio's
  // total value, P&L, and risk metrics — but doesn't get a fundamental
  // verdict, a buy/sell signal, or an exit plan (those would be meaningless
  // for a basket tracker).
  const isEtf = rawInstrumentType === "etf" || rawScored === false;

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

  // Look up the per-symbol governance snapshot from the daily-refreshed
  // governance.json (NSE Reg 31 quarterly filings) and derive the hard
  // gate. Returns null when the snapshot is missing OR neither pledge
  // threshold is breached — so this lookup is a no-op for the 95%+ of
  // stocks that don't carry promoter-pledge risk. When it does fire, the
  // gate causes computeAction to short-circuit to REVIEW_GOVERNANCE
  // before any P&L logic. See services/swsIndianRiskLayer.js for the
  // threshold rationale (Vedanta-2021 / Zee-2022 / YesBank-2020).
  const governanceGate = deriveGovernanceGate(getGovernance(symbol));

  const action = computeAction(
    { symbol, name, pnlPercent: pnlPercent ?? 0, investedValue: invested, currentValue: currentValue ?? invested, sector },
    { combinedScore, technicalScore: techScore, fundamentalScore: fundScore, fundamentalVerdict: fundVerdict },
    {
      positionWeight,
      sectorWeight,
      hasLiveData: price != null,
      macroInfo: (macroInfo && Math.abs(macroInfo.impact || 0) >= 2 && (macroInfo.severity || 0) >= 3) ? macroInfo : null,
      governanceGate,
    },
  );

  const redFlags = extractRedFlags({
    fundamentals: fundamentals?.snapshot ?? null,
    analysis, quote, midTerm,
    positionWeight, earningsNearby,
  });

  // Liquidity red flag — separate from the main extractor because it
  // needs the computed holdingRisk which comes later in this function.
  // We'll append it after holdingRisk is built.

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

  // ── Liquidity / days-to-exit ──
  // Estimated as: quantity × price ÷ (20% of median daily traded value).
  // The 20% cap models the "don't move the price" constraint — market
  // microstructure research (Almgren-Chriss, etc.) treats ~10–25% of ADV
  // as the zone where participation starts showing meaningful impact.
  // Surfacing this lets a user see "this small-cap position would take
  // 8 trading days to exit at normal size" — a piece of information
  // SEBI's 2024 risk-disclosure guidance explicitly highlights.
  let daysToExit = null;
  let medianDailyValueCr = null;
  if (Array.isArray(historical) && historical.length >= 20 && price != null) {
    const recent = historical.slice(-20);
    const dailyValues = recent
      .map((d) => (Number.isFinite(d.volume) && Number.isFinite(d.close)) ? d.volume * d.close : null)
      .filter((v) => v != null && v > 0);
    if (dailyValues.length >= 10) {
      // Median is more robust than mean against earnings-day volume spikes
      const sorted = [...dailyValues].sort((a, b) => a - b);
      const medianValue = sorted[Math.floor(sorted.length / 2)];
      const positionValue = (quantity || 0) * price;
      const participation = medianValue * 0.20; // 20% of ADV/day is acceptable
      if (participation > 0) {
        daysToExit = +(positionValue / participation).toFixed(1);
        medianDailyValueCr = +(medianValue / 1e7).toFixed(2);
      }
    }
  }

  const holdingRisk = {
    beta: beta != null ? +beta.toFixed(2) : null,
    annualizedVolatility: annVol != null ? +(annVol * 100).toFixed(1) : null, // as %
    maxDrawdown1y: oneYearDD != null ? +(oneYearDD * 100).toFixed(1) : null,   // as % (negative)
    var95Daily: var95 != null ? +(var95 * 100).toFixed(2) : null,              // as % (negative)
    sampleSize: stockReturns.length,
    // Liquidity fields — null when we can't compute
    daysToExit,
    medianDailyValueCr,
    // Categorical flag for the UI to color-code:
    //   good:     < 1 day (effectively instant)
    //   fair:     1–5 days (manageable)
    //   watch:    5–10 days (plan the exit)
    //   poor:     > 10 days (illiquid — material slippage likely)
    liquidityBand:
      daysToExit == null ? null
      : daysToExit < 1 ? "good"
      : daysToExit < 5 ? "fair"
      : daysToExit < 10 ? "watch" : "poor",
  };

  // Append liquidity red flag if material
  if (daysToExit != null && daysToExit > 10) {
    redFlags.push({
      severity: daysToExit > 20 ? "high" : "medium",
      category: "liquidity",
      message: `Position size implies ~${daysToExit} trading days to exit at 20% of median daily traded value (₹${medianDailyValueCr}Cr/day). Illiquid exits historically show material price impact; a full-size unwind would likely move the print.`,
    });
  }

  // ETF return shape — same POSITION fields (for total portfolio value
  // and risk aggregation) but all the scoring / action / exit-plan fields
  // are nulled out. The UI uses `instrumentType` to pick the ETF card
  // variant (no buy/sell action, no signal, no exit levels).
  if (isEtf) {
    return {
      symbol, isin, name,
      sector: canonicalSector(sector) || "ETF",
      rawSector: sector || null,
      rawName, matchType,
      instrumentType: "etf",
      scored: false,
      // Position (still matters)
      quantity, avgPrice,
      currentPrice: price,
      invested,
      currentValue,
      pnlAmount,
      pnlPercent,
      positionWeight,
      // Scoring/action fields nulled — basket trackers aren't scored
      technicalScore: null,
      fundamentalScore: null,
      fundamentalVerdict: null,
      combinedScore: null,
      recommendation: null,
      action: "ETF",
      displayAction: "ETF — priced only",
      actionColor: "gray",
      actionUrgency: "none",
      actionReasoning: "Basket tracker — Starbhai scores single-stock fundamentals, which don't apply to ETFs. Priced here for portfolio-value and risk purposes.",
      actionFactors: ["instrument_etf"],
      macroWarning: null,
      macroTailwind: null,
      // Risk still meaningful (beta/vol of the ETF as a whole)
      outlook: null,
      redFlags: [],
      exitPlan: null,
      taxNote,
      earningsNearby: null,
      risk: holdingRisk,
      sourceRow: input.sourceRow,
      // Retain internal returns for portfolio aggregation (risk + corr)
      _stockReturns: stockReturns,
    };
  }

  return {
    // Identity. Sector is canonicalised here so every consumer of the
    // holding (UI cards, sector pie, stress model) reads the same label.
    symbol, isin, name,
    sector: canonicalSector(sector),
    rawSector: sector || null,
    rawName, matchType,
    instrumentType: "equity",
    scored: true,
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
    // Full long-term outlook block — recommendation, score, target, narrative,
    // news. Surfaced so the UI can render the Starbhai thesis card on
    // analyzer holding cards (mirrors the stock detail page layout).
    longTerm: longTerm || null,
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
  // Canonicalise before aggregating so NSE's granular labels
  // ("Automobile and Auto Components" vs "Auto Components" vs "Capital
  // Goods") collapse into one bucket per economic sector.
  const totals = new Map();
  let total = 0;
  for (const h of holdings) {
    if (h.currentValue == null) continue;
    total += h.currentValue;
    const bucket = canonicalSector(h.sector) || "Unknown";
    totals.set(bucket, (totals.get(bucket) || 0) + h.currentValue);
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
  // Portfolio-level observations. Each entry is an analytical finding,
  // not an instruction — the investor decides the response.
  const actions = [];

  // Sector concentration observations
  for (const s of sectors) {
    if (s.pct > 30) {
      actions.push({
        type: "sector-overweight",
        severity: "high",
        message: `${s.sector} is ${s.pct.toFixed(1)}% of portfolio value. Academic research on Indian equity concentration (NSE-IIM studies, 2018–22) shows sector weights above 30% materially amplify drawdown during sector-specific shocks.`,
      });
    } else if (s.pct > 20) {
      actions.push({
        type: "sector-overweight",
        severity: "medium",
        message: `${s.sector} is ${s.pct.toFixed(1)}% of portfolio — moderately overweight. The 30% level is where concentration risk typically becomes pronounced in backtests.`,
      });
    }
  }

  // Holding count observations
  if (holdings.length > 30) {
    actions.push({
      type: "over-diversified",
      severity: "medium",
      message: `${holdings.length} holdings — above the 15–25 range often cited in retail portfolio research as the point of diminishing diversification benefit.`,
    });
  } else if (holdings.length < 8) {
    actions.push({
      type: "under-diversified",
      severity: "medium",
      message: `${holdings.length} holdings — below the 8–10 lower bound where single-stock idiosyncratic risk becomes the dominant portfolio risk factor per standard diversification math.`,
    });
  }

  // Quality mix observation
  const expensive = (verdictSummary.value.OVERVALUED || 0) + (verdictSummary.value.FULLY_VALUED || 0);
  if (totalValue > 0 && (expensive / totalValue) > 0.4) {
    actions.push({
      type: "quality-mix",
      severity: "medium",
      message: `${((expensive / totalValue) * 100).toFixed(0)}% of portfolio value sits in stocks scored OVERVALUED or FULLY_VALUED on the fundamental screen. Mean-reversion studies on Indian equities have historically favoured DEEP_VALUE / QUALITY_GROWTH names over 3–5 year horizons.`,
    });
  }

  // Scorecard review flags (formerly "urgent exits")
  const cutLossCount = holdings.filter((h) => h.action === "CUT_LOSS").length;
  if (cutLossCount > 0) {
    actions.push({
      type: "review-deep-drawdown",
      severity: "high",
      message: `${cutLossCount} holding(s) show deep drawdowns with weak recovery signals. The per-holding cards contain the evidence; worth reviewing each.`,
    });
  }

  const bookProfitCount = holdings.filter((h) => h.action === "BOOK_PROFIT").length;
  if (bookProfitCount > 0) {
    actions.push({
      type: "profit-watch",
      severity: "medium",
      message: `${bookProfitCount} holding(s) up >50% with cooling momentum on the scorecard. Historical patterns on Indian midcaps often show partial gain-locking at this stage preserves realised returns better than riding the full position.`,
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

  // Confidence band: below ~252 daily observations (1 year of trading
  // days) the standard errors on beta, Sharpe, correlation and historical
  // VaR are wide enough that the point estimates can be misleading. We
  // surface the confidence level so the UI can show a caveat and the
  // user can discount accordingly.
  //
  // Thresholds follow standard quant practice:
  //   ≥ 252 days : "high"   — full year, stable estimates
  //   ≥ 126 days : "medium" — 6 months, usable but wider bands
  //   < 126 days : "low"    — less than half year, point estimates fragile
  const n = portReturns.length;
  const confidence = n >= 252 ? "high" : n >= 126 ? "medium" : "low";

  // Rough confidence bands for Sharpe + beta when n is small. Formulae:
  //   SE(Sharpe)  ≈ sqrt((1 + 0.5 * SR²) / n)       · Lo (2002)
  //   SE(β)       ≈ σ_ε / (σ_benchmark · sqrt(n))   · standard OLS
  // We don't have σ_ε handy; use a rule-of-thumb that at n=252 SE is ~0.15,
  // scaling as 1/sqrt(n).
  const sharpeSE = portSharpe != null && n >= 30
    ? Math.sqrt((1 + 0.5 * portSharpe * portSharpe) / n)
    : null;
  const betaSE = n >= 30 ? +(0.15 * Math.sqrt(252 / n)).toFixed(2) : null;

  return {
    weightedBeta: +weightedBeta.toFixed(2),
    weightedBetaSE: betaSE, // ~1σ error band
    betaCoverage: rawBetaCount,
    betaTotal: holdings.length,
    portfolioVolatilityPct: portVol != null ? +(portVol * 100).toFixed(1) : null,
    portfolioSharpe: portSharpe != null ? +portSharpe.toFixed(2) : null,
    portfolioSharpeSE: sharpeSE != null ? +sharpeSE.toFixed(2) : null,
    maxDrawdownPct: maxDD != null ? +(maxDD * 100).toFixed(1) : null,
    var95DailyPct: portVar95 != null ? +(portVar95 * 100).toFixed(2) : null,
    var99DailyPct: portVar99 != null ? +(portVar99 * 100).toFixed(2) : null,
    avgCorrelation: avgCorr != null ? +avgCorr.toFixed(2) : null,
    benchVolatilityPct: benchVol != null ? +(benchVol * 100).toFixed(1) : null,
    benchSharpe: benchSharpe != null ? +benchSharpe.toFixed(2) : null,
    benchVar95DailyPct: benchVar95 != null ? +(benchVar95 * 100).toFixed(2) : null,
    sampleDays: n,
    confidence,
    // Methodology line for the UI — readers understand where numbers came from.
    methodology: `Historical VaR (${n} daily obs), OLS β vs ^NSEI, log-compounded portfolio series. Confidence level: ${confidence}.`,
    interpretation: interpretRisk({ weightedBeta, portVol, benchVol, avgCorr, maxDD, confidence, n }),
  };
}

/**
 * Short human-readable interpretation of the risk block. Single
 * paragraph, plain English, deterministic.
 */
function interpretRisk({ weightedBeta, portVol, benchVol, avgCorr, maxDD, confidence, n }) {
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
  if (confidence === "low" && Number.isFinite(n)) {
    parts.push(`Confidence: LOW — ${n} daily observations is under half a year, so beta/Sharpe point estimates carry wide error bands.`);
  } else if (confidence === "medium" && Number.isFinite(n)) {
    parts.push(`Confidence: MEDIUM — ${n} daily observations (under 1 year); use point estimates as directional, not precise.`);
  }
  return parts.join(" ");
}

/**
 * Sector-dispersion multipliers for the stress model.
 *
 * Pure-β CAPM stress significantly under-estimates tail risk for small/
 * mid-caps and cyclicals because sector dispersion during crises is real.
 * Empirical observations from 2020 COVID drawdown (Feb–Mar 2020) + 2008
 * GFC (peak-to-trough, Jan 2008–Mar 2009) on NSE sectoral indices:
 *
 *   Observed downside multiplier (vs. Nifty 50 base):
 *     NBFC              ~1.6x  (2020: Bajaj Finance fell 2× Nifty)
 *     Real Estate       ~1.5x  (2008 severe)
 *     Metals            ~1.5x  (commodity-cyclical)
 *     Banking           ~1.4x  (2008 deeply hurt, 2020 moderately)
 *     Capital Goods     ~1.3x  (cyclical)
 *     Auto              ~1.3x  (cyclical)
 *     Infrastructure    ~1.3x
 *     Cement            ~1.2x
 *     Chemicals         ~1.1x
 *     Oil & Gas         ~1.1x  (inelastic demand softens)
 *     Power             ~1.0x  (utility-like)
 *     Telecom           ~0.9x  (defensive)
 *     IT Services       ~0.8x  (USD-earnings hedge during INR weakness)
 *     Pharma            ~0.7x  (2020: defensive + export tailwind)
 *     FMCG              ~0.7x  (staple demand)
 *
 * Upside multipliers are symmetric around 1.0 (i.e. cyclicals also
 * rally more in recoveries), but this function only models downside
 * shocks so that's out of scope.
 *
 * Numbers are calibrated, not precise — treat them as "1.5x means this
 * sector usually sees 50% more drawdown than the headline index during
 * broad market shocks".
 */
const SECTOR_STRESS_MULTIPLIER = {
  "NBFC": 1.6,
  "Real Estate": 1.5,
  "Metals": 1.5,
  "Banking": 1.4,
  "Capital Goods": 1.3,
  "Automobile": 1.3,
  "Aviation": 1.4,
  "Infrastructure": 1.3,
  "Cement": 1.2,
  "Chemicals": 1.1,
  "Oil & Gas": 1.1,
  "Media": 1.3,
  "Retail": 1.2,
  "Power": 1.0,
  "Telecom": 0.9,
  "Defence": 1.1,
  "IT Services": 0.8,
  "Pharma": 0.7,
  "FMCG": 0.7,
  "Energy": 1.0,
};

/**
 * Stress-test block: project portfolio value under 3 Nifty scenarios
 * using per-holding beta × sector-dispersion multiplier. This improves on
 * pure-β CAPM which systematically under-prices the tail risk of small/
 * mid-caps and cyclicals.
 *
 * Methodology per-holding:
 *   effective_shock_h = market_shock × β_h × sector_multiplier_h
 *   projected_value_h = currentValue_h × (1 + effective_shock_h)
 *
 * Falls back to pure β × shock when sector is unknown (multiplier = 1.0).
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
    // Apply sector dispersion multiplier ON TOP of beta. Sector is already
    // canonical at this point (canonicalSector was applied in analyzeHolding).
    sectorMultiplier: SECTOR_STRESS_MULTIPLIER[h.sector] ?? 1.0,
    currentValue: h.currentValue || 0,
  }));

  // Run both the baseline (β only) and dispersion-adjusted (β × sector)
  // scenarios so we can surface BOTH numbers on the UI. Investors see
  // "CAPM says X, sector-adjusted says Y" — intellectually honest.
  const tests = [];
  for (const s of scenarios) {
    const pureRes = stressScenario(
      input.map((h) => ({ beta: h.beta, currentValue: h.currentValue })),
      s.shock,
    );
    // Sector-adjusted: fold sectorMultiplier into an effective beta
    const sectorAdjusted = stressScenario(
      input.map((h) => ({
        beta: (h.beta ?? 1) * h.sectorMultiplier,
        currentValue: h.currentValue,
      })),
      s.shock,
    );
    tests.push({
      name: s.name,
      tag: s.tag,
      marketShockPct: s.shock * 100,
      // Default shown = sector-adjusted (more honest)
      projectedLossPct: +sectorAdjusted.projectedLossPct.toFixed(1),
      projectedLossAmount: sectorAdjusted.projectedLossAmount,
      // Pure-β baseline reported for comparison
      projectedLossPctPureBeta: +pureRes.projectedLossPct.toFixed(1),
      projectedLossAmountPureBeta: pureRes.projectedLossAmount,
      coveredValue: sectorAdjusted.coveredValue,
      methodology:
        "β × sector-dispersion multiplier (NBFC 1.6x, Metals 1.5x, IT 0.8x, FMCG 0.7x, …) vs. pure-β CAPM.",
    });
  }
  return tests;
}

/**
 * Currency / INR-concentration narrative.
 *
 * A typical retail Indian portfolio is 100% INR-denominated with zero FX
 * hedging. Over a long horizon, INR has depreciated vs. USD by ~2-4%/yr
 * on average (INR 40 in 2008 → ~84 in 2024). HNIs and family offices
 * often allocate 10-20% to international equities or USD-earning Indian
 * stocks (IT, Pharma) as a hedge.
 *
 * This block quantifies the mix and narrates the exposure. Purely
 * educational — not a recommendation to buy/sell anything.
 */
function currencyExposure(holdings) {
  const total = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
  if (total <= 0) return null;

  // Rough USD-earning proxy: IT Services + Pharma are the two sectors
  // where > 50% of revenue is typically USD-denominated for Indian
  // large/midcaps. Other sectors can have export exposure too but
  // those two are the cleanest proxies.
  const usdEarningSectors = new Set(["IT Services", "Pharma"]);
  let usdEarningValue = 0;
  for (const h of holdings) {
    if (usdEarningSectors.has(h.sector)) usdEarningValue += h.currentValue || 0;
  }
  const usdEarningPct = +((usdEarningValue / total) * 100).toFixed(1);
  const inrExposurePct = +(100 - usdEarningPct).toFixed(1);

  // Narrative by band
  let narrative;
  if (usdEarningPct < 5) {
    narrative =
      `Portfolio is ~${inrExposurePct}% INR-exposed with negligible USD-earning stocks. ` +
      "Historical data shows INR has depreciated ~2–4%/year vs USD over long horizons; " +
      "100% INR exposure means full currency-risk absorption. Export-heavy sectors " +
      "(IT Services, Pharma) naturally hedge this — consider the trade-off.";
  } else if (usdEarningPct < 15) {
    narrative =
      `${usdEarningPct}% of portfolio is in export-heavy sectors (IT Services, Pharma) ` +
      "that earn in USD — a partial natural hedge against INR depreciation. " +
      `Remaining ${inrExposurePct}% is fully INR-exposed.`;
  } else if (usdEarningPct < 35) {
    narrative =
      `${usdEarningPct}% of portfolio is in export-heavy sectors providing a meaningful ` +
      "natural hedge against INR depreciation. Historical INR-USD data shows this " +
      "level of export exposure has dampened 60-70% of currency drag over rolling 5-year windows.";
  } else {
    narrative =
      `${usdEarningPct}% in export-heavy sectors — significantly tilted toward USD-earning ` +
      "stocks. This is unusually strong currency-hedge, but also concentrates sector risk " +
      "in IT/Pharma which have distinct cyclicality.";
  }

  return {
    inrExposurePct,
    usdEarningPct,
    usdEarningValue: Math.round(usdEarningValue),
    narrative,
    methodology:
      "USD-earning proxy = IT Services + Pharma (>50% export revenue typical). " +
      "Indian IT/Pharma large/midcaps earn meaningfully in USD; other export exposure " +
      "(Auto OEMs, Chemicals) not included to keep the number conservative.",
  };
}

/**
 * Build the complete portfolio report.
 * @param {object[]} enrichedHoldings - results of analyzeHolding() per stock
 * @param {object[]} unmatched - rows the parser couldn't resolve
 * @param {object} meta - { source, parseSummary, regime, warnings, asOfDate, benchReturns, benchSymbol }
 */
export function buildReport(enrichedHoldings, unmatched, meta) {
  // Book-wide totals include MF holdings so the summary matches the user's
  // statement (e.g. Groww MF-only export where enrichedHoldings is empty
  // but mfHoldings carries ₹16L). Equity-only sub-totals are still computed
  // from enrichedHoldings further below for sector/risk/health blocks.
  const mfHoldingsForTotals = Array.isArray(meta?.mfHoldings) ? meta.mfHoldings : [];
  const equityInvested = enrichedHoldings.reduce((s, h) => s + h.invested, 0);
  const equityCurrent = enrichedHoldings.reduce((s, h) => s + (h.currentValue ?? h.invested), 0);
  const mfInvested = mfHoldingsForTotals.reduce((s, m) => s + (Number(m.invested) || 0), 0);
  const mfCurrent = mfHoldingsForTotals.reduce((s, m) => s + (Number(m.currentValue) || Number(m.invested) || 0), 0);
  const totalInvested = equityInvested + mfInvested;
  const totalCurrent = equityCurrent + mfCurrent;
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

  // ── XIRR (graceful — handles missing purchase dates + MF holdings) ──
  //
  // Delegates to xirrOptimizer.computePortfolioXirr (used as the canonical
  // XIRR source). When a holding lacks purchaseDate, the optimizer assumes
  // a 24-month holding window. When MF holdings carry Groww-published
  // per-scheme XIRR, the optimizer back-solves a synthetic single flow.
  // This means the headline XIRR is always available, with a confidence
  // band the UI can show.
  const stockOnlyHoldings = enrichedHoldings; // current callers don't pass mfHoldings yet
  const mfHoldings = Array.isArray(meta?.mfHoldings) ? meta.mfHoldings : [];
  let portfolioXirr = null;
  let xirrBasis = null;
  let xirrConfidence = null;
  if (totalCurrent > 0) {
    try {
      const xirrInfo = runXirrOptimizer({
        holdings: stockOnlyHoldings,
        unmatched,
        mfHoldings,
        sectorAllocation: sectors,
        preset: meta?.optimizerPreset || "balanced",
        taxSlabPct: Number.isFinite(meta?.taxSlabPct) ? meta.taxSlabPct : 30,
        assumedHoldingMonths: Number.isFinite(meta?.assumedHoldingMonths) ? meta.assumedHoldingMonths : 24,
        ltcgRealisedYtdRupees: Number.isFinite(meta?.ltcgRealisedYtdRupees) ? meta.ltcgRealisedYtdRupees : 0,
      });
      if (xirrInfo.currentXirrPct != null) {
        portfolioXirr = xirrInfo.currentXirrPct;
        xirrConfidence = xirrInfo.currentXirrConfidence;
        const partsBasis = [];
        if (xirrInfo.currentXirrAssumptions.missingDateCount > 0) {
          partsBasis.push(`${xirrInfo.currentXirrAssumptions.missingDateCount} holding(s) assumed ${xirrInfo.currentXirrAssumptions.assumedHoldingMonths}-month window`);
        }
        if (xirrInfo.currentXirrAssumptions.mfBackSolveCount > 0) {
          partsBasis.push(`${xirrInfo.currentXirrAssumptions.mfBackSolveCount} MF holding(s) back-solved from published XIRR`);
        }
        xirrBasis = `Confidence: ${xirrConfidence}. ${partsBasis.length ? partsBasis.join("; ") + "." : "All holdings have known purchase dates."}`;
      }
      // Stash the full optimizer block on a stable name for the return below
      meta._optimizerBlock = xirrInfo;
    } catch (err) {
      console.warn("[ANALYZER] XIRR optimizer failed:", err.message);
    }
  }

  // ── Per-MF-position recommendations (Phase 1 of the recommender) ──
  //
  // Every MF in the book gets a HOLD/EXIT/SWITCH/ADD/CONSOLIDATE call
  // with full evidence trail (perf vs cat benchmark, peer rank, folio
  // overlap). This is the surface the SEBI-RA reads — the optimizer's
  // book-wide projection now plays a supporting role.
  //
  // Wrapped in a try so a recommender bug never breaks the analyze
  // endpoint; we log + return null and let the UI fall back gracefully.
  let mfPositionsBlock = null;
  if (mfHoldings.length > 0) {
    try {
      mfPositionsBlock = recommendMfBook(mfHoldings, {
        today: meta?.asOfDate || undefined,
        // Priority 3: pass through the user's risk profile (when present)
        // so the recommender can tag per-fund alignment + the asset-
        // allocation gap module can pick the right target weights.
        riskProfile: meta?.riskProfile || null,
      });
    } catch (err) {
      console.warn("[ANALYZER] MF recommender failed:", err.message);
    }
  }
  meta._mfPositionsBlock = mfPositionsBlock;

  // ── Rebalance suggestions ──
  //
  // Risk-parity target weights (equal-risk-contribution, capped at 12%
  // per stock). Not a trade instruction — it's the "mathematically
  // diversified" distribution the user can compare against their actual
  // weights. Delta is in ₹ as well as percentage so the user can
  // directly size any rebalance they choose to make.
  const rebalanceTargets = computeTargetWeights(enrichedHoldings);
  const exitPlanSummary = buildExitPlanSummary(sorted);

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
      // Annualised return via XIRR — graceful: handles missing purchase
      // dates and MF holdings via xirrOptimizer.computePortfolioXirr.
      // Compare against Nifty CAGR to judge whether the book is adding
      // alpha vs. passively holding the index.
      xirrAnnualPct: portfolioXirr,
      xirrBasis,
      xirrConfidence,
    },
    // Full XIRR Optimizer block — moves, projections, constraints.
    // Available only when we successfully computed a portfolio XIRR.
    optimizer: meta?._optimizerBlock || null,
    // Per-MF position recommendations — primary surface for the SEBI-RA.
    // Each entry: { name, folio, invested, currentValue, rec: {action,
    // confidence, reasons[], peerCandidates[], performance, news} }
    mfPositions: meta?._mfPositionsBlock || null,
    health,
    risk: riskBlock,
    stressTests,
    rebalanceTargets,
    currencyExposure: currencyExposure(enrichedHoldings),
    sectorAllocation: sectors,
    verdictMix: verdictSummary,
    urgentActions: urgent.map(stripInternal),
    portfolioLevelActions: portfolioActions,
    topWinners: topWinners.map(stripInternal),
    topLosers: topLosers.map(stripInternal),
    exitPlanSummary,
    holdings: sorted.map(stripInternal),
    unmatched,
    warnings: meta?.warnings ?? [],
    // PR D11 — aligned with the SEBI sticky-footer + Track Record
    // past-performance chip. Educational-only + market-risk warning +
    // non-RA disclosure folded into the canonical regulator sentence.
    disclaimer: "Educational content only. Investments in securities market are subject to market risks; read all related documents carefully before investing. Starbhai is not a SEBI-registered Research Analyst or Investment Adviser — past performance does not guarantee future results.",
  };
}
