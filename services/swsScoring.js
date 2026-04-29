// Pure scoring primitives for SWS-scraped per-stock JSONs.
// Extracted from scripts/sws-scoring.mjs so server-side code (e.g. the
// portfolio analyzer) can score on demand without dragging in CLI/file-I/O.
//
// Inputs: per-stock objects matching data/sws/deep/{TICKER}.json schema.
// Outputs: composite_score_100 (v1), verdict, categories, v2_score_100, v2_breakdown.

let _getSurveillanceFlag = () => null;
try {
  const mod = await import("../surveillance.js");
  if (typeof mod.getSurveillanceFlag === "function") _getSurveillanceFlag = mod.getSurveillanceFlag;
} catch {}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// Insider counter mirrors scripts/sws-scoring.mjs production behavior so the
// portfolio analyzer and the picks-latest scorer stay numerically identical.
export function _countInsiderBuys(stock) {
  const ov = stock.overview || {};
  return (ov.insider_activity || []).filter((x) => x?.direction === "buy").length;
}

export function computeCompositeScore(stock) {
  const ov = stock.overview || {};
  const snowTotal = num(ov.snowflake_total, 0);
  const upside = num(ov.upside_pct, 0);
  const risks = (ov.risks || []).length;
  const netMargin = num(ov.net_margin_pct, 0);
  const ret5y = num((ov.returns_pct || {})["5Y"], 0);
  const fwdGrowth = num(ov.forward_earnings_growth_pct, null);
  const fwdGrowthFromReward = (() => {
    if (fwdGrowth != null) return fwdGrowth;
    for (const r of (ov.rewards || [])) {
      const m = String(r).match(/forecast to grow ([\d.]+)\s*%\s*per year/i);
      if (m) return Number(m[1]);
    }
    return 0;
  })();
  const divYield = num(ov.dividend && ov.dividend.yield_pct, 0);
  const divPayout = num(ov.dividend && ov.dividend.payout_pct, 100);
  const divSnow = num((ov.snowflake || {}).dividends, 0);
  const insiderBuys = _countInsiderBuys(stock);

  const pts_snowflake = (snowTotal / 30) * 35;
  const pts_upside = clamp(upside, 0, 50) / 50 * 20;
  const pts_risks = -clamp(risks, 0, 5) * 3;
  const pts_margin = clamp(netMargin, 0, 30) / 30 * 10;
  const pts_ret5y = clamp(ret5y, 0, 200) / 200 * 10;
  const pts_growth = clamp(fwdGrowthFromReward, 0, 25) / 25 * 15;
  const pts_dividend = (divSnow >= 5 && divPayout < 70 && divYield >= 1.5) ? 5 : 0;
  const pts_insider = insiderBuys >= 1 ? 5 : 0;

  const total = pts_snowflake + pts_upside + pts_risks + pts_margin + pts_ret5y + pts_growth + pts_dividend + pts_insider;
  const composite_score_100 = clamp(Math.round(total * 10) / 10, 0, 100);

  return {
    composite_score_100,
    breakdown: {
      pts_snowflake: Math.round(pts_snowflake * 10) / 10,
      pts_upside: Math.round(pts_upside * 10) / 10,
      pts_risks: Math.round(pts_risks * 10) / 10,
      pts_margin: Math.round(pts_margin * 10) / 10,
      pts_ret5y: Math.round(pts_ret5y * 10) / 10,
      pts_growth: Math.round(pts_growth * 10) / 10,
      pts_dividend,
      pts_insider,
    },
    forward_growth_used_pct: fwdGrowthFromReward,
  };
}

export function verdictFromScore(score) {
  if (score >= 72) return "DEEP_VALUE";
  if (score >= 62) return "QUALITY_GROWTH";
  if (score >= 48) return "FAIR_VALUE";
  if (score >= 40) return "FULLY_VALUED";
  return "OVERVALUED";
}

