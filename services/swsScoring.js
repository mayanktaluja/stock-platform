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

// ---------- v3 score: 50%-coverage-gated scorecard ----------
// Mirror of scripts/sws-scoring.mjs::computeV3Score. Kept in sync so that the
// runFullScoring pipeline and the live holding engine produce identical
// scores for the same stock. See the source file for the full design notes.

export function buildUniverseStats(stocks) {
  const r1m = [], r3m = [], r1y = [];
  for (const s of stocks) {
    const r = s?.overview?.returns_pct || {};
    if (typeof r["1M"] === "number" && Number.isFinite(r["1M"])) r1m.push(r["1M"]);
    if (typeof r["3M"] === "number" && Number.isFinite(r["3M"])) r3m.push(r["3M"]);
    if (typeof r["1Y"] === "number" && Number.isFinite(r["1Y"])) r1y.push(r["1Y"]);
  }
  r1m.sort((a, b) => a - b);
  r3m.sort((a, b) => a - b);
  r1y.sort((a, b) => a - b);
  return { r1m, r3m, r1y };
}

function _percentileRank(value, sorted) {
  if (value == null || !Number.isFinite(value) || !sorted?.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

export function computeV3Score(stock, opts = {}) {
  const ov = stock.overview || {};
  const snow = ov.snowflake || {};
  const universe = opts.universe || null;
  const surveillance = opts.surveillanceFlag ?? _getSurveillanceFlag(stock.ticker);

  const v_health = num(snow.financial_health ?? snow.health, 0);
  const v_future = num(snow.future ?? snow.future_growth, 0);
  const v_valuation = num(snow.valuation ?? snow.value, 0);
  const v_past = num(snow.past ?? snow.past_performance, 0);
  const v_dividends = num(snow.dividends ?? snow.dividend, 0);
  const pts_health = (v_health / 6) * 22;
  const pts_future = (v_future / 6) * 20;
  const pts_valuation = (v_valuation / 6) * 12;
  const pts_past = (v_past / 6) * 12;
  const pts_dividends = (v_dividends / 6) * 8;

  const upside = num(ov.upside_pct, null);
  let pts_fv_upside;
  let fv_imputed = false;
  if (upside == null) { pts_fv_upside = 6; fv_imputed = true; }
  else if (upside >= 30) pts_fv_upside = 12;
  else if (upside >= 15) pts_fv_upside = 9;
  else if (upside >= 0) pts_fv_upside = 6;
  else if (upside >= -10) pts_fv_upside = 3;
  else pts_fv_upside = 0;

  const r = ov.returns_pct || {};
  const ret1y = num(r["1Y"], null);
  const ret3m = num(r["3M"], null);
  const ret1m = num(r["1M"], null);
  const pct1y = universe ? _percentileRank(ret1y, universe.r1y) : null;
  const pct3m = universe ? _percentileRank(ret3m, universe.r3m) : null;
  const pct1m = universe ? _percentileRank(ret1m, universe.r1m) : null;
  const pts_mom_1y = (pct1y ?? 0.5) * 8;
  const pts_mom_3m = (pct3m ?? 0.5) * 4;
  const pts_mom_1m = (pct1m ?? 0.5) * 2;
  const momentum_imputed = !universe || pct1y == null || pct3m == null || pct1m == null;

  const continuous = pts_health + pts_future + pts_valuation + pts_past + pts_dividends
    + pts_fv_upside + pts_mom_1y + pts_mom_3m + pts_mom_1m;

  let pts_overlay = 0;
  const overlay_reasons = [];
  if (surveillance) {
    if (surveillance.list === "GSM") {
      pts_overlay -= 15;
      overlay_reasons.push("GSM surveillance");
    } else if (surveillance.list === "ASM") {
      const drop = surveillance.timeframe === "shortterm" ? 12 : 10;
      pts_overlay -= drop;
      overlay_reasons.push(`ASM surveillance (${surveillance.timeframe || "longterm"})`);
    }
  }
  if (ret1m != null && ret1m < -25 && v_health <= 2) {
    pts_overlay -= 5;
    overlay_reasons.push(`Falling knife: 1M ${ret1m.toFixed(1)}% with health ${v_health}/6`);
  }
  if (ret1m != null && ret1m > 30 && v_valuation <= 2) {
    pts_overlay -= 3;
    overlay_reasons.push(`Catalyst chase: 1M +${ret1m.toFixed(1)}% with valuation ${v_valuation}/6`);
  }
  pts_overlay = clamp(pts_overlay, -15, 0);

  const v3_score_100 = clamp(Math.round((continuous + pts_overlay) * 10) / 10, 0, 100);

  return {
    v3_score_100,
    v3_breakdown: {
      pts_health: Math.round(pts_health * 10) / 10,
      pts_future: Math.round(pts_future * 10) / 10,
      pts_valuation: Math.round(pts_valuation * 10) / 10,
      pts_past: Math.round(pts_past * 10) / 10,
      pts_dividends: Math.round(pts_dividends * 10) / 10,
      pts_fv_upside,
      fv_imputed,
      pts_mom_1y: Math.round(pts_mom_1y * 10) / 10,
      pts_mom_3m: Math.round(pts_mom_3m * 10) / 10,
      pts_mom_1m: Math.round(pts_mom_1m * 10) / 10,
      momentum_imputed,
      pts_overlay,
      overlay_reasons,
      surveillance: surveillance ? { list: surveillance.list, timeframe: surveillance.timeframe } : null,
    },
  };
}

export function verdictV3FromScore(score) {
  if (score >= 60) return "TOP_PICK";
  if (score >= 45) return "STRONG";
  if (score >= 30) return "ACCEPTABLE";
  if (score >= 22) return "WATCH";
  return "AVOID";
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

export function scoreStock(stock, opts = {}) {
  const sc = computeCompositeScore(stock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);
  stock.categories = categoriseStock(stock);
  const v2 = computeV2Score(stock);
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;
  // v3 — primary score for the live action engine. opts.universe must be
  // provided (loaded via swsHoldingEngine._loadV3Universe) for calibrated
  // momentum percentiles; without it, momentum points neutral-impute and
  // breakdown.momentum_imputed = true.
  const v3 = computeV3Score(stock, opts);
  stock.v3_score_100 = v3.v3_score_100;
  stock.v3_breakdown = v3.v3_breakdown;
  stock.v3_verdict = verdictV3FromScore(v3.v3_score_100);
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
    v3_score: stock.v3_score_100,
    v3_score_100: stock.v3_score_100,
    v3_breakdown: stock.v3_breakdown,
    v3_verdict: stock.v3_verdict,
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
