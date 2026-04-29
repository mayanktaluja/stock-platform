// Per-holding SWS scoring + action engine.
//
// Reads data/sws/deep/{TICKER}.json (mtime-cached), runs the SWS scorer to
// derive composite + v2_score + verdict, then maps to a portfolio action
// (EXIT / Reduction-50% / Reduction-25-33% / HOLD / Top-up-modest / Top-up /
// STRONG Top-up) using portfolio-context modifiers (position_weight,
// sector_weight, P&L %).
//
// The data shape was studied empirically against the 2026-04-28 API-pipeline
// snapshot. Notable: rewards[]/risks[] are universally empty in this snapshot,
// so narrative-phrase hard overrides are replaced with structured-data overrides
// pulled from the `fiscal` and `overview.snowflake` blocks.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreStock, num } from "./swsScoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEEP_DIR = path.resolve(__dirname, "..", "data", "sws", "deep");

const _deepCache = new Map(); // key -> { mtimeMs, data }

// SWS deep files are keyed by the bare NSE symbol (e.g. HDFCBANK.json), but
// portfolioParser surfaces tickers with a Yahoo-style suffix (HDFCBANK.NS,
// some ETFs as .BO). Strip those before file lookup. Ampersand symbols
// (ARE&M.json) are preserved as-is.
function _swsKey(ticker) {
  if (!ticker) return null;
  let k = String(ticker).trim();
  k = k.replace(/\.(NS|BO|BSE|NSE)$/i, "");
  return k;
}

export function loadSWSDeep(ticker) {
  const key = _swsKey(ticker);
  if (!key) return null;
  const fp = path.join(DEEP_DIR, `${key}.json`);
  let stat;
  try { stat = fs.statSync(fp); } catch { return null; }
  const cached = _deepCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const raw = fs.readFileSync(fp, "utf-8");
  const data = JSON.parse(raw);
  _deepCache.set(key, { mtimeMs: stat.mtimeMs, data });
  return data;
}

export function pickSnowflake(deep) {
  const sn = deep?.overview?.snowflake || {};
  return {
    valuation: num(sn.valuation ?? sn.value, 0),
    future_growth: num(sn.future_growth ?? sn.future, 0),
    past_performance: num(sn.past_performance ?? sn.past, 0),
    financial_health: num(sn.financial_health ?? sn.health, 0),
    dividends: num(sn.dividends ?? sn.dividend, 0),
    total: num(deep?.overview?.snowflake_total, 0),
  };
}