export function computeV2Score(stock, opts = {}) {
  const v1 = num(stock.composite_score_100, 0);
  const ov = stock.overview || {};
  const surveillance = opts.surveillanceFlag ?? _getSurveillanceFlag(stock.ticker);

  let pts_catalyst = 0;
  const next = ov.next_earnings_date;
  if (next) {
    const days = Math.ceil((new Date(next + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 30 && ov.last_quarter_result === "beat") pts_catalyst += 3;
  }
  const insiderBuys = _countInsiderBuys(stock);
  if (insiderBuys >= 1) pts_catalyst += 2;
  const recentUpgrade = (ov.recent_analyst_revisions || []).some((r) => r.direction === "increased");
  if (recentUpgrade) pts_catalyst += 2;
  pts_catalyst = clamp(pts_catalyst, 0, 5);

  let pts_risk_overlay = 0;
  if (surveillance) {
    if (surveillance.list === "GSM") pts_risk_overlay -= 10;
    else if (surveillance.list === "ASM") {
      pts_risk_overlay -= surveillance.timeframe === "shortterm" ? 8 : 5;
    }
  }
  const beta = num(ov.beta, null);
  if (beta != null && beta > 1.5) pts_risk_overlay -= 3;
  const risks = (ov.risks || []).length;
  if (risks >= 4) pts_risk_overlay -= 3;
  pts_risk_overlay = clamp(pts_risk_overlay, -15, 0);

  const v2_score_100 = clamp(Math.round((v1 + pts_catalyst + pts_risk_overlay) * 10) / 10, 0, 100);

  return {
    v2_score_100,
    v2_breakdown: {
      v1_fundamentals: Math.round(v1 * 10) / 10,
      pts_catalyst,
      pts_risk_overlay,
      surveillance: surveillance ? { list: surveillance.list, timeframe: surveillance.timeframe } : null,
      beta_flag: beta != null && beta > 1.5,
      risks_flag: risks >= 4,
    },
  };
}

export function categoriseStock(stock) {
  const ov = stock.overview || {};
  const verdict = stock.verdict;
  const snowTotal = num(ov.snowflake_total, 0);
  const upside = num(ov.upside_pct, 0);
  const ret1y = num((ov.returns_pct || {})["1Y"], -100);
  const ret5y = num((ov.returns_pct || {})["5Y"], 0);
  const epsGrowth5y = (() => {
    for (const r of (ov.rewards || [])) {
      const m = String(r).match(/grown? ([\d.]+)\s*%\s*per year over the past 5 years/i);
      if (m) return Number(m[1]);
    }
    return null;
  })();
  const fwdGrowth = num(stock.forward_growth_used_pct, 0);
  const risks = (ov.risks || []).length;
  const divYield = num(ov.dividend && ov.dividend.yield_pct, 0);
  const divPayout = num(ov.dividend && ov.dividend.payout_pct, 100);
  const divSnow = num((ov.snowflake || {}).dividends, 0);
  const valSnow = num((ov.snowflake || {}).valuation, 0);
  const healthSnow = num((ov.snowflake || {}).financial_health, 0);
  const mcap = num(ov.market_cap_inr, 0);
  const insiderBuys = _countInsiderBuys(stock);
  const nextEarnings = ov.next_earnings_date;

  const cats = [];

  if (verdict === "DEEP_VALUE" && valSnow >= 4 && upside >= 20) cats.push("deep_value");
  if (["DEEP_VALUE", "QUALITY_GROWTH"].includes(verdict) && healthSnow >= 5 && (epsGrowth5y == null ? ret5y > 0 : epsGrowth5y > 0)) {
    cats.push("quality_growth");
  }
  if (ret1y > 0 && upside >= 15 && risks === 0 && fwdGrowth >= 8) cats.push("midterm");
  if (divSnow >= 5 && divPayout < 70 && divYield >= 1.5) cats.push("dividend_aristocrats");
  if (mcap > 0 && mcap < 5e11 && snowTotal >= 22 && upside >= 15) cats.push("smallcap_gems");
  if (insiderBuys >= 1) cats.push("insider_buying");
  if (nextEarnings) {
    const days = Math.ceil((new Date(nextEarnings + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 30) cats.push("upcoming_earnings");
  }
  if (snowTotal < 12 && risks >= 3) cats.push("avoid");

  return cats;
}

export function scoreStock(stock) {
  const sc = computeCompositeScore(stock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);
  stock.categories = categoriseStock(stock);
  const v2 = computeV2Score(stock);
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;
  return stock;
}

function shortReason(stock) {
  const ov = stock.overview || {};
  const bits = [];
  const pe = ov.multiples && ov.multiples.pe;
  if (pe != null) bits.push(`P/E ${pe.toFixed(1)}x`);
  if (ov.upside_pct != null) bits.push(`${ov.upside_pct > 0 ? "+" : ""}${ov.upside_pct.toFixed(1)}% to fair value`);
  const dY = ov.dividend && ov.dividend.yield_pct;
  if (dY != null && dY >= 1.5) bits.push(`${dY.toFixed(1)}% div`);
  const sn = ov.snowflake_total;
  if (sn != null) bits.push(`snow ${sn}/30`);
  return bits.slice(0, 4).join(" · ");
}

export function pickCardFields(stock) {
  const ov = stock.overview || {};
  return {
    ticker: stock.ticker,
    name: stock.name || stock.ticker,
    sector: stock.sector || null,
    sws_url: stock.sws_url || null,
    score: stock.composite_score_100,
    v2_score: stock.v2_score_100,
    v2_breakdown: stock.v2_breakdown,
    verdict: stock.verdict,
    snowflake_total: ov.snowflake_total,
    snowflake: ov.snowflake,
    current_price_inr: ov.current_price_inr,
    fair_value_inr: ov.fair_value_inr,
    upside_pct: ov.upside_pct,
    market_cap_inr: ov.market_cap_inr,
    next_earnings_date: ov.next_earnings_date,
    last_quarter_result: ov.last_quarter_result,
    one_line: shortReason(stock),
    data_freshness_at: stock.parsed_at || null,
  };
}

export function buildLeaderboard(scoredStocks) {
  const ordered = [...scoredStocks].sort((a, b) => (b.composite_score_100 || 0) - (a.composite_score_100 || 0));

  const bestToBuy = ordered
    .filter((s) => (s.overview?.risks?.length ?? 0) === 0 && (s.overview?.snowflake_total ?? 0) >= 18)
    .slice(0, 25)
    .map(pickCardFields);

  const cat = (key) => ordered.filter((s) => (s.categories || []).includes(key)).map(pickCardFields);

  const upcoming = ordered
    .filter((s) => (s.categories || []).includes("upcoming_earnings"))
    .sort((a, b) => (a.overview?.next_earnings_date || "9999").localeCompare(b.overview?.next_earnings_date || "9999"))
    .map((s) => {
      const c = pickCardFields(s);
      const d = s.overview?.next_earnings_date;
      c.days_until = d ? Math.ceil((new Date(d + "T00:00:00Z") - new Date()) / 86400000) : null;
      c.recent_analyst_revisions = s.overview?.recent_analyst_revisions || [];
      return c;
    });

  const MIN_MCAP_INR = 5_000_000_000;
  const orderedV2 = [...scoredStocks].sort((a, b) => (b.v2_score_100 || 0) - (a.v2_score_100 || 0));
  const top30 = orderedV2
    .filter((s) => {
      const mcap = num(s.overview?.market_cap_inr, 0);
      if (mcap < MIN_MCAP_INR) return false;
      const surv = s.v2_breakdown?.surveillance;
      if (surv && surv.list === "GSM") return false;
      return true;
    })
    .slice(0, 30)
    .map(pickCardFields);

  return {
    top_ranked_30: top30,
    best_to_buy_now: bestToBuy,
    deep_value: cat("deep_value"),
    quality_growth: cat("quality_growth"),
    midterm: cat("midterm"),
    dividend_aristocrats: cat("dividend_aristocrats"),
    smallcap_gems: cat("smallcap_gems"),
    insider_buying: cat("insider_buying"),
    upcoming_earnings: upcoming,
    avoid: cat("avoid"),
  };
}
