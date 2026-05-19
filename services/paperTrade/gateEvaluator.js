// Paper-trade harness — evaluates whether a sleeve has cleared the live-
// deploy validation gate. Reuses the validation thresholds from
// services/earnings/weightTuner.js (MIN_RESOLVED=80, MIN_QUARTERS=2,
// MIN_SECTORS_WITH_EVENTS=5, SECTOR_MIN_EVENTS=10) plus a configurable
// minimum hit-rate.
//
// Pure logic — accepts a closed-trades array, returns a gate state.

import { GATE as WEIGHT_TUNER_GATE } from "../earnings/weightTuner.js";

export const PAPER_TRADE_GATE = Object.freeze({
  MIN_RESOLVED: WEIGHT_TUNER_GATE.MIN_RESOLVED,
  MIN_QUARTERS: WEIGHT_TUNER_GATE.MIN_QUARTERS,
  MIN_SECTORS_WITH_EVENTS: WEIGHT_TUNER_GATE.MIN_SECTORS_WITH_EVENTS,
  SECTOR_MIN_EVENTS: WEIGHT_TUNER_GATE.SECTOR_MIN_EVENTS,
  MIN_HIT_RATE_PCT: 55,
});

// Fiscal-quarter key from an ISO date. Indian FY runs Apr→Mar.
// "2026-05-19" → "Q1 FY27".
export function fiscalQuarterOf(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getUTCMonth() + 1; // 1-12
  const y = d.getUTCFullYear();
  let q, fy;
  if (m >= 4 && m <= 6) { q = 1; fy = y + 1; }
  else if (m >= 7 && m <= 9) { q = 2; fy = y + 1; }
  else if (m >= 10 && m <= 12) { q = 3; fy = y + 1; }
  else { q = 4; fy = y; }
  return `Q${q} FY${String(fy).slice(-2)}`;
}

// A closed trade is a "hit" iff exit_price > entry_price. Trades without
// usable prices are excluded from the rate calculation.
function isHit(trade) {
  const e = Number(trade.entry_price_inr);
  const x = Number(trade.exit_price_inr);
  if (!Number.isFinite(e) || !Number.isFinite(x) || e <= 0) return null;
  return x > e;
}

// trades: array of {ticker, sector, entry_date, entry_price_inr,
//                   exit_date, exit_price_inr, status}
export function evaluateGate(trades, opts = PAPER_TRADE_GATE) {
  const closed = (Array.isArray(trades) ? trades : []).filter((t) => t.status === "CLOSED");
  const scoreable = closed.filter((t) => isHit(t) !== null);
  const hits = scoreable.filter((t) => isHit(t)).length;
  const hit_rate_pct = scoreable.length ? Math.round((hits / scoreable.length) * 1000) / 10 : null;

  const quarters = new Set();
  const sectorCounts = Object.create(null);
  for (const t of scoreable) {
    const q = fiscalQuarterOf(t.entry_date);
    if (q) quarters.add(q);
    const s = String(t.sector || "Unknown");
    sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  const sectorsWithMin = Object.values(sectorCounts).filter((n) => n >= opts.SECTOR_MIN_EVENTS).length;

  const reasons = [];
  if (scoreable.length < opts.MIN_RESOLVED) {
    reasons.push(`resolved=${scoreable.length}<${opts.MIN_RESOLVED}`);
  }
  if (quarters.size < opts.MIN_QUARTERS) {
    reasons.push(`quarters=${quarters.size}<${opts.MIN_QUARTERS}`);
  }
  if (sectorsWithMin < opts.MIN_SECTORS_WITH_EVENTS) {
    reasons.push(`sectors_with_${opts.SECTOR_MIN_EVENTS}+_events=${sectorsWithMin}<${opts.MIN_SECTORS_WITH_EVENTS}`);
  }
  if (hit_rate_pct == null || hit_rate_pct < opts.MIN_HIT_RATE_PCT) {
    reasons.push(`hit_rate=${hit_rate_pct ?? "—"}%<${opts.MIN_HIT_RATE_PCT}%`);
  }

  return {
    gate_met: reasons.length === 0,
    blocking_reasons: reasons,
    metrics: {
      closed_count: closed.length,
      scoreable_count: scoreable.length,
      hits,
      hit_rate_pct,
      quarters: Array.from(quarters).sort(),
      sectors_with_min_events: sectorsWithMin,
      sector_counts: sectorCounts,
    },
    gate_spec: opts,
  };
}

// Mark-to-market for OPEN trades. Returns total notional + unrealised PnL
// against a price map { ticker: current_close_inr }.
export function markOpenTrades(trades, priceMap = {}) {
  const open = (Array.isArray(trades) ? trades : []).filter((t) => t.status === "OPEN");
  let total_invested = 0;
  let total_mtm = 0;
  const positions = [];
  for (const t of open) {
    const entry = Number(t.entry_price_inr);
    const close = Number(priceMap[t.ticker]);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const size = Number(t.entry_snapshot?.size_inr) || 0;
    total_invested += size;
    if (Number.isFinite(close) && close > 0) {
      const ret = (close - entry) / entry;
      total_mtm += size * (1 + ret);
      positions.push({ ticker: t.ticker, entry, close, ret_pct: ret * 100, size_inr: size });
    } else {
      total_mtm += size; // unmarkable — value at cost
      positions.push({ ticker: t.ticker, entry, close: null, ret_pct: null, size_inr: size });
    }
  }
  return {
    open_count: open.length,
    total_invested_inr: total_invested,
    total_mtm_inr: total_mtm,
    unrealised_pnl_inr: total_mtm - total_invested,
    unrealised_pnl_pct: total_invested > 0 ? ((total_mtm - total_invested) / total_invested) * 100 : null,
    positions: positions.sort((a, b) => (b.ret_pct ?? -999) - (a.ret_pct ?? -999)),
  };
}

// Realised PnL summary across closed trades.
export function summariseClosed(trades) {
  const closed = (Array.isArray(trades) ? trades : []).filter((t) => t.status === "CLOSED");
  let total_pnl = 0;
  let wins = 0;
  let losses = 0;
  const returns = [];
  for (const t of closed) {
    const e = Number(t.entry_price_inr);
    const x = Number(t.exit_price_inr);
    const size = Number(t.entry_snapshot?.size_inr) || 0;
    if (!Number.isFinite(e) || !Number.isFinite(x) || e <= 0) continue;
    const ret = (x - e) / e;
    total_pnl += size * ret;
    returns.push(ret);
    if (ret > 0) wins++;
    else losses++;
  }
  const avg_ret = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  return {
    closed_count: closed.length,
    wins,
    losses,
    total_realised_pnl_inr: total_pnl,
    avg_return_pct: avg_ret == null ? null : avg_ret * 100,
  };
}
