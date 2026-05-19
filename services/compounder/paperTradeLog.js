// Paper-trade ledger — append-only JSON log used by both sleeves
// (Compounder Lab + Earnings Edge) to track hypothetical trades for the
// pre-deploy walk-forward gate.
//
// One file per strategy at data/paper-trades/<strategy>.json. Schema:
//
//   {
//     "schema_version": "paper-trades-v1",
//     "strategy": "compounder" | "earnings_edge",
//     "trades": [
//       {
//         "ticker": "JSLL",
//         "name": "Jeena Sikho Lifecare Limited",
//         "sector": "Healthcare",
//         "entry_date": "2026-05-19",
//         "entry_price_inr": 631.4,
//         "entry_snapshot": { snowflake_health, snowflake_past, snowflake_dividend, risks, fair_value_inr, upside_pct },
//         "exit_date": null | "2026-08-19",
//         "exit_price_inr": null | 720.0,
//         "exit_action": null | "HOLD"|"TRIM_50"|"EXIT",
//         "exit_reason": null | string,
//         "status": "OPEN"|"CLOSED"
//       }
//     ]
//   }
//
// Atomic write pattern: write to .tmp then rename. Same idiom as every
// other refresh script in this repo.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PAPER_DIR = path.join(ROOT, "data", "paper-trades");
const SCHEMA_VERSION = "paper-trades-v1";

export function pathFor(strategy) {
  return path.join(PAPER_DIR, `${strategy}.json`);
}

export function readLedger(strategy) {
  const p = pathFor(strategy);
  if (!fs.existsSync(p)) {
    return { schema_version: SCHEMA_VERSION, strategy, trades: [] };
  }
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.trades)) return obj;
  } catch (err) {
    console.warn(`[paperTradeLog] read ${p} failed:`, err.message);
  }
  return { schema_version: SCHEMA_VERSION, strategy, trades: [] };
}

function writeLedger(strategy, ledger) {
  if (!fs.existsSync(PAPER_DIR)) fs.mkdirSync(PAPER_DIR, { recursive: true });
  const p = pathFor(strategy);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, p);
}

// Append a new OPEN trade. Idempotent against (ticker, entry_date) — if a
// trade already exists for the same ticker on the same date, returns it
// unchanged. Prevents double-logging on repeated nightly runs.
export function openTrade(strategy, trade) {
  if (!trade || !trade.ticker || !trade.entry_date) {
    throw new Error("openTrade: ticker + entry_date required");
  }
  const ledger = readLedger(strategy);
  const existing = ledger.trades.find(
    (t) =>
      t.ticker === trade.ticker &&
      t.entry_date === trade.entry_date &&
      t.status === "OPEN",
  );
  if (existing) return existing;
  const next = {
    ticker: trade.ticker,
    name: trade.name || null,
    sector: trade.sector || null,
    entry_date: trade.entry_date,
    entry_price_inr: trade.entry_price_inr ?? null,
    entry_snapshot: trade.entry_snapshot || {},
    exit_date: null,
    exit_price_inr: null,
    exit_action: null,
    exit_reason: null,
    status: "OPEN",
  };
  ledger.trades.push(next);
  writeLedger(strategy, ledger);
  return next;
}

// Close the first OPEN trade for a given ticker. Returns null if no open
// trade was found.
export function closeTrade(strategy, ticker, closeData) {
  const ledger = readLedger(strategy);
  const idx = ledger.trades.findIndex(
    (t) => t.ticker === ticker && t.status === "OPEN",
  );
  if (idx < 0) return null;
  const t = ledger.trades[idx];
  t.exit_date = closeData?.exit_date || new Date().toISOString().slice(0, 10);
  t.exit_price_inr = closeData?.exit_price_inr ?? null;
  t.exit_action = closeData?.exit_action || "EXIT";
  t.exit_reason = closeData?.exit_reason || null;
  t.status = "CLOSED";
  writeLedger(strategy, ledger);
  return t;
}

export function openTradesFor(strategy) {
  return readLedger(strategy).trades.filter((t) => t.status === "OPEN");
}

export function closedTradesFor(strategy) {
  return readLedger(strategy).trades.filter((t) => t.status === "CLOSED");
}

// Re-emit the ledger from a list of basket members + a list of forced closes.
// Used by the refresh script: given today's filtered basket, open trades for
// new entrants and close trades for departures. Returns a summary.
export function reconcileBasket(strategy, basket, opts = {}) {
  const today = opts.today_iso || new Date().toISOString().slice(0, 10);
  const open_before = openTradesFor(strategy);
  const open_ticker_set = new Set(open_before.map((t) => t.ticker));
  const basket_ticker_set = new Set(basket.map((b) => b.ticker));

  let opened = 0;
  let closed = 0;

  for (const member of basket) {
    if (!open_ticker_set.has(member.ticker)) {
      openTrade(strategy, {
        ticker: member.ticker,
        name: member.name,
        sector: member.sector,
        entry_date: today,
        entry_price_inr: member.current_price_inr,
        entry_snapshot: {
          snowflake_past: member.snowflake_past,
          snowflake_health: member.snowflake_health,
          snowflake_dividend: member.snowflake_dividend,
          risks: member.risks || [],
          fair_value_inr: member.fair_value_inr,
          upside_pct: member.upside_pct,
        },
      });
      opened++;
    }
  }

  for (const t of open_before) {
    if (!basket_ticker_set.has(t.ticker)) {
      closeTrade(strategy, t.ticker, {
        exit_date: today,
        exit_price_inr: opts.exit_price_map?.[t.ticker] ?? null,
        exit_action: "EXIT",
        exit_reason: "dropped-from-basket",
      });
      closed++;
    }
  }

  return { opened, closed, basket_size: basket.length };
}
