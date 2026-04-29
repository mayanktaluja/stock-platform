// Per-holding SWS scoring + action engine.
//
// Reads data/sws/deep/{TICKER}.json (mtime-cached), runs the SWS scorer to
// derive composite + v2_score + v3_score + verdict, then maps to a portfolio
// action (EXIT / Reduction-50% / Reduction-25-33% / HOLD / Top-up-modest /
// Top-up / STRONG Top-up) using portfolio-context modifiers (position_weight,
// sector_weight, P&L %).
//
// Score driving the action engine: v3_score_100. v3 is the 50%-coverage-gated
// scorecard (74 fundamentals · 14 momentum · ±15 safety overlay) that uses
// every input we actually have data for and skips the sparse fields v1/v2
// included as zeros. Thresholds in scoreBandAction are calibrated to v3's
// distribution (universe p25≈21, p50≈29, p75≈39, p95≈59), not v1/v2's.
//
// The data shape was studied empirically against the 2026-04-28 API-pipeline
// snapshot. Notable: rewards[]/risks[] are universally empty in this snapshot,
// so narrative-phrase hard overrides are replaced with structured-data overrides
// pulled from the `fiscal` and `overview.snowflake` blocks.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreStock, num } from "./swsScoring.js";
import { crosscheckHolding } from "./swsLayerCrosscheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEEP_DIR = path.resolve(__dirname, "..", "data", "sws", "deep");
const V3_UNIVERSE_PATH = path.resolve(__dirname, "..", "data", "sws", "v3-universe-stats.json");

const _deepCache = new Map(); // key -> { mtimeMs, data }
let _v3Universe = null;       // { mtimeMs, data: { r1m, r3m, r1y } }

