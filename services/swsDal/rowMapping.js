// Row-shape mapping between the on-disk JSON layout and the Drizzle
// column layout. Both directions:
//
//   * snapshotRowToJson(row)  — DB row → deep-file shape (matches what
//                                jsonBackend.getStockByTicker returns).
//   * deepJsonToColumns(deep) — deep-file JSON → column values for an
//                                INSERT/UPSERT into sws_company_snapshots.
//
// The DAL public API (services/swsDal/index.js) must produce identical
// shapes regardless of backend, so this mapping is the single source of
// truth for the deep-file ↔ DB translation.

function safeNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeInt(v) {
  const n = safeNum(v);
  return n == null ? null : Math.trunc(n);
}

function pickReturn(returns, key) {
  if (!returns || typeof returns !== "object") return null;
  return safeNum(returns[key]);
}

// ── DB row → deep-file JSON ─────────────────────────────────────────────
export function snapshotRowToJson(row) {
  if (!row) return null;
  const snowflake = {
    valuation: row.snowflakeValuation,
    future_growth: row.snowflakeFutureGrowth,
    past_performance: row.snowflakePastPerformance,
    financial_health: row.snowflakeFinancialHealth,
    dividends: row.snowflakeDividends,
    value: row.snowflakeValuation,
    future: row.snowflakeFutureGrowth,
    past: row.snowflakePastPerformance,
    health: row.snowflakeFinancialHealth,
    dividend: row.snowflakeDividends,
  };
  const recentPayments = row.recentDividendPayments || [];
  const dividend = {
    yield_pct: row.dividendYieldPct,
    payout_pct: row.payoutPct,
    annualized_dividend: row.annualizedDividend,
    listing_currency: "INR",
    recent_payments: recentPayments,
    payment_count: Array.isArray(recentPayments) ? recentPayments.length : 0,
  };
  const overview = {
    snowflake,
    snowflake_total: row.snowflakeTotal,
    current_price_inr: row.currentPriceInr,
    market_cap_inr: row.marketCapInr,
    market_cap_usd: row.marketCapUsd,
    market_cap_band: row.marketCapBand,
    shares_outstanding: row.sharesOutstanding,
    fair_value_inr: row.fairValueInr,
    fair_value_range_inr: row.rawExtra?.fair_value_range_inr ?? null,
    upside_pct: row.upsidePct,
    multiples: {
      pe: row.pe,
      ps: row.ps,
      pb: row.pb,
      ev_ebitda: row.evEbitda,
    },
    rewards: row.rewards || [],
    risks: row.risks || [],
    dividend,
    dividend_yield_pct: row.dividendYieldPct,
    net_margin_pct: row.netMarginPct,
    industry_benchmarks: row.industryBenchmarks || null,
    earnings_growth_yoy_pct: row.earningsGrowthYoyPct,
    forward_earnings_growth_pct: row.forwardEarningsGrowthPct,
    revenue_growth_pct: row.revenueGrowthPct,
    latest_revenue: row.latestRevenue,
    latest_net_income: row.latestNetIncome,
    latest_eps: row.latestEps,
    most_recent_reported_date: row.mostRecentReportedDate
      ? new Date(row.mostRecentReportedDate).toISOString()
      : null,
    returns_pct: {
      "1D": row.returns1dPct,
      "7D": row.returns7dPct,
      "1M": row.returns1mPct,
      "3M": row.returns3mPct,
      "6M": row.returns6mPct,
      "1Y": row.returns1yPct,
      "5Y": row.returns5yPct,
    },
    next_earnings_date: row.nextEarningsDate
      ? new Date(row.nextEarningsDate).toISOString()
      : null,
    recent_news_count: row.recentNewsCount,
    last_quarter_result: row.lastQuarterResult,
    recent_analyst_revisions: row.recentAnalystRevisions || null,
  };

  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    sws_url: row.rawExtra?.sws_url ?? null,
    parsed_at: row.parsedAt ? new Date(row.parsedAt).toISOString() : null,
    company_id: row.rawExtra?.company_id ?? null,
    classification_status: row.classificationStatus,
    overview,
    ownership: {
      top_holders: row.topHolders || [],
      insider_ownership_pct: row.insiderOwnershipPct,
      insider_activity: row.insiderActivity || null,
    },
    dividend,
    fiscal: row.fiscalYearlyHistory || {},
    indices: row.rawExtra?.indices ?? [],
    news: row.news || [],
    _api_raw_path: row.rawExtra?._api_raw_path ?? null,
  };
}