function dataFreshnessMs(deep) {
  const ts = deep?.parsed_at;
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

export function isSWSPriceStale(deep, thresholdHours = 24) {
  const ageMs = dataFreshnessMs(deep);
  if (ageMs == null) return true;
  return ageMs > thresholdHours * 3600 * 1000;
}

const NARRATIVE_RED = /declin|structurally\s*weak|promoter\s*(exit|pledge|stake)|governance|tax-loss|fraud|sebi/i;

function evaluateHardOverrides({ scored, holding, snow, fiscal }) {
  const surveillance = scored.v2_breakdown?.surveillance || null;
  const reasons = [];

  if (surveillance && surveillance.list === "GSM") {
    return { action: "EXIT", reasons: [`Listed on NSE GSM surveillance (${surveillance.timeframe || "—"}) — regulatory red flag, exit per SEBI-aligned framework.`] };
  }

  const pnl = num(holding.pnlPercent, 0);
  const snowTotal = snow.total;
  const fwdGrowth = num(fiscal.earnings_growth_pct, null);

  if (pnl < -20 && snowTotal <= 12 && (fwdGrowth == null || fwdGrowth <= 1)) {
    return {
      action: "Reduction-50%",
      reasons: [`Loss-position trap: -${Math.abs(pnl).toFixed(1)}% with Snowflake ${snowTotal}/30${fwdGrowth != null ? ` and FY earnings growth ${fwdGrowth.toFixed(1)}%` : " and no forward growth visibility"} — disposition-effect override.`],
    };
  }

  if (fwdGrowth != null && fwdGrowth < -10) {
    return {
      action: "Reduction-50%",
      reasons: [`Earnings declining ${fwdGrowth.toFixed(1)}% YoY (fiscal block) — structurally weak, reduce exposure.`],
    };
  }

  if (snow.financial_health <= 1 && (scored.overview?.multiples?.pe ?? 0) > 100) {
    return {
      action: "Reduction-50%",
      reasons: [`Fragile balance sheet (Health ${snow.financial_health}/6) at extreme valuation (P/E ${scored.overview?.multiples?.pe?.toFixed?.(1) ?? "—"}x).`],
    };
  }

  // Narrative-phrase fallback (rarely fires in current API-pipeline data because rewards/risks empty,
  // but covered for older snapshots).
  const risks = scored.overview?.risks || [];
  for (const r of risks) {
    if (NARRATIVE_RED.test(String(r))) {
      return {
        action: "Reduction-50%",
        reasons: [`SWS narrative flag: "${String(r).slice(0, 120)}".`],
      };
    }
  }

  return null;
}

function scoreBandAction({ v2, snow, upside, position_weight, sector_weight, risks_count }) {
  if (v2 < 40) return { action: "EXIT", band: "OVERVALUED" };

  if (v2 < 48) {
    if (position_weight > 10) return { action: "Reduction-50%", band: "FULLY_VALUED" };
    if (sector_weight > 30) return { action: "Reduction-25-33%", band: "FULLY_VALUED" };
    return { action: "Reduction-25-33%", band: "FULLY_VALUED" };
  }

  if (v2 < 62) return { action: "HOLD", band: "FAIR_VALUE" };

  if (v2 < 72) {
    if (upside >= 15 && risks_count === 0 && position_weight <= 6) {
      return { action: "Top-up", band: "QUALITY_GROWTH" };
    }
    if (position_weight <= 8 && sector_weight <= 25) {
      return { action: "Top-up-modest", band: "QUALITY_GROWTH" };
    }
    return { action: "HOLD", band: "QUALITY_GROWTH" };
  }

  if (position_weight <= 5 && sector_weight <= 20) {
    return { action: "STRONG Top-up", band: "DEEP_VALUE" };
  }
  return { action: "Top-up-modest", band: "DEEP_VALUE" };
}

function buildSWSReasons({ scored, snow, fiscal, action, band }) {
  const ov = scored.overview || {};
  const reasons = [];
  const upside = num(ov.upside_pct, null);
  const pe = ov.multiples?.pe;
  const fwd = num(fiscal.earnings_growth_pct, null);
  const margin = num(fiscal.net_margin_pct ?? ov.net_margin_pct, null);
  const ret1y = num((ov.returns_pct || {})["1Y"], null);

  reasons.push(`Snowflake ${snow.total}/30 (val ${snow.valuation}, future ${snow.future_growth}, past ${snow.past_performance}, health ${snow.financial_health}, div ${snow.dividends}).`);
  if (upside != null) reasons.push(`${upside >= 0 ? "+" : ""}${upside.toFixed(1)}% to AnalystConsensus FV (₹${ov.fair_value_inr?.toFixed?.(0) ?? "—"} vs ₹${ov.current_price_inr?.toFixed?.(0) ?? "—"}).`);
  if (pe != null) reasons.push(`P/E ${pe.toFixed(1)}x.`);
  if (fwd != null) reasons.push(`Earnings growth ${fwd.toFixed(1)}% YoY.`);
  if (margin != null) reasons.push(`Net margin ${margin.toFixed(1)}%.`);
  if (ret1y != null) reasons.push(`1Y return ${ret1y >= 0 ? "+" : ""}${ret1y.toFixed(1)}%.`);
  if (scored.v2_breakdown?.surveillance) {
    const s = scored.v2_breakdown.surveillance;
    reasons.push(`NSE ${s.list}${s.timeframe ? ` (${s.timeframe})` : ""} surveillance.`);
  }

  return reasons;
}

export function computeTimingObservation({ deep, scored, action, livePrice }) {
  const ov = scored.overview || {};
  const ret1m = num((ov.returns_pct || {})["1M"], 0);
  const next = ov.next_earnings_date;
  const now = Date.now();
  const epsDays = next ? Math.ceil((Date.parse(next + "T00:00:00Z") - now) / 86400000) : null;
  const recentDownRev = (ov.recent_analyst_revisions || []).some?.((r) => r?.direction === "decreased");

  // Skip timing for HOLD — no action means no timing question.
  if (action === "HOLD") {
    return { verdict: "n/a", window: null, reason: "Hold — no transaction needed." };
  }

  if (epsDays != null && epsDays >= 0 && epsDays <= 3) {
    return { verdict: "No", window: null, reason: `Earnings in ${epsDays}d — wait for results before acting.` };
  }

  if (recentDownRev) {
    return { verdict: "Soft-no", window: "closing-vwap", reason: "Recent analyst PT cut — let dust settle, target closing VWAP if acting." };
  }

  if (ret1m > 15) {
    return { verdict: "Soft-no", window: "closing-vwap", reason: `1M return +${ret1m.toFixed(1)}% — overshot, defer to closing VWAP.` };
  }

  if (ret1m < -15) {
    if (action.startsWith("Top-up") || action === "STRONG Top-up") {
      return { verdict: "Yes", window: "mid-morning", reason: `1M return ${ret1m.toFixed(1)}% — averaging window, mid-morning entry.` };
    }
    return { verdict: "Yes-not-urgent", window: "post-lunch", reason: `1M return ${ret1m.toFixed(1)}% — avoid panic exit, wait for intraday stability.` };
  }

  return { verdict: "Yes", window: "mid-morning", reason: "No proximate catalyst or volatility shock — standard mid-morning window." };
}

export function scoreHolding(holding, portfolioContext = {}) {
  const ticker = holding?.symbol || holding?.ticker;
  const deep = loadSWSDeep(ticker);
  if (!deep) {
    return {
      ...holding,
      swsCovered: false,
      action: null,
      reasons: ["No SWS data — likely demerger, freshly delisted, or out of NSE universe."],
      timing: null,
    };
  }

  const scored = scoreStock(deep);
  const snow = pickSnowflake(scored);
  const fiscal = scored.fiscal || {};
  const ov = scored.overview || {};

  const position_weight = num(holding.positionWeight, 0);
  const sector_weight = num(portfolioContext.sectorWeights?.[scored.sector] ?? holding.sectorWeight, 0);
  const upside = num(ov.upside_pct, 0);
  const risks_count = scored.v2_breakdown?.risks_count ?? (ov.risks?.length || 0);

  const hard = evaluateHardOverrides({ scored, holding, snow, fiscal });
  let action, band, reasons;
  if (hard) {
    action = hard.action;
    band = "HARD_OVERRIDE";
    reasons = hard.reasons;
  } else {
    const sb = scoreBandAction({
      v2: num(scored.v2_score_100, 0),
      snow,
      upside,
      position_weight,
      sector_weight,
      risks_count,
    });
    action = sb.action;
    band = sb.band;
    reasons = buildSWSReasons({ scored, snow, fiscal, action, band });
  }

  const timing = computeTimingObservation({ deep: scored, scored, action });

  return {
    ...holding,
    swsCovered: true,
    sws: {
      ticker: scored.ticker,
      name: scored.name,
      sector: scored.sector,
      sws_url: scored.sws_url,
      score: scored.composite_score_100,
      v2_score: scored.v2_score_100,
      verdict: scored.verdict,
      band,
      snowflake: snow,
      snowflake_total: snow.total,
      current_price_inr: ov.current_price_inr,
      fair_value_inr: ov.fair_value_inr,
      upside_pct: ov.upside_pct,
      market_cap_inr: ov.market_cap_inr,
      multiples: ov.multiples || null,
      dividend_yield_pct: ov.dividend?.yield_pct ?? ov.dividend_yield_pct ?? null,
      dividend_payout_pct: ov.dividend?.payout_pct ?? null,
      net_margin_pct: num(fiscal.net_margin_pct ?? ov.net_margin_pct, null),
      revenue_growth_pct: num(fiscal.revenue_growth_pct, null),
      earnings_growth_pct: num(fiscal.earnings_growth_pct, null),
      returns_pct: ov.returns_pct || null,
      next_earnings_date: ov.next_earnings_date,
      last_quarter_result: ov.last_quarter_result,
      surveillance: scored.v2_breakdown?.surveillance || null,
      data_freshness_at: scored.parsed_at,
      data_age_hours: dataFreshnessMs(scored) != null ? Math.round(dataFreshnessMs(scored) / 3600000) : null,
      breakdown: scored.score_breakdown,
      v2_breakdown: scored.v2_breakdown,
    },
    action,
    reasons,
    timing,
  };
}