// Load the v3 universe-stats snapshot written by runFullScoring. Cached
// against file mtime so a fresh refresh propagates without a server restart.
// When the file is missing (first-ever boot before any refresh), return null
// and v3 momentum will neutral-impute — score stays usable, just less
// calibrated, with breakdown.momentum_imputed = true so callers can detect.
function _loadV3Universe() {
  let stat;
  try { stat = fs.statSync(V3_UNIVERSE_PATH); } catch { return null; }
  if (_v3Universe && _v3Universe.mtimeMs === stat.mtimeMs) return _v3Universe.data;
  try {
    const raw = JSON.parse(fs.readFileSync(V3_UNIVERSE_PATH, "utf-8"));
    const data = { r1m: raw.r1m || [], r3m: raw.r3m || [], r1y: raw.r1y || [] };
    _v3Universe = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

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

// Reconcile the SWS-scraped FV / upside_pct trio. Empirically the deep JSONs
// in data/sws/deep ship with several failure modes:
//
//   1. price present, FV null, upside_pct = a junk number (WIPRO: -3671.4)
//   2. price present, FV is a placeholder ratio not a price (BALUFORGE: 1.66)
//   3. price ≈ FV (scraper re-used current price as FV) but upside_pct still
//      carries the analyst-consensus number (LODHA, HAL, JWL: 32.1 / 15.6 / 16)
//   4. price + FV both present, upside_pct null (ITC: should be +26.7%)
//
// We trust this hierarchy:
//   • If FV/price ratio is plausible and FV != price → recompute upside.
//   • If FV ≈ price → the recompute is ~0; prefer the SWS-quoted upside if
//     it lies in a sane range (the analyst consensus is the live SWS view).
//   • If FV is missing or implausibly off price → the FV is junk, fall back
//     to the SWS-quoted upside only if it's in [-95%, +500%] — otherwise null.
//
// Returns { upside_pct, fair_value_inr } — both possibly null. The caller
// should overwrite `sws.upside_pct` and `sws.fair_value_inr` with these so
// the rest of the report (Tier-B classifier, basket rows, reason text) sees
// the same reconciled view.
export function _reconcileFVUpside(ov) {
  const price = num(ov?.current_price_inr, null);
  const rawFv = num(ov?.fair_value_inr, null);
  const rawUp = num(ov?.upside_pct, null);
  const inSaneRange = (v) => v != null && Number.isFinite(v) && v >= -95 && v <= 500;

  // Case A: both price + FV present.
  if (price != null && price > 0 && rawFv != null && rawFv > 0) {
    const ratio = rawFv / price;
    // Plausible-ratio guard: a real DCF FV shouldn't be < 1/10 of the price
    // or > 10× the price — anything outside that window is a scraper artefact.
    if (ratio >= 0.1 && ratio <= 10) {
      const computed = ((rawFv - price) / price) * 100;
      // FV ≈ price (placeholder) → trust the SWS-quoted upside if sane.
      if (Math.abs(computed) <= 1 && inSaneRange(rawUp)) {
        return { upside_pct: Math.round(rawUp * 10) / 10, fair_value_inr: rawFv };
      }
      // Otherwise prefer the math.
      return { upside_pct: Math.round(computed * 10) / 10, fair_value_inr: rawFv };
    }
    // Implausible ratio → FV is junk; both fields nulled so the UI doesn't
    // surface "(₹2 vs ₹548)" garbage.
    return { upside_pct: null, fair_value_inr: null };
  }

  // Case B: only one (or neither) present. Trust the SWS-quoted upside iff sane.
  return {
    upside_pct: inSaneRange(rawUp) ? Math.round(rawUp * 10) / 10 : null,
    fair_value_inr: rawFv,
  };
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

// v3 score thresholds — calibrated to the v3 universe distribution
// (p25≈21, p50≈29, p75≈39, p95≈59; max≈86). Each tier targets a
// realistic share of the universe so the action engine fires usefully:
//   <14 EXIT  (~bottom 8%)
//   <22 Reduction tier  (~bottom 25%)
//   <36 HOLD  (~middle 45%)
//   <55 Top-up tier  (~top 25%, sub-tiers by portfolio context)
//   ≥55 STRONG Top-up tier  (~top 7%)
// Bands match the v3 verdict labels (AVOID/WATCH/ACCEPTABLE/STRONG/TOP_PICK).
function scoreBandAction({ v3, snow, upside, position_weight, sector_weight, risks_count }) {
  if (v3 < 14) return { action: "EXIT", band: "AVOID" };

  if (v3 < 22) {
    if (position_weight > 10) return { action: "Reduction-50%", band: "WATCH" };
    if (sector_weight > 30) return { action: "Reduction-25-33%", band: "WATCH" };
    return { action: "Reduction-25-33%", band: "WATCH" };
  }

  if (v3 < 36) return { action: "HOLD", band: "ACCEPTABLE" };

  if (v3 < 55) {
    if (upside >= 15 && risks_count === 0 && position_weight <= 6) {
      return { action: "Top-up", band: "STRONG" };
    }
    if (position_weight <= 8 && sector_weight <= 25) {
      return { action: "Top-up-modest", band: "STRONG" };
    }
    return { action: "HOLD", band: "STRONG" };
  }

  if (position_weight <= 5 && sector_weight <= 20) {
    return { action: "STRONG Top-up", band: "TOP_PICK" };
  }
  return { action: "Top-up-modest", band: "TOP_PICK" };
}

function buildSWSReasons({ scored, snow, fiscal, action, band, reconciled }) {
  const ov = scored.overview || {};
  const reasons = [];
  // Use the reconciled upside/FV so the user-facing reason matches what the
  // KPI cards and basket rows show — the raw `ov.upside_pct` can carry junk
  // values from the upstream scraper (see _reconcileFVUpside).
  const upside = reconciled?.upside_pct ?? null;
  const fvPrice = reconciled?.fair_value_inr ?? null;
  const curPrice = num(ov.current_price_inr, null);
  const pe = ov.multiples?.pe;
  const fwd = num(fiscal.earnings_growth_pct, null);
  const margin = num(fiscal.net_margin_pct ?? ov.net_margin_pct, null);
  const ret1y = num((ov.returns_pct || {})["1Y"], null);

  reasons.push(`Snowflake ${snow.total}/30 (val ${snow.valuation}, future ${snow.future_growth}, past ${snow.past_performance}, health ${snow.financial_health}, div ${snow.dividends}).`);
  // Only emit the (₹FV vs ₹price) suffix when:
  //   • both prices are present, AND
  //   • the rounded prices actually differ — when the scraper sets FV = price
  //     but the upside is a non-zero analyst-consensus figure (LODHA/HAL),
  //     the suffix would render "(₹841 vs ₹841)" alongside "+32%" which
  //     reads as broken arithmetic. Bare form is the honest fallback.
  const sameRoundedPrice = fvPrice != null && curPrice != null
    && Math.round(fvPrice) === Math.round(curPrice);
  if (upside != null && fvPrice != null && curPrice != null && !sameRoundedPrice) {
    reasons.push(`${upside >= 0 ? "+" : ""}${upside.toFixed(1)}% to AnalystConsensus FV (₹${fvPrice.toFixed(0)} vs ₹${curPrice.toFixed(0)}).`);
  } else if (upside != null) {
    reasons.push(`${upside >= 0 ? "+" : ""}${upside.toFixed(1)}% to AnalystConsensus FV.`);
  }
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

  const universe = _loadV3Universe();
  const scored = scoreStock(deep, { universe });
  const snow = pickSnowflake(scored);
  const fiscal = scored.fiscal || {};
  const ov = scored.overview || {};
  // Reconcile FV / upside_pct once — every downstream consumer (action
  // mapping, reasons, basket classifier) reads the same clean numbers.
  const reconciled = _reconcileFVUpside(ov);

  const position_weight = num(holding.positionWeight, 0);
  const sector_weight = num(portfolioContext.sectorWeights?.[scored.sector] ?? holding.sectorWeight, 0);
  const upside = num(reconciled.upside_pct, 0);
  const risks_count = scored.v2_breakdown?.risks_count ?? (ov.risks?.length || 0);

  const hard = evaluateHardOverrides({ scored, holding, snow, fiscal });
  let action, band, reasons;
  if (hard) {
    action = hard.action;
    band = "HARD_OVERRIDE";
    reasons = hard.reasons;
  } else {
    const sb = scoreBandAction({
      v3: num(scored.v3_score_100, 0),
      snow,
      upside,
      position_weight,
      sector_weight,
      risks_count,
    });
    action = sb.action;
    band = sb.band;
    reasons = buildSWSReasons({ scored, snow, fiscal, action, band, reconciled });
  }

  const timing = computeTimingObservation({ deep: scored, scored, action });

  // Layer-2 independent-fundamentals cross-check — shadow attach only.
  // The conviction engine (PR 3) will read crosscheck.confidence_delta to
  // bias the action band. Today we just expose the data so the divergence
  // smoke test (scripts/smoke-sws-crosscheck.mjs) and a future UI can read
  // it. Never throws — returns { available: false } when fundamentals.json
  // has no snapshot for this ticker.
  const crosscheck = crosscheckHolding({
    ticker: scored.ticker || holding?.symbol || holding?.ticker,
    swsSnowflake: snow,
    swsV3Score: num(scored.v3_score_100, null),
  });

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
      v3_score: scored.v3_score_100,
      v3_verdict: scored.v3_verdict,
      verdict: scored.verdict,
      band,
      crosscheck,
      snowflake: snow,
      snowflake_total: snow.total,
      current_price_inr: ov.current_price_inr,
      fair_value_inr: reconciled.fair_value_inr,
      upside_pct: reconciled.upside_pct,
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
      v3_breakdown: scored.v3_breakdown,
    },
    action,
    reasons,
    timing,
  };
}
