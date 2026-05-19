#!/usr/bin/env node
/**
 * Paper-trade reconciliation — daily mark-to-market + gate state for both
 * sleeves (compounder + earnings_edge). Reads each sleeve's ledger,
 * computes unrealised PnL against `data/sws/deep/<T>.json:overview.current_price_inr`,
 * realised PnL across closed trades, gate state per `weightTuner.js`
 * thresholds, and writes a daily marker to data/paper-trades-reports/<sleeve>-<date>.json.
 *
 * Usage:
 *   node scripts/paper-trade-reconcile.mjs
 *   node scripts/paper-trade-reconcile.mjs --json   # machine-readable
 */

import fs from "node:fs";
import path from "node:path";
import { readLedger } from "../services/compounder/paperTradeLog.js";
import {
  evaluateGate,
  markOpenTrades,
  summariseClosed,
  PAPER_TRADE_GATE,
} from "../services/paperTrade/gateEvaluator.js";

const ROOT = process.cwd();
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const REPORTS_DIR = path.join(ROOT, "data", "paper-trades-reports");
const STRATEGIES = ["compounder", "earnings_edge"];

function loadCurrentPriceMap(tickers) {
  const map = Object.create(null);
  for (const t of tickers) {
    const p = path.join(DEEP_DIR, `${t}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      const px = Number(d?.overview?.current_price_inr);
      if (Number.isFinite(px) && px > 0) map[t] = px;
    } catch {}
  }
  return map;
}

function buildReport(strategy) {
  const ledger = readLedger(strategy);
  const tickers = Array.from(new Set(ledger.trades.map((t) => t.ticker)));
  const prices = loadCurrentPriceMap(tickers);
  const gate = evaluateGate(ledger.trades);
  const open = markOpenTrades(ledger.trades, prices);
  const realised = summariseClosed(ledger.trades);
  return {
    schema_version: "paper-trade-report-v1",
    strategy,
    generated_at: new Date().toISOString(),
    ledger_size: ledger.trades.length,
    gate,
    open_positions: open,
    realised,
    price_coverage: {
      tickers_needed: tickers.length,
      tickers_priced: Object.keys(prices).length,
    },
  };
}

function pct(n) {
  return Number.isFinite(Number(n)) ? `${Number(n).toFixed(2)}%` : "—";
}
function inr(n) {
  return Number.isFinite(Number(n)) ? `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—";
}

function renderHuman(report) {
  console.log(`\n=== ${report.strategy} ===`);
  console.log(`ledger: ${report.ledger_size} trades, gate ${report.gate.gate_met ? "MET" : "PENDING"}`);
  if (!report.gate.gate_met) {
    console.log(`  blocking: ${report.gate.blocking_reasons.join(", ")}`);
  }
  console.log(
    `  closed: ${report.gate.metrics.scoreable_count}/${PAPER_TRADE_GATE.MIN_RESOLVED} scoreable, ` +
    `hit_rate=${report.gate.metrics.hit_rate_pct ?? "—"}%, ` +
    `quarters=${report.gate.metrics.quarters.length}/${PAPER_TRADE_GATE.MIN_QUARTERS}, ` +
    `sectors_with_${PAPER_TRADE_GATE.SECTOR_MIN_EVENTS}+=${report.gate.metrics.sectors_with_min_events}/${PAPER_TRADE_GATE.MIN_SECTORS_WITH_EVENTS}`
  );
  console.log(
    `  open: ${report.open_positions.open_count} positions, ` +
    `invested=${inr(report.open_positions.total_invested_inr)}, ` +
    `mtm=${inr(report.open_positions.total_mtm_inr)} (${pct(report.open_positions.unrealised_pnl_pct)})`
  );
  console.log(
    `  realised: wins=${report.realised.wins} losses=${report.realised.losses}, ` +
    `pnl=${inr(report.realised.total_realised_pnl_inr)} avg_ret=${pct(report.realised.avg_return_pct)}`
  );
}

function writeReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const p = path.join(REPORTS_DIR, `${report.strategy}-${date}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  // Also write a "latest" pointer so consumers (earnings-health, API)
  // don't have to glob.
  const latest = path.join(REPORTS_DIR, `${report.strategy}-latest.json`);
  fs.writeFileSync(latest, JSON.stringify(report, null, 2));
  return { dated: p, latest };
}

function main() {
  const wantJson = process.argv.includes("--json");
  const reports = STRATEGIES.map(buildReport);
  if (wantJson) {
    process.stdout.write(JSON.stringify(reports, null, 2));
    process.stdout.write("\n");
  } else {
    for (const r of reports) renderHuman(r);
  }
  // Always persist
  for (const r of reports) {
    const paths = writeReport(r);
    if (!wantJson) console.log(`  wrote ${paths.latest}`);
  }
}

main();
