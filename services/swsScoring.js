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

import { computeV4Score, verdictV4FromScore } from "./swsScoringV4.js";

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// Schema/scoring versions emitted in picks-latest.json so external readers
// (UI, audit consumers, partner dashboards) can detect a model migration.
// Bump PICKS_SCHEMA_VERSION on a breaking field rename; bump
// PICKS_SCORING_VERSION when the scoring math changes (weights, gates,
// imputation rules).
export const PICKS_SCHEMA_VERSION = "picks-latest-v3";
export const PICKS_SCORING_VERSION = "sws-v4-100pt-2026-05";

// 13 input fields the scoring engine looks at. Track which were populated
// so we can flag thin-coverage names rather than silently scoring missing
// inputs as zero (which biases the composite toward the 40-50 band).
const _COMPLETENESS_FIELDS = 13;
export function dataCompletenessPct(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const r = ov.returns_pct || {};
  const isFin = (v) => typeof v === "number" && Number.isFinite(v);
  const populated = [
    isFin(sn.financial_health ?? sn.health),
    isFin(sn.future ?? sn.future_growth),
    isFin(sn.valuation ?? sn.value),
    isFin(sn.past ?? sn.past_performance),
    isFin(sn.dividends ?? sn.dividend),
    isFin(ov.upside_pct),
    isFin(r["1Y"]),
    isFin(r["3M"]),
    isFin(r["1M"]),
    isFin(ov.net_margin_pct),
    isFin(ov.multiples?.pe),
    isFin(ov.dividend?.yield_pct),
    isFin(ov.market_cap_inr),
  ].filter(Boolean).length;
  return Math.round((populated / _COMPLETENESS_FIELDS) * 100);
}

// Lite counter-thesis emitter for the static picks file. The full conviction
// engine (services/swsCounterThesis.js) needs holding-level layer outputs we
// don't compute in the universe scan; this builder works with the inputs the
// picks pipeline already has — overview, snowflake, v3 breakdown.
//
// Always emit something — silence is a worse compliance posture than a
// generic note. SEBI-style analyst convention: name 2-4 specific opposing
// signals + 2-4 observable falsification triggers.
export function buildPickCounterThesis(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const v4 = stock.v4_breakdown || {};
  const verdict = stock.v4_verdict || "WATCH";
  const isBull = verdict === "TOP_PICK" || verdict === "STRONG";
  const isBear = verdict === "AVOID";

  const opposing = [];
  if (isBull) {
    const risksCount = (ov.risks || []).length;
    if (risksCount >= 4) opposing.push(`${risksCount} flagged risks in SWS profile`);
    if (v4.surveillance) opposing.push(`stock is on NSE ${v4.surveillance.list} surveillance`);
    if (v4.fv_imputed) opposing.push(`fair-value upside imputed (no SWS analyst FV) — score may overstate price-vs-FV cushion`);
    const valSnow = num(sn.valuation ?? sn.value, 6);
    if (valSnow <= 2) opposing.push(`valuation pillar weak (${valSnow}/6) despite overall ${verdict}`);
    if (num(ov.upside_pct, 0) < 0) opposing.push(`current price already above SWS analyst FV (${num(ov.upside_pct, 0).toFixed(1)}%)`);
    const ret1m = num((ov.returns_pct || {})["1M"], null);
    if (ret1m != null && ret1m > 25) opposing.push(`+${ret1m.toFixed(1)}% in 1M — momentum chase risk`);
    if (ov.next_earnings_date) {
      const days = Math.ceil((new Date(ov.next_earnings_date + "T00:00:00Z") - new Date()) / 86400000);
      if (days >= 0 && days <= 14) opposing.push(`earnings in ${days}d — binary event`);
    }
  } else if (isBear) {
    if (num(ov.snowflake_total, 0) >= 18) opposing.push(`snowflake ${ov.snowflake_total}/30 still solid despite AVOID verdict`);
    if (num(ov.upside_pct, 0) >= 30) opposing.push(`+${num(ov.upside_pct, 0).toFixed(1)}% to SWS FV — discount may price the negatives in`);
    const insiderBuys = (ov.insider_activity || []).filter((x) => x?.direction === "buy").length;
    if (insiderBuys >= 1) opposing.push(`${insiderBuys} insider buy(s) on file`);
    if ((ov.recent_analyst_revisions || []).some((r) => r.direction === "increased")) opposing.push(`recent analyst PT raise — broker view diverges`);
    const ret1y = num((ov.returns_pct || {})["1Y"], null);
    if (ret1y != null && ret1y > 20) opposing.push(`+${ret1y.toFixed(1)}% over 1Y — trend is up despite verdict`);
  } else {
    if (num(ov.snowflake_total, 0) >= 22) opposing.push(`snowflake ${ov.snowflake_total}/30 above ACCEPTABLE cut`);
    if ((ov.risks || []).length >= 4) opposing.push(`${(ov.risks || []).length} flagged risks weigh against any optimistic read`);
  }

  const text = opposing.length === 0
    ? `No strong opposing signal in the layer outputs — single-source view; verify thesis independently before acting.`
    : opposing.join("; ") + ".";

  const triggers = [];
  if (isBull) {
    triggers.push("next quarterly result misses estimates");
    triggers.push("a new India-risk overlay materialises (ASM/GSM, promoter pledge spike)");
    if (num(ov.upside_pct, 0) > 20) triggers.push(`upside vs SWS FV compresses below 5% (currently ${num(ov.upside_pct, 0).toFixed(1)}%)`);
    else triggers.push("snowflake total drops by ≥ 4 points on next refresh");
  } else if (isBear) {
    triggers.push("next quarterly result beats consensus by ≥ 10%");
    triggers.push("a new analyst PT is raised by ≥ 15%");
    if (v4.surveillance) triggers.push(`NSE removes the ${v4.surveillance.list} surveillance flag`);
    else triggers.push("snowflake total rebounds above 22 on next refresh");
  } else {
    triggers.push("a material catalyst lands in the next 30 days (PT raise / beat / surveillance change)");
    triggers.push("v4 score moves into TOP_PICK (≥59) or AVOID (<28) on next refresh");
  }

  return {
    verdict_bias: isBull ? "bullish" : isBear ? "bearish" : "neutral",
    text,
    falsification_trigger: triggers,
  };
}

