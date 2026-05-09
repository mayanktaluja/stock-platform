/**
 * sectionScorecard.js
 *
 * Aggregates resolved horizon outcomes into a per-section, per-horizon
 * scorecard that the Track Record UI renders as a 4-column grid.
 *
 * Side semantics are baked into the resolver: alpha_pct is already signed
 * such that >0 = "the call was right." This module therefore stays
 * side-agnostic — it just counts wins.
 *
 *   hit_rate_pct    = pct of resolved alphas > 0
 *   mean_alpha_pct  = arithmetic mean of resolved alphas
 *   median_alpha_pct
 *   max_drawdown_pct = worst peak-to-trough on the cumulative-alpha curve
 *                      built from resolved entries ordered by snapshot date
 *   since_inception_cum_pct = compounded mean alpha across resolved entries
 *                              ((Πᵢ (1 + αᵢ/100)) − 1) × 100
 *
 * Earnings sections store categorical alpha (+1 hit / -1 miss) — the same
 * primitives apply but mean_alpha_pct ≈ hit_rate_pct − miss_rate_pct
 * which is fine; readers should look at hit_rate_pct primarily.
 */

import { ALL_SECTION_TYPES, STANDARD_HORIZONS, EARNINGS_HORIZONS } from "../../paperTrades.js";

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function maxDrawdownPct(orderedAlphas) {
  if (orderedAlphas.length === 0) return null;
  let cum = 1;
  let peak = 1;
  let mdd = 0;
  for (const a of orderedAlphas) {
    cum *= 1 + a / 100;
    if (cum > peak) peak = cum;
    const dd = (cum - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return +(mdd * 100).toFixed(2);
}

function sinceInceptionCumPct(orderedAlphas) {
  if (orderedAlphas.length === 0) return null;
  let cum = 1;
  for (const a of orderedAlphas) cum *= 1 + a / 100;
  return +((cum - 1) * 100).toFixed(2);
}

/**
 * Build a single-section, single-horizon scorecard.
 *
 * @param {Array} trades   trades belonging to this section
 * @param {string} horizon "1m" | "3m" | "6m" | "12m" | "t1"
 */
export function buildHorizonScorecard(trades, horizon) {
  const slots = trades
    .map((t) => ({ snapshotAt: t.snapshotAt, slot: t.returns_by_horizon?.[horizon] }))
    .filter((x) => x.slot);
  const resolved = slots.filter((x) => x.slot.status === "closed" && Number.isFinite(x.slot.alpha_pct));
  const open = slots.filter((x) => x.slot.status === "open");
  if (resolved.length === 0) {
    return {
      n_resolved: 0,
      n_open: open.length,
      hit_rate_pct: null,
      mean_alpha_pct: null,
      median_alpha_pct: null,
      max_drawdown_pct: null,
      since_inception_cum_pct: null,
    };
  }
  resolved.sort((a, b) => a.snapshotAt.localeCompare(b.snapshotAt));
  const alphas = resolved.map((x) => x.slot.alpha_pct);
  const wins = alphas.filter((a) => a > 0).length;
  const meanA = alphas.reduce((s, a) => s + a, 0) / alphas.length;
  return {
    n_resolved: resolved.length,
    n_open: open.length,
    hit_rate_pct: +((wins / alphas.length) * 100).toFixed(1),
    mean_alpha_pct: +meanA.toFixed(2),
    median_alpha_pct: +median(alphas).toFixed(2),
    max_drawdown_pct: maxDrawdownPct(alphas),
    since_inception_cum_pct: sinceInceptionCumPct(alphas),
  };
}

/**
 * Build the full scorecard map keyed by section type and horizon.
 * Trades not in ALL_SECTION_TYPES (legacy types) are skipped — the
 * unified UI groups them under a "Legacy" bucket separately.
 *
 * @param {Array} allTrades  output of readAllTrades()
 * @returns {{ [type]: { side, horizons: { [h]: scorecard } } }}
 */
export function buildAllSectionScorecards(allTrades) {
  const grouped = new Map();
  for (const t of allTrades) {
    if (!t || !t.type) continue;
    const side = ALL_SECTION_TYPES[t.type];
    if (!side) continue;
    if (!grouped.has(t.type)) grouped.set(t.type, []);
    grouped.get(t.type).push(t);
  }

  const out = {};
  for (const [type, trades] of grouped) {
    const horizons = type.startsWith("earnings_") ? EARNINGS_HORIZONS : STANDARD_HORIZONS;
    const horizonsOut = {};
    for (const h of horizons) {
      horizonsOut[h] = buildHorizonScorecard(trades, h);
    }
    out[type] = {
      side: ALL_SECTION_TYPES[type],
      n_total: trades.length,
      horizons: horizonsOut,
    };
  }
  return out;
}

/**
 * Get the latest top-N snapshot for a single section. Used by the
 * /api/track/sections UI feed: each card shows what's currently in the
 * top-10 alongside the historical scorecard.
 */
export function latestTopForType(allTrades, type, n = 10) {
  const matching = allTrades.filter((t) => t.type === type);
  if (matching.length === 0) return [];
  // Newest dateKey first; within that, by section_rank ascending.
  matching.sort((a, b) => {
    if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey);
    return (a.section_rank || 0) - (b.section_rank || 0);
  });
  const latestDate = matching[0].dateKey;
  return matching.filter((t) => t.dateKey === latestDate).slice(0, n);
}

// Display labels for the UI — kept here so the section registry, scorecard
// shape, and label all live next to each other.
export const SECTION_LABELS = {
  sws_top30_v3: "SWS — Top 30 (v3)",
  sws_best_buynow: "SWS — Best to Buy Now",
  sws_deep_value: "SWS — Deep Value",
  sws_quality_growth: "SWS — Quality Growth",
  sws_dividend_aristocrats: "SWS — Dividend Aristocrats",
  sws_smallcap_gems: "SWS — Small-Cap Gems",
  sws_insider_buying: "SWS — Insider Buying",
  sws_midterm: "SWS — Mid-Term",
  sws_upcoming_earnings: "SWS — Upcoming Earnings",
  sws_avoid: "SWS — Avoid (SHORT)",
  scanner_buynow_top10: "Scanner — Buy Now (top 10)",
  scanner_midterm_top10: "Scanner — Mid-Term (top 10)",
  scanner_sell_top10: "Scanner — Sell Now (top 10, SHORT)",
  earnings_beat_top10: "Earnings — BEAT (top 10, T+1)",
  earnings_miss_top10: "Earnings — MISS (top 10, T+1, SHORT)",
};
