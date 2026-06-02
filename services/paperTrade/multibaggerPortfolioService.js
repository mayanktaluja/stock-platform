// Multibagger paper portfolio — virtual book that tracks Pillar 1-3
// positions for the 5x strategy. Lives at
// data/strategy/multibagger-portfolio.json. Atomic writes via PID-temp
// file + rename. Single active strategy book, not a per-strategy ledger.
//
// All actions also write to services/paperTrade/decisionLog.js so we
// get a full NDJSON audit trail beside the portfolio mark.

import fs from "node:fs";
import path from "node:path";
import { logDecision } from "./decisionLog.js";

const SCHEMA_VERSION = "multibagger-portfolio-v1";
const STARTING_CAPITAL_INR = 100_000;

function defaultPath() {
  return path.join(process.cwd(), "data", "strategy", "multibagger-portfolio.json");
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function atomicWriteJson(target, obj) {
  ensureDir(target);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8" });
  fs.renameSync(tmp, target);
}

function emptyBook() {
  return {
    schema_version: SCHEMA_VERSION,
    started_at: new Date().toISOString(),
    starting_capital_inr: STARTING_CAPITAL_INR,
    cash_inr: STARTING_CAPITAL_INR,
    positions: [],
    closed_positions: [],
    snapshot_at: null,
  };
}

export function readPortfolio(opts = {}) {
  const target = opts.path || defaultPath();
  if (!fs.existsSync(target)) return emptyBook();
  try { return JSON.parse(fs.readFileSync(target, "utf8")); }
  catch { return emptyBook(); }
}

export function writePortfolio(book, opts = {}) {
  const target = opts.path || defaultPath();
  atomicWriteJson(target, book);
  return book;
}

export function openPosition({
  ticker, tier, qty, entry_price_inr, sector, mcap_band = null, promoter_group = null,
  score_snapshot = null, counter_thesis = null, pre_mortem = null, stop_price_inr = null,
  target_price_inr = null, macro_regime = null, notes = null,
}, opts = {}) {
  if (!ticker || !tier || !isFiniteNumber(qty) || qty <= 0 || !isFiniteNumber(entry_price_inr) || entry_price_inr <= 0) {
    throw new Error("openPosition: missing required fields");
  }
  const book = readPortfolio(opts);
  if (book.positions.some((p) => p.ticker === ticker)) {
    throw new Error(`openPosition: ${ticker} already held — use addToPosition instead`);
  }
  const notional = qty * entry_price_inr;
  if (notional > book.cash_inr) {
    throw new Error(`openPosition: insufficient cash (need ${notional}, have ${book.cash_inr})`);
  }
  const now = new Date().toISOString();
  book.positions.push({
    ticker, tier, sector, mcap_band, promoter_group,
    qty, avg_entry_price_inr: entry_price_inr,
    peak_price_inr: entry_price_inr,
    stop_price_inr, target_price_inr,
    opened_at: now,
    entries: [{ ts: now, qty, price_inr: entry_price_inr }],
    counter_thesis, pre_mortem, score_snapshot,
  });
  book.cash_inr = Number((book.cash_inr - notional).toFixed(2));
  book.snapshot_at = now;
  writePortfolio(book, opts);
  logDecision({
    action: "ENTRY", symbol: ticker, tier, qty, price_inr: entry_price_inr,
    score_snapshot, counter_thesis, macro_regime, pre_mortem,
    stop_price_inr, target_price_inr, notes,
  });
  return book.positions[book.positions.length - 1];
}

export function trimPosition({ ticker, qty, price_inr, reason = "trim" }, opts = {}) {
  const book = readPortfolio(opts);
  const pos = book.positions.find((p) => p.ticker === ticker);
  if (!pos) throw new Error(`trimPosition: ${ticker} not held`);
  if (!isFiniteNumber(qty) || qty <= 0 || qty > pos.qty) throw new Error("trimPosition: invalid qty");
  if (!isFiniteNumber(price_inr) || price_inr <= 0) throw new Error("trimPosition: invalid price");
  pos.qty = Number((pos.qty - qty).toFixed(4));
  pos.entries.push({ ts: new Date().toISOString(), qty: -qty, price_inr });
  book.cash_inr = Number((book.cash_inr + qty * price_inr).toFixed(2));
  book.snapshot_at = new Date().toISOString();
  if (pos.qty <= 0) {
    return closePositionInternal(book, ticker, price_inr, reason, opts);
  }
  writePortfolio(book, opts);
  logDecision({ action: "TRIM", symbol: ticker, tier: pos.tier, qty, price_inr, notes: reason });
  return pos;
}

function closePositionInternal(book, ticker, price_inr, reason, opts) {
  const idx = book.positions.findIndex((p) => p.ticker === ticker);
  if (idx < 0) return null;
  const pos = book.positions[idx];
  const realised = pos.entries.reduce((acc, e) => acc + e.qty * e.price_inr, 0);
  pos.closed_at = new Date().toISOString();
  pos.close_reason = reason;
  pos.realised_pl_inr = Number((-realised).toFixed(2)); // entries store buy as +qty (cash out)
  book.closed_positions.push(pos);
  book.positions.splice(idx, 1);
  writePortfolio(book, opts);
  const action = reason === "stop" ? "EXIT_STOP"
              : reason === "target" ? "EXIT_TARGET"
              : reason === "failsafe" ? "EXIT_FAILSAFE"
              : reason === "timeout" ? "EXIT_TIMEOUT"
              : "EXIT_STOP";
  logDecision({ action, symbol: ticker, tier: pos.tier, qty: 1, price_inr, notes: reason });
  return pos;
}

export function closePosition({ ticker, price_inr, reason = "stop" }, opts = {}) {
  const book = readPortfolio(opts);
  const pos = book.positions.find((p) => p.ticker === ticker);
  if (!pos) throw new Error(`closePosition: ${ticker} not held`);
  if (!isFiniteNumber(price_inr) || price_inr <= 0) throw new Error("closePosition: invalid price");
  book.cash_inr = Number((book.cash_inr + pos.qty * price_inr).toFixed(2));
  pos.entries.push({ ts: new Date().toISOString(), qty: -pos.qty, price_inr });
  pos.qty = 0;
  return closePositionInternal(book, ticker, price_inr, reason, opts);
}

// markToMarket — given a price map { ticker: current_price_inr },
// computes current value + unrealised PnL + per-position PnL.
export function markToMarket(priceMap, opts = {}) {
  const book = readPortfolio(opts);
  let totalMarket = book.cash_inr;
  const lines = [];
  for (const pos of book.positions) {
    const price = priceMap[pos.ticker];
    if (!isFiniteNumber(price) || price <= 0) {
      lines.push({ ...pos, current_price_inr: null, unrealised_pl_inr: null, unrealised_pl_pct: null });
      continue;
    }
    if (price > pos.peak_price_inr) pos.peak_price_inr = price;
    const marketValue = pos.qty * price;
    const cost = pos.qty * pos.avg_entry_price_inr;
    const pl = marketValue - cost;
    const pl_pct = cost > 0 ? Number(((pl / cost) * 100).toFixed(2)) : null;
    totalMarket += marketValue;
    lines.push({
      ...pos,
      current_price_inr: price,
      current_value_inr: Number(marketValue.toFixed(2)),
      unrealised_pl_inr: Number(pl.toFixed(2)),
      unrealised_pl_pct: pl_pct,
    });
  }
  book.snapshot_at = new Date().toISOString();
  writePortfolio(book, opts);
  return {
    snapshot_at: book.snapshot_at,
    starting_capital_inr: book.starting_capital_inr,
    cash_inr: book.cash_inr,
    portfolio_value_inr: Number(totalMarket.toFixed(2)),
    total_pl_pct: Number(((totalMarket - book.starting_capital_inr) / book.starting_capital_inr * 100).toFixed(2)),
    positions: lines,
    closed_count: book.closed_positions.length,
  };
}

export function summary(opts = {}) {
  const book = readPortfolio(opts);
  return {
    schema_version: book.schema_version,
    started_at: book.started_at,
    starting_capital_inr: book.starting_capital_inr,
    cash_inr: book.cash_inr,
    open_positions: book.positions.length,
    closed_positions: book.closed_positions.length,
    snapshot_at: book.snapshot_at,
  };
}

export const PORTFOLIO_CONFIG = Object.freeze({ SCHEMA_VERSION, STARTING_CAPITAL_INR });