// Slim per-pick audit blob. Captures the inputs that drove the score so a
// compliance-style review can reconstruct the verdict from the static file
// without hitting the live API. Adds ~250 bytes per pick.
export function buildPickAuditTrail(stock) {
  const ov = stock.overview || {};
  const r = ov.returns_pct || {};
  return {
    scoring_version: PICKS_SCORING_VERSION,
    inputs_used: {
      snowflake_total: ov.snowflake_total ?? null,
      upside_pct: ov.upside_pct ?? null,
      returns_1y: r["1Y"] ?? null,
      returns_3m: r["3M"] ?? null,
      returns_1m: r["1M"] ?? null,
      risks_count: (ov.risks || []).length,
      surveillance: stock.v2_breakdown?.surveillance || null,
      market_cap_inr: ov.market_cap_inr ?? null,
    },
    imputations: {
      fv_imputed: stock.v4_breakdown?.fv_imputed || false,
      momentum_imputed: stock.v4_breakdown?.momentum_imputed || false,
    },
    categories_assigned: stock.categories || [],
  };
}

const PICK_RETURN_KEYS = ["1D", "7D", "1M", "3M", "1Y"];

export function compactReturnsPct(returnsPct = {}) {
  const out = {};
  for (const key of PICK_RETURN_KEYS) {
    const v = returnsPct?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

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

export function _percentileRank(value, sorted) {
  if (value == null || !Number.isFinite(value) || !sorted?.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

// V3 scoring (computeV3Score / verdictV3FromScore) was REMOVED in the 2026-05
// V3→V4 migration. V4 (services/swsScoringV4.js::computeV4Score +
// verdictV4FromScore) is now the platform's sole composite score. The momentum
// helpers above (buildUniverseStats / _percentileRank) are shared and reused
// by V4 unchanged.

// PR 2.3 — `valuation_band` is a SEPARATE signal from the composite-score
// verdict. Composite (TOP_PICK/STRONG/…) describes overall multi-factor
// quality; `valuation_band` describes price vs AnalystConsensus FV ONLY.
// Surfacing both prevents the contradiction users complained about
// (HEROMOTOCO showing `verdict=OVERVALUED` and `v4_verdict=TOP_PICK` under a
// single "Verdict" UI label).
export function valuationBandFromUpside(upside) {
  if (upside == null || !Number.isFinite(upside)) return null;
  if (upside >= 25) return "DEEP_DISCOUNT";
  if (upside >= 10) return "DISCOUNT";
  if (upside >= -5) return "FAIR";
  if (upside >= -20) return "PREMIUM";
  return "EXPENSIVE";
}

// v3-aware categorisation — mirror of scripts/sws-scoring.mjs::categoriseStock.
// Gates use stock.v4_verdict and snowflake pillars instead of v1's verdict
// labels and the forward-earnings-growth field, which is null for ~98% of
// the universe under the current SWS API capture.
export function categoriseStock(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const v4Verdict = stock.v4_verdict || "WATCH";
  const upsideRaw = num(ov.upside_pct, null);
  const upside = upsideRaw != null ? upsideRaw : 0;
  const hasUpside = upsideRaw != null;
  const ret1y = num((ov.returns_pct || {})["1Y"], null);
  const ret3m = num((ov.returns_pct || {})["3M"], null);
  const valSnow = num(sn.valuation ?? sn.value, 0);
  const futureSnow = num(sn.future ?? sn.future_growth, 0);
  const healthSnow = num(sn.financial_health ?? sn.health, 0);
  const divSnow = num(sn.dividends ?? sn.dividend, 0);
  const snowTotal = num(ov.snowflake_total, 0);
  const divYield = num(ov.dividend?.yield_pct, 0);
  const divPayout = num(ov.dividend?.payout_pct, 100);
  const mcap = num(ov.market_cap_inr, 0);
  const risks = (ov.risks || []).length;
  const insiderBuys = _countInsiderBuys(stock);
  const nextEarnings = ov.next_earnings_date;

  const cats = [];

  if (v4Verdict === "TOP_PICK" && valSnow >= 4 && hasUpside && upside >= 20) cats.push("deep_value");
  if (["TOP_PICK", "STRONG"].includes(v4Verdict) && healthSnow >= 5 && futureSnow >= 4) cats.push("quality_growth");
  const positiveMomentum = (ret1y != null && ret1y > 0) || (ret3m != null && ret3m > 5);
  if (["TOP_PICK", "STRONG", "ACCEPTABLE"].includes(v4Verdict) && positiveMomentum && hasUpside && upside >= 15 && futureSnow >= 3) cats.push("midterm");
  // PR 2.6 — dividend list now requires a value floor. Without it the section
  // surfaced OVERVALUED + negative-upside names (NATIONALUM −5.9%, etc.) just
  // because their dividend snowflake was strong. The value gate (upside ≥ 0
  // OR valuation snowflake ≥ 4) keeps the list anchored to "good payers AND
  // not crazy expensive".
  if (
    divSnow >= 5 &&
    divPayout < 70 &&
    divYield >= 1.5 &&
    (upside >= 0 || valSnow >= 4)
  ) {
    cats.push("dividend_aristocrats");
  }
  // True smallcap gate — 1.5e11 (₹15,000 cr) aligns with NSE smallcap (rank
  // 251+). The earlier 5e11 (₹50,000 cr) threshold mislabelled mid-caps as
  // smallcap, which contradicted the section header.
  if (mcap > 0 && mcap < 1.5e11 && snowTotal >= 22 && hasUpside && upside >= 15) cats.push("smallcap_gems");
  if (insiderBuys >= 1) cats.push("insider_buying");
  if (nextEarnings) {
    const days = Math.ceil((new Date(nextEarnings + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 75) cats.push("upcoming_earnings");
  }
  // Avoid: v3 AVOID + mcap ≥ ₹500cr (filter illiquid micro-caps). Backstop
  // branch keeps genuinely terrible large-caps surfacing even if v4_verdict
  // somehow doesn't say AVOID.
  if ((v4Verdict === "AVOID" && mcap >= 5e9) || (snowTotal < 12 && risks >= 3)) cats.push("avoid");

  return cats;
}

export function scoreStock(stock, opts = {}) {
  const sc = computeCompositeScore(stock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);
  const v2 = computeV2Score(stock);
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;
  // v4 — the platform's sole composite score. opts.universe must be provided
  // (loaded via swsHoldingEngine.loadV3Universe) for calibrated momentum
  // percentiles; without it momentum neutral-imputes. Verdict is absolute.
  const v4 = computeV4Score(stock, opts);
  stock.v4_score_100 = v4.v4_score_100;
  stock.v4_breakdown = v4.v4_breakdown;
  stock.v4_verdict = verdictV4FromScore(v4.v4_score_100);
  // Categorise AFTER v4 — categories key off v4_verdict.
  stock.categories = categoriseStock(stock);
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
    v4_score: stock.v4_score_100,
    v4_score_100: stock.v4_score_100,
    v4_breakdown: stock.v4_breakdown,
    v4_verdict: stock.v4_verdict,
    verdict: stock.verdict,
    // PR 2.3 — explicitly named aliases. UI prefers these over the legacy
    // `verdict` / `v4_verdict` fields so the two signals can never be
    // collapsed into a single ambiguous badge:
    //   composite_verdict: multi-factor quality (TOP_PICK / STRONG / …)
    //   valuation_band:    price vs AnalystConsensus FV (DISCOUNT / FAIR / …)
    composite_verdict: stock.v4_verdict,
    valuation_band: valuationBandFromUpside(ov.upside_pct),
    snowflake_total: ov.snowflake_total,
    snowflake: ov.snowflake,
    current_price_inr: ov.current_price_inr,
    fair_value_inr: ov.fair_value_inr,
    upside_pct: ov.upside_pct,
    market_cap_inr: ov.market_cap_inr,
    returns_pct: compactReturnsPct(ov.returns_pct),
    next_earnings_date: ov.next_earnings_date,
    last_quarter_result: ov.last_quarter_result,
    one_line: shortReason(stock),
    data_freshness_at: stock.parsed_at || null,
    // % of 13 input fields the scorer had to work with. UI flags <60 as
    // "thin coverage" so missing inputs don't get silently scored as zero.
    data_completeness_pct: dataCompletenessPct(stock),
    // Balanced rationale — the case against the call + observable events
    // that would reverse it. Always emitted (never null).
    counter_thesis: buildPickCounterThesis(stock),
    // Per-pick audit blob — slim, self-contained, ~250 bytes.
    audit_trail: buildPickAuditTrail(stock),
  };
}

export function buildLeaderboard(scoredStocks) {
  // PR 2.5 — single canonical v3 sort (was previously: v1 composite for the
  // base list, v2 re-sort for top_ranked_30, v3 verdict for category gates —
  // three score versions across one function). Every section now reads from
  // `ordered`, which is v3-descending; top_ranked_30 slices from the same
  // list instead of building its own v2 sort.
  //
  // PR 2.7 — drop pure-numeric BSE codes (e.g. "538992") at the universe
  // boundary so they never appear in any section.
  const isPureBSEcode = (t) => typeof t === "string" && /^\d+$/.test(t);
  const ordered = [...scoredStocks]
    .filter((s) => !isPureBSEcode(s.ticker))
    .sort((a, b) => (b.v4_score_100 || 0) - (a.v4_score_100 || 0));

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
  const hygiene = (s) => {
    const mcap = num(s.overview?.market_cap_inr, 0);
    if (mcap < MIN_MCAP_INR) return false;
    const surv = s.v2_breakdown?.surveillance;
    if (surv && surv.list === "GSM") return false;
    return true;
  };
  const top30 = ordered.filter(hygiene).slice(0, 30).map(pickCardFields);

  // Best Fundamentals — matches the score-breakdown modal's "Fundamentals 74"
  // line exactly: 5 SWS pillars + AnalystConsensus FV upside (max 74 label,
  // theoretical max 86 when FV upside is at +12). Same hygiene gate as Top
  // 30. Ship 100 so the UI can expand past the inline cap of 30.
  const fundamentalsSum = (s) => {
    const b = s.v4_breakdown || {};
    // V4 pillar block (76: Health+Future+Valuation+Past, no dividend) + FV composite (12) = 88.
    return (b.pts_health || 0) + (b.pts_future || 0) + (b.pts_valuation || 0)
         + (b.pts_past || 0) + (b.pts_fv_total || 0);
  };
  const bestFundamentals = [...scoredStocks]
    .filter((s) => !isPureBSEcode(s.ticker))
    .filter(hygiene)
    .sort((a, b) => fundamentalsSum(b) - fundamentalsSum(a))
    .slice(0, 100)
    .map(pickCardFields);

  return {
    top_ranked_30: top30,
    best_to_buy_now: bestToBuy,
    deep_value: cat("deep_value"),
    quality_growth: cat("quality_growth"),
    best_fundamentals: bestFundamentals,
    midterm: cat("midterm"),
    dividend_aristocrats: cat("dividend_aristocrats"),
    smallcap_gems: cat("smallcap_gems"),
    insider_buying: cat("insider_buying"),
    upcoming_earnings: upcoming,
    avoid: cat("avoid"),
  };
}
