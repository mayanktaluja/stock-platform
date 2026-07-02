import { num } from "./swsScoring.js";
import {
  ALL_REDUCTION_ACTIONS,
  ALL_TOPUP_ACTIONS,
  parseTopUpPct,
  parseTrimPct,
} from "./actionLadder.js";
import {
  buildSmallcapPolicy,
  buildSmallcapSleeve,
  classifyMarketCapBucket,
} from "./portfolioDecisionPolicy.js";
import { candidateBaseRank } from "./portfolio/addCandidateRank.js";

export const MIN_FUNDED_TRADE_INR = 25_000;
export const MAX_FUNDED_ADDS = 5;
export const MAX_POSITION_WEIGHT_PCT = 8;
export const MAX_SECTOR_WEIGHT_PCT = 25;

const FUNDABLE_VALUATION_BANDS = new Set(["DISCOUNT", "DEEP_DISCOUNT"]);

function normTicker(v) {
  return String(v || "").trim().toUpperCase();
}

function sectorKey(v) {
  return String(v || "Unclassified").trim() || "Unclassified";
}

function daysBetween(aIso, b = new Date()) {
  if (!aIso) return null;
  const ms = Date.parse(`${String(aIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - ms) / 86_400_000);
}

function daysUntil(iso, now = new Date()) {
  if (!iso) return null;
  const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.ceil((ms - now.getTime()) / 86_400_000);
}

function holdingPriceUsable(h, asOfDateIso, now) {
  const age = num(h?.sws?.data_age_hours, null);
  if (age != null && age <= 36 && !h.staleData) return true;
  if (String(h?.priceSource || "").toLowerCase() === "broker") {
    const statementAgeDays = daysBetween(asOfDateIso, now);
    return statementAgeDays != null && statementAgeDays <= 7;
  }
  return false;
}

function freshPriceUsable(row) {
  const age = num(row?.data_age_hours, null);
  if (age == null) return true;
  return age <= 36;
}

// candidateBaseRank moved to ./portfolio/addCandidateRank.js — shared with the
// Top-up badge cap so both surfaces rank candidates with one formula.

function candidateRejectionReasons(c) {
  const reasons = [];
  if (num(c.v4_score, 0) < 53) reasons.push("v4 score below 53 construction floor");
  if (c.valuation_confidence !== "HIGH") reasons.push("valuation confidence is not HIGH");
  if (!FUNDABLE_VALUATION_BANDS.has(c.valuation_band)) reasons.push("valuation is not at discount/deep discount");
  if (num(c.upside_pct, -Infinity) < 12) reasons.push("FV upside below 12% funding floor");
  if (c.newsSignal?.signal < 0) reasons.push("negative SWS news vetoes fresh deployment");
  if (c.marketCapBucket === "unknown") reasons.push("market cap unavailable; coverage watch blocks funding");
  if (c.dataQualityGate?.status === "coverage_watch") reasons.push("coverage watch blocks funding");
  if (c.dataQualityGate?.status === "stale") reasons.push("stale data blocks funding");
  if (c.surveillance?.list) reasons.push(`${c.surveillance.list} surveillance blocks funding`);
  const earningsDays = daysUntil(c.next_earnings_date, c.now);
  if (earningsDays != null && earningsDays >= 0 && earningsDays <= 3) {
    reasons.push(`earnings in ${earningsDays}d`);
  }
  return reasons;
}

function makeHoldingCandidate(h, context) {
  const sws = h?.sws || {};
  const currentValue = num(h?.currentValue, 0);
  const sector = sectorKey(sws.sector || h?.sector);
  const priceUsable = holdingPriceUsable(h, context.asOfDateIso, context.now);
  return {
    source: "holding",
    ticker: normTicker(sws.ticker || h?.symbol),
    name: sws.name || h?.name || null,
    sector,
    // preCapAction first: a cap-demoted "Top-up-if-funded" row sizes off its
    // original rung when a declared budget reaches it (parseTopUpPct of the
    // capped key is 0).
    rawAction: h?.preCapAction || h?.action || null,
    currentValue,
    positionWeight: num(h?.positionWeight, 0),
    sectorWeight: num(h?.sectorWeight, null),
    v4_score: num(sws.v4_score, null),
    upside_pct: num(sws.upside_pct, null),
    fair_value_inr: num(sws.fair_value_inr, null),
    current_price_inr: num(sws.current_price_inr, null),
    valuation_confidence: sws.valuation_confidence || null,
    valuation_source: sws.valuation_source || null,
    valuation_band: sws.valuation_band || null,
    market_cap_inr: num(sws.market_cap_inr, null),
    marketCapBucket: h?.marketCapBucket || sws.market_cap_bucket || classifyMarketCapBucket(sws.market_cap_inr),
    smallcapPolicy: h?.smallcapPolicy || sws.smallcap_policy || null,
    dataQualityGate: h?.dataQualityGate || sws.data_quality_gate || null,
    data_age_hours: num(sws.data_age_hours, null),
    staleData: Boolean(h?.staleData),
    priceSource: h?.priceSource || null,
    priceUsable,
    surveillance: sws.surveillance || null,
    next_earnings_date: sws.next_earnings_date || null,
    newsSignal: h?.newsSignal || sws.news_signal || null,
    blockedReasons: h?.blockedReasons || [],
    displayActionIntent: h?.displayActionIntent || null,
    reasonFamily: h?.reasonFamily || null,
    sectorFitScore: num(h?._sectorFit?.score, 0),
    whyFit: null,
    now: context.now,
  };
}

function makeFreshCandidate(row, context) {
  const sector = sectorKey(row?.sector);
  return {
    source: "fresh",
    ticker: normTicker(row?.ticker || row?.symbol),
    name: row?.name || null,
    sector,
    rawAction: "Fresh candidate",
    currentValue: 0,
    positionWeight: 0,
    sectorWeight: null,
    v4_score: num(row?.v4_score ?? row?.v4_score_100, null),
    upside_pct: num(row?.upside_pct, null),
    fair_value_inr: num(row?.fair_value_inr, null),
    current_price_inr: num(row?.current_price_inr, null),
    valuation_confidence: row?.valuation_confidence || null,
    valuation_source: row?.valuation_source || null,
    valuation_band: row?.valuation_band || null,
    market_cap_inr: num(row?.market_cap_inr, null),
    marketCapBucket: row?.marketCapBucket || row?.market_cap_bucket || classifyMarketCapBucket(row?.market_cap_inr),
    smallcapPolicy: null,
    dataQualityGate: row?.dataQualityGate || row?.data_quality_gate || null,
    data_age_hours: num(row?.data_age_hours, null),
    staleData: false,
    priceSource: "sws",
    priceUsable: freshPriceUsable(row),
    surveillance: row?.surveillance || null,
    next_earnings_date: row?.next_earnings_date || null,
    newsSignal: row?.newsSignal || row?.news_signal || null,
    blockedReasons: row?.blockedReasons || [],
    displayActionIntent: row?.displayActionIntent || null,
    reasonFamily: row?.reasonFamily || null,
    sectorFitScore: num(row?._sectorFit?.score ?? row?.sectorFitScore, 0),
    whyFit: row?.whyFit || null,
    now: context.now,
  };
}

function collectFreshRows({ baskets, outsidePicks }) {
  const rows = [];
  for (const key of ["sectorGaps", "core", "defensive", "growth"]) {
    if (Array.isArray(baskets?.[key])) rows.push(...baskets[key]);
  }
  if (Array.isArray(outsidePicks?.growth)) rows.push(...outsidePicks.growth);
  if (Array.isArray(outsidePicks?.defensive)) rows.push(...outsidePicks.defensive);
  return rows.filter((r) => normTicker(r?.ticker || r?.symbol));
}

function capReason({ tradeRupees, roomPosition, roomSector, remaining, positionCapPct = MAX_POSITION_WEIGHT_PCT }) {
  if (remaining < MIN_FUNDED_TRADE_INR) return `leftover cash below INR ${MIN_FUNDED_TRADE_INR.toLocaleString("en-IN")} minimum`;
  if (roomPosition < MIN_FUNDED_TRADE_INR) return `single-name ${positionCapPct}% cap leaves no minimum trade room`;
  if (roomSector < MIN_FUNDED_TRADE_INR) return "sector 25% cap leaves no minimum trade room";
  if (tradeRupees < MIN_FUNDED_TRADE_INR) return `gap-to-target size below INR ${MIN_FUNDED_TRADE_INR.toLocaleString("en-IN")} minimum`;
  return "not funded";
}

export function buildPortfolioConstructionPlan({
  scoredHoldings = [],
  baskets = null,
  outsidePicks = null,
  freshCapitalInr = 0,
  confirmedFreedCapitalInr = 0,
  asOfDateIso = null,
  now = new Date(),
} = {}) {
  const context = { asOfDateIso, now };
  const portfolioValue = scoredHoldings.reduce((sum, h) => sum + num(h?.currentValue, 0), 0);
  const smallcapSleeve = buildSmallcapSleeve(scoredHoldings);
  const sectorValues = new Map();
  for (const h of scoredHoldings) {
    const sws = h?.sws || {};
    const s = sectorKey(sws.sector || h?.sector);
    sectorValues.set(s, (sectorValues.get(s) || 0) + num(h?.currentValue, 0));
  }

  const rawCandidates = [];
  for (const h of scoredHoldings) {
    if (h?.swsCovered && ALL_TOPUP_ACTIONS.has(h.action)) rawCandidates.push(makeHoldingCandidate(h, context));
  }
  for (const row of collectFreshRows({ baskets, outsidePicks })) {
    rawCandidates.push(makeFreshCandidate(row, context));
  }

  const deduped = new Map();
  for (const c of rawCandidates) {
    if (!c.ticker) continue;
    const existing = deduped.get(c.ticker);
    if (!existing) {
      deduped.set(c.ticker, c);
      continue;
    }
    if (existing.source === "holding" && c.source !== "holding") continue;
    if (c.source === "holding" && existing.source !== "holding") {
      deduped.set(c.ticker, c);
      continue;
    }
    if (candidateBaseRank(c) > candidateBaseRank(existing)) {
      deduped.set(c.ticker, c);
    }
  }

  const rejectedAddCandidates = [];
  const eligibleAddCandidates = [];
  for (const c of deduped.values()) {
    const rejectionReasons = candidateRejectionReasons(c);
    const eligible = rejectionReasons.length === 0;
    const priceGateReason = c.priceUsable ? null : "price is stale or unverified for funding";
    const rankScore = candidateBaseRank(c);
    const candidate = {
      ticker: c.ticker,
      name: c.name,
      source: c.source,
      sector: c.sector,
      rawAction: c.rawAction,
      v4_score: c.v4_score,
      upside_pct: c.upside_pct,
      fair_value_inr: c.fair_value_inr,
      current_price_inr: c.current_price_inr,
      valuation_confidence: c.valuation_confidence,
      valuation_source: c.valuation_source,
      valuation_band: c.valuation_band,
      market_cap_inr: c.market_cap_inr,
      marketCapBucket: c.marketCapBucket,
      smallcapPolicy: c.smallcapPolicy || buildSmallcapPolicy({
        marketCapInr: c.market_cap_inr,
        marketCapBucket: c.marketCapBucket,
        positionWeight: c.positionWeight,
      }),
      dataQualityGate: c.dataQualityGate,
      data_age_hours: c.data_age_hours,
      priceUsable: c.priceUsable,
      currentValue: Math.round(c.currentValue || 0),
      positionWeight: c.positionWeight,
      sectorWeight: c.sectorWeight,
      rankScore,
      status: eligible ? "eligible_unfunded" : "rejected",
      fundable: eligible && c.priceUsable,
      unfundedReasons: priceGateReason ? [priceGateReason] : [],
      rejectionReasons,
      whyFit: c.whyFit,
      newsSignal: c.newsSignal,
      blockedReasons: c.blockedReasons,
      displayActionIntent: c.displayActionIntent,
      reasonFamily: c.reasonFamily,
      _raw: c,
    };
    if (eligible) eligibleAddCandidates.push(candidate);
    else rejectedAddCandidates.push(candidate);
  }

  eligibleAddCandidates.sort((a, b) => b.rankScore - a.rankScore);

  const fresh = Math.max(0, Math.round(num(freshCapitalInr, 0)));
  const confirmedFreed = Math.max(0, Math.round(num(confirmedFreedCapitalInr, 0)));
  const availableBuyCapital = fresh + confirmedFreed;
  let remaining = availableBuyCapital;
  let deployedBuyCapital = 0;
  const fundedTrades = [];
  const workingSectorValues = new Map(sectorValues);
  const basePostTradeValue = Math.max(portfolioValue + fresh + confirmedFreed, portfolioValue);

  for (const c of eligibleAddCandidates) {
    if (fundedTrades.length >= MAX_FUNDED_ADDS) {
      c.unfundedReasons.push(`max ${MAX_FUNDED_ADDS} funded adds already selected`);
      continue;
    }
    if (!c.fundable) continue;
    const currentValue = num(c.currentValue, 0);
    const currentSectorValue = workingSectorValues.get(c.sector) || 0;
    const capPct = num(c.smallcapPolicy?.maxPositionWeightPct, MAX_POSITION_WEIGHT_PCT) || MAX_POSITION_WEIGHT_PCT;
    const roomPosition = Math.max(0, basePostTradeValue * (capPct / 100) - currentValue);
    const roomSector = Math.max(0, basePostTradeValue * (MAX_SECTOR_WEIGHT_PCT / 100) - currentSectorValue);
    const topUpPct = c.source === "holding" ? Math.max(parseTopUpPct(c.rawAction), 0.25) : 0;
    const targetPositionValue = c.source === "holding"
      ? Math.max(
          currentValue * (1 + topUpPct),
          basePostTradeValue * Math.min(MAX_POSITION_WEIGHT_PCT / 100, num(c.positionWeight, 0) / 100 + topUpPct * 0.03),
        )
      : basePostTradeValue * 0.03;
    const desiredGap = Math.max(0, targetPositionValue - currentValue);
    const tradeRupees = Math.round(Math.min(remaining, desiredGap, roomPosition, roomSector));

    if (tradeRupees >= MIN_FUNDED_TRADE_INR) {
      const postCurrentValue = currentValue + tradeRupees;
      const postSectorValue = currentSectorValue + tradeRupees;
      const fundedTrade = {
        ticker: c.ticker,
        name: c.name,
        source: c.source,
        side: "BUY",
        tradeRupees,
        rawAction: c.rawAction,
        fundedTrade: { side: "BUY", tradeRupees },
        rank: fundedTrades.length + 1,
        rankScore: c.rankScore,
        reason: `${c.valuation_band} with ${c.upside_pct?.toFixed?.(1) ?? c.upside_pct}% FV upside, v4 ${c.v4_score ?? "n/a"}, within ${c.marketCapBucket || "portfolio"} post-trade caps`,
        v4_score: c.v4_score,
        upside_pct: c.upside_pct,
        valuation_band: c.valuation_band,
        valuation_confidence: c.valuation_confidence,
        postTradePositionWeight: basePostTradeValue > 0 ? +((postCurrentValue / basePostTradeValue) * 100).toFixed(1) : null,
        postTradeSectorWeight: basePostTradeValue > 0 ? +((postSectorValue / basePostTradeValue) * 100).toFixed(1) : null,
      };
      fundedTrades.push(fundedTrade);
      c.status = "funded";
      c.fundedTrade = { side: "BUY", tradeRupees };
      c.tradeRupees = tradeRupees;
      remaining -= tradeRupees;
      deployedBuyCapital += tradeRupees;
      workingSectorValues.set(c.sector, postSectorValue);
    } else {
      c.unfundedReasons.push(capReason({ tradeRupees, roomPosition, roomSector, remaining, positionCapPct: capPct }));
    }
  }

  for (const c of eligibleAddCandidates) {
    delete c._raw;
    if (c.status === "eligible_unfunded" && c.unfundedReasons.length === 0) {
      c.unfundedReasons.push("ranked below funded candidates within today's budget");
    }
  }

  const fundedSells = [];
  const blockedReductionCandidates = [];
  for (const h of scoredHoldings) {
    const evidence = h?.reductionEvidence || h?.sws?.reduction_evidence || null;
    const requestedReduction = ALL_REDUCTION_ACTIONS.has(h?.action) || ALL_REDUCTION_ACTIONS.has(evidence?.requestedAction);
    if (!h?.swsCovered || !requestedReduction) continue;
    if (!ALL_REDUCTION_ACTIONS.has(h.action) || evidence?.status !== "confirmed") {
      blockedReductionCandidates.push({
        ticker: h.sws?.ticker || h.symbol || null,
        name: h.sws?.name || h.name || null,
        sector: h.sws?.sector || h.sector || null,
        rawAction: evidence?.requestedAction || h.action,
        displayActionIntent: h.displayActionIntent || "Review only",
        reasonFamily: h.reasonFamily || evidence?.intent || null,
        reductionEvidence: evidence,
        dataQualityGate: h.dataQualityGate || h.sws?.data_quality_gate || null,
        valuationReview: h.valuationReview || h.sws?.valuation_review || null,
        newsSignal: h.newsSignal || h.sws?.news_signal || null,
        blockedReasons: [...new Set([...(h.blockedReasons || []), ...(evidence?.blockedReasons || [])])],
        currentWeight: h.positionWeight ?? null,
        marketCapBucket: h.marketCapBucket || h.sws?.market_cap_bucket || null,
        decisionConfidence: h.decisionConfidence || evidence?.decisionConfidence || null,
      });
      continue;
    }
    if (evidence?.status !== "confirmed") continue;
    const tradeRupees = Math.round(num(h.trimRupees, 0) || num(h.freedRupees, 0) || num(h.currentValue, 0) * parseTrimPct(h.action));
    if (tradeRupees <= 0) continue;
    fundedSells.push({
      ticker: h.sws?.ticker || h.symbol || null,
      name: h.sws?.name || h.name || null,
      sector: h.sws?.sector || h.sector || null,
      side: "SELL",
      rawAction: h.action,
      tradeRupees,
      fundedTrade: { side: "SELL", tradeRupees },
      displayActionIntent: h.displayActionIntent || (String(h.action || "").startsWith("EXIT") ? "Exit thesis" : "Trim excess"),
      reasonFamily: h.reasonFamily || null,
      actionFactors: h.actionFactors || [],
      reductionEvidence: evidence,
      dataQualityGate: h.dataQualityGate || h.sws?.data_quality_gate || null,
      marketCapBucket: h.marketCapBucket || h.sws?.market_cap_bucket || null,
      smallcapPolicy: h.smallcapPolicy || h.sws?.smallcap_policy || null,
      counterEvidence: h.counterEvidence || [],
      decisionConfidence: h.decisionConfidence || null,
      valuationReview: h.valuationReview || h.sws?.valuation_review || null,
      newsSignal: h.newsSignal || h.sws?.news_signal || null,
      blockedReasons: h.blockedReasons || [],
      postTradeWeight: h.postTradeWeight ?? null,
      requiresConfirmation: h.requiresConfirmation !== false,
      note: "Suggested reduction candidate. Notional proceeds are not reused for buys until the user confirms the action.",
    });
  }

  const zeroStateReasons = [];
  if (availableBuyCapital < MIN_FUNDED_TRADE_INR) {
    zeroStateReasons.push(`Available buy capital below INR ${MIN_FUNDED_TRADE_INR.toLocaleString("en-IN")} minimum trade size.`);
  }
  if (eligibleAddCandidates.length === 0) {
    zeroStateReasons.push("No fundable replacement cleared score, valuation, surveillance, and near-term earnings gates.");
  }
  if (eligibleAddCandidates.length > 0 && fundedTrades.length === 0 && availableBuyCapital >= MIN_FUNDED_TRADE_INR) {
    const priceBlocked = eligibleAddCandidates.every((c) => !c.priceUsable);
    zeroStateReasons.push(priceBlocked ? "Eligible candidates have stale or unverified prices." : "Post-trade position or sector caps left no minimum-sized funded add.");
  }
  if (remaining > 0 && remaining < MIN_FUNDED_TRADE_INR) {
    zeroStateReasons.push(`Leftover cash is INR ${remaining.toLocaleString("en-IN")}, below the INR ${MIN_FUNDED_TRADE_INR.toLocaleString("en-IN")} minimum trade size.`);
  }

  return {
    version: "portfolio-construction-v1",
    capitalLedger: {
      userFreshCapitalInr: fresh,
      confirmedFreedCapitalInr: confirmedFreed,
      availableBuyCapital,
      deployedBuyCapital,
      leftoverCash: remaining,
      minTradeInr: MIN_FUNDED_TRADE_INR,
      note: "Today's suggested reductions are not counted as available buy capital until the user confirms them.",
    },
    constraints: {
      maxFundedAdds: MAX_FUNDED_ADDS,
      maxPositionWeightPct: MAX_POSITION_WEIGHT_PCT,
      maxSectorWeightPct: MAX_SECTOR_WEIGHT_PCT,
      minTradeInr: MIN_FUNDED_TRADE_INR,
      marketCapPositionCaps: {
        large: 8,
        mid: 6,
        small: 4,
        micro: 2.5,
      },
    },
    smallcapSleeve,
    fundedTrades,
    fundedSells,
    blockedReductionCandidates,
    eligibleAddCandidates,
    rejectedAddCandidates,
    summary: {
      fundedBuyCount: fundedTrades.length,
      fundedSellCount: fundedSells.length,
      blockedReductionCount: blockedReductionCandidates.length,
      eligibleUnfundedCount: eligibleAddCandidates.filter((c) => c.status !== "funded").length,
      rejectedCandidateCount: rejectedAddCandidates.length,
      totalBuyRupees: deployedBuyCapital,
      totalSellRupees: fundedSells.reduce((sum, s) => sum + num(s.tradeRupees, 0), 0),
    },
    zeroStateReasons,
  };
}