// ── deep-file JSON → column values ──────────────────────────────────────
export function deepJsonToColumns(deep, { runId } = {}) {
  if (!deep) return null;
  const overview = deep.overview || {};
  const snow = overview.snowflake || {};
  const multiples = overview.multiples || {};
  const dividend = overview.dividend || deep.dividend || {};
  const returns = overview.returns_pct || {};

  // Stash anything we don't promote to a column into raw_extra so a
  // round-trip preserves byte-equivalence after canonical re-serialisation.
  const rawExtra = {
    sws_url: deep.sws_url ?? null,
    company_id: deep.company_id ?? null,
    indices: deep.indices ?? [],
    fair_value_range_inr: overview.fair_value_range_inr ?? null,
    _api_raw_path: deep._api_raw_path ?? null,
  };

  return {
    runId,
    ticker: deep.ticker,
    name: deep.name ?? null,
    sector: deep.sector ?? null,
    classificationStatus: deep.classification_status ?? null,
    parsedAt: deep.parsed_at ? new Date(deep.parsed_at) : null,

    currentPriceInr: safeNum(overview.current_price_inr),
    marketCapInr: safeNum(overview.market_cap_inr),
    marketCapUsd: safeNum(overview.market_cap_usd),
    marketCapBand: overview.market_cap_band ?? null,
    sharesOutstanding: safeNum(overview.shares_outstanding),
    fairValueInr: safeNum(overview.fair_value_inr),
    upsidePct: safeNum(overview.upside_pct),

    snowflakeTotal: safeInt(overview.snowflake_total),
    snowflakeValuation: safeInt(snow.valuation ?? snow.value),
    snowflakeFutureGrowth: safeInt(snow.future_growth ?? snow.future),
    snowflakePastPerformance: safeInt(snow.past_performance ?? snow.past),
    snowflakeFinancialHealth: safeInt(snow.financial_health ?? snow.health),
    snowflakeDividends: safeInt(snow.dividends ?? snow.dividend),

    pe: safeNum(multiples.pe),
    pb: safeNum(multiples.pb),
    ps: safeNum(multiples.ps),
    evEbitda: safeNum(multiples.ev_ebitda),

    returns1dPct: pickReturn(returns, "1D"),
    returns7dPct: pickReturn(returns, "7D"),
    returns1mPct: pickReturn(returns, "1M"),
    returns3mPct: pickReturn(returns, "3M"),
    returns6mPct: pickReturn(returns, "6M"),
    returns1yPct: pickReturn(returns, "1Y"),
    returns5yPct: pickReturn(returns, "5Y"),

    netMarginPct: safeNum(overview.net_margin_pct),
    revenueGrowthPct: safeNum(overview.revenue_growth_pct),
    earningsGrowthYoyPct: safeNum(overview.earnings_growth_yoy_pct),
    forwardEarningsGrowthPct: safeNum(overview.forward_earnings_growth_pct),

    latestRevenue: safeNum(overview.latest_revenue ?? deep.fiscal?.latest_revenue),
    latestNetIncome: safeNum(overview.latest_net_income ?? deep.fiscal?.latest_net_income),
    latestEps: safeNum(overview.latest_eps),
    mostRecentReportedDate: overview.most_recent_reported_date
      ? new Date(overview.most_recent_reported_date)
      : deep.fiscal?.most_recent_reported_date
        ? new Date(deep.fiscal.most_recent_reported_date)
        : null,

    dividendYieldPct: safeNum(dividend.yield_pct ?? overview.dividend_yield_pct),
    payoutPct: safeNum(dividend.payout_pct),
    annualizedDividend: safeNum(dividend.annualized_dividend),

    nextEarningsDate: overview.next_earnings_date
      ? new Date(overview.next_earnings_date)
      : null,
    recentNewsCount: safeInt(overview.recent_news_count),
    insiderOwnershipPct: safeNum(deep.ownership?.insider_ownership_pct),
    lastQuarterResult: overview.last_quarter_result ?? null,

    news: deep.news ?? [],
    topHolders: deep.ownership?.top_holders ?? [],
    recentDividendPayments: dividend.recent_payments ?? [],
    fiscalYearlyHistory: deep.fiscal ?? {},
    rewards: overview.rewards ?? [],
    risks: overview.risks ?? [],
    industryBenchmarks: overview.industry_benchmarks ?? null,
    insiderActivity: deep.ownership?.insider_activity ?? null,
    recentAnalystRevisions: overview.recent_analyst_revisions ?? null,
    rawExtra,
  };
}

// ── Picks: row → JSON pick card ─────────────────────────────────────────
export function pickRowToCard(row) {
  if (!row) return null;
  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    sws_url: row.swsUrl,
    score: row.score,
    v2_score: row.v2Score,
    v3_score: row.v3Score,
    v3_score_100: row.v3Score100,
    v3_verdict: row.v3Verdict,
    verdict: row.verdict,
    composite_verdict: row.compositeVerdict,
    valuation_band: row.valuationBand,
    snowflake_total: row.snowflakeTotal,
    snowflake: row.snowflake ?? null,
    current_price_inr: row.currentPriceInr,
    fair_value_inr: row.fairValueInr,
    upside_pct: row.upsidePct,
    market_cap_inr: row.marketCapInr,
    last_quarter_result: row.lastQuarterResult,
    next_earnings_date: row.nextEarningsDate
      ? new Date(row.nextEarningsDate).toISOString()
      : null,
    v2_breakdown: row.v2Breakdown ?? null,
    v3_breakdown: row.v3Breakdown ?? null,
    audit_trail: row.auditTrail ?? null,
    counter_thesis: row.counterThesis ?? null,
    narrative: row.narrative ?? null,
    section_status: row.sectionStatus ?? null,
    earnings_beat_meta: row.earningsBeatMeta ?? null,
    surveillance: row.surveillance ?? null,
  };
}

// ── Picks: JSON pick card → row (for INSERT/UPDATE) ─────────────────────
export function pickCardToRow(card, { runId, section, rank }) {
  return {
    runId,
    ticker: card.ticker,
    section,
    rankInSection: rank,
    name: card.name ?? null,
    sector: card.sector ?? null,
    swsUrl: card.sws_url ?? null,
    score: safeNum(card.score),
    v2Score: safeNum(card.v2_score),
    v3Score: safeNum(card.v3_score),
    v3Score100: safeNum(card.v3_score_100),
    v3Verdict: card.v3_verdict ?? null,
    verdict: card.verdict ?? null,
    compositeVerdict: card.composite_verdict ?? null,
    valuationBand: card.valuation_band ?? null,
    snowflakeTotal: safeInt(card.snowflake_total),
    currentPriceInr: safeNum(card.current_price_inr),
    fairValueInr: safeNum(card.fair_value_inr),
    upsidePct: safeNum(card.upside_pct),
    marketCapInr: safeNum(card.market_cap_inr),
    lastQuarterResult: card.last_quarter_result ?? null,
    nextEarningsDate: card.next_earnings_date ? new Date(card.next_earnings_date) : null,
    snowflake: card.snowflake ?? null,
    v2Breakdown: card.v2_breakdown ?? null,
    v3Breakdown: card.v3_breakdown ?? null,
    auditTrail: card.audit_trail ?? null,
    counterThesis: card.counter_thesis ?? null,
    narrative: card.narrative ?? null,
    sectionStatus: card.section_status ?? null,
    earningsBeatMeta: card.earnings_beat_meta ?? null,
    surveillance: card.surveillance ?? null,
  };
}
