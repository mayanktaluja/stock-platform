/**
 * nseBulkBlockIngester.js
 *
 * Fetches NSE bulk + block deals via the working endpoint we found in
 * reconnaissance:
 *
 *   /api/snapshot-capital-market-largedeal
 *
 * One call returns the full day's tape with:
 *   { as_on_date, BULK_DEALS_DATA: [...], BLOCK_DEALS_DATA: [...],
 *     SHORT_DEALS_DATA: [...], BULK_DEALS, BLOCK_DEALS }
 *
 * Each row schema (verified live):
 *   { date, symbol, name, clientName, buySell: "BUY"|"SELL",
 *     qty (string), watp (weighted avg trade price, string), remarks }
 *
 * V1 strategy: append the day's tape to a rolling 5-day archive,
 * dedupe by (symbol, date, clientName, buySell, qty), and emit
 * per-symbol nets so the predictor can score "institutional flow
 * before result".
 *
 * MUST run locally — NSE rejects Vercel datacenter IPs.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SCHEMA CONTRACT (pinned by test/nseBulkBlockSchema.test.mjs — PR-D2)
 * ─────────────────────────────────────────────────────────────────────
 *
 * data/catalysts/nse-bulk-block-rolling.json (on-disk, snake_case):
 *   {
 *     schema_version: "nse-bulk-block-rolling-v1",
 *     built_at:       ISO string | null,
 *     window_days:    7,
 *     deal_count:     number  // === deals.length
 *     deals: [
 *       { symbol, name, date_iso, client_name, side: "BUY"|"SELL",
 *         qty, avg_price_inr, notional_inr, kind: "BULK"|"BLOCK",
 *         remarks }
 *     ]
 *   }
 *
 * In-memory per-symbol rollup from buildPerSymbolDealIndex(rolling):
 *   Map<symbol, {
 *     net_buys, net_sells, net_qty, net_notional_inr,
 *     bulk_count, block_count,      // ← what signalAggregator reads
 *     last_deal_date_iso, deals
 *   }>
 *
 * Consumers (verified 2026-05-18):
 *   - scripts/refresh-nse-corporate.mjs   reads `deal_count` from JSON
 *   - services/earnings/signalAggregator  reads `bulk_count`/`block_count`
 *                                         from the IN-MEMORY rollup (not JSON)
 *
 * If you bump the schema, bump `schema_version` AND update the regression
 * test AND every downstream consumer in the same PR.
 */

import fs from "node:fs";
import path from "node:path";
import { nseGet } from "../../nse.js";

const ROOT = process.cwd();
const ROLLING_PATH = path.join(ROOT, "data", "catalysts", "nse-bulk-block-rolling.json");
const ROLLING_WINDOW_DAYS = 7;

// ────────── Date helpers ──────────

function parseNseDate(s) {
  if (!s || typeof s !== "string") return null;
  const dmy = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (dmy) {
    const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const m = months[dmy[2]];
    if (!m) return null;
    return `${dmy[3]}-${String(m).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function isoToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAgo(isoDate, asOfIso) {
  const a = new Date((asOfIso || isoToday()) + "T00:00:00Z").getTime();
  const b = new Date(isoDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

// ────────── Cleaning ──────────

const num = (s) => {
  const v = Number(String(s || "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};

function cleanDeal(raw, kind) {
  if (!raw || typeof raw !== "object") return null;
  const symbol = raw.symbol ? String(raw.symbol).trim().toUpperCase() : null;
  if (!symbol) return null;
  const dateIso = parseNseDate(raw.date);
  const qty = num(raw.qty);
  const watp = num(raw.watp);
  const buySell = String(raw.buySell || "").toUpperCase();
  if (!["BUY", "SELL"].includes(buySell)) return null;
  return {
    symbol,
    name: raw.name || null,
    date_iso: dateIso,
    client_name: raw.clientName || null,
    side: buySell, // "BUY" | "SELL"
    qty,
    avg_price_inr: watp,
    notional_inr: qty != null && watp != null ? Math.round(qty * watp) : null,
    kind, // "BULK" | "BLOCK"
    remarks: raw.remarks || null,
  };
}

// ────────── Public API ──────────

/**
 * One call to NSE → returns { bulk: [...], block: [...], as_on_date }.
 * Returns null on hard failure.
 */
export async function fetchTodaysDeals() {
  let raw;
  try {
    raw = await nseGet("/api/snapshot-capital-market-largedeal");
  } catch (err) {
    console.error("[nse-bulk-block] fetch threw:", err.message);
    return null;
  }
  if (!raw) return null;

  const asOnDate = parseNseDate(raw.as_on_date) || isoToday();
  const bulk = Array.isArray(raw.BULK_DEALS_DATA)
    ? raw.BULK_DEALS_DATA.map((r) => cleanDeal(r, "BULK")).filter(Boolean)
    : [];
  const block = Array.isArray(raw.BLOCK_DEALS_DATA)
    ? raw.BLOCK_DEALS_DATA.map((r) => cleanDeal(r, "BLOCK")).filter(Boolean)
    : [];

  return { as_on_date: asOnDate, bulk, block };
}

/**
 * Read the rolling-window cache. Returns empty-shape default if
 * missing. Pass `opts.path` to read from a non-default location
 * (only used by the schema regression test, never in production).
 */
export function loadDealsRolling(opts = {}) {
  const filePath = opts.path || ROLLING_PATH;
  if (!fs.existsSync(filePath)) {
    return {
      schema_version: "nse-bulk-block-rolling-v1",
      built_at: null,
      window_days: ROLLING_WINDOW_DAYS,
      deal_count: 0,
      deals: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Dedupe key — same client buying/selling the same qty of the same
 * symbol on the same day shouldn't be counted twice if we re-fetch
 * the day's tape (NSE updates incrementally during the trading day).
 */
function dealKey(d) {
  return `${d.symbol}|${d.date_iso}|${d.kind}|${d.side}|${d.client_name || ""}|${d.qty || 0}`;
}

export function mergeIntoRolling(rolling, freshBulk, freshBlock) {
  const today = isoToday();
  const seen = new Set();
  const merged = [];

  for (const d of [...(rolling?.deals || []), ...(freshBulk || []), ...(freshBlock || [])]) {
    if (!d || !d.date_iso) continue;
    const da = daysAgo(d.date_iso, today);
    if (da == null || da < 0 || da > ROLLING_WINDOW_DAYS) continue;
    const k = dealKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(d);
  }
  merged.sort((a, b) => (a.date_iso < b.date_iso ? 1 : -1));

  return {
    schema_version: "nse-bulk-block-rolling-v1",
    built_at: new Date().toISOString(),
    window_days: ROLLING_WINDOW_DAYS,
    deal_count: merged.length,
    deals: merged,
  };
}

export function writeDealsRolling(payload, opts = {}) {
  const filePath = opts.path || ROLLING_PATH;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Per-symbol institutional-flow rollup over the window. For each
 * symbol that had any deal activity, emit:
 *   {
 *     net_buys: int,         // count
 *     net_sells: int,        // count
 *     net_qty_buy_minus_sell, // signed
 *     net_notional_inr,      // signed; positive = net buy
 *     last_deal_date_iso,
 *     deals: [...],          // raw rows for the modal
 *   }
 *
 * Returns Map<symbol, summary>.
 */
export function buildPerSymbolDealIndex(rolling) {
  const map = new Map();
  for (const d of rolling?.deals || []) {
    if (!d.symbol) continue;
    const e = map.get(d.symbol) || {
      net_buys: 0,
      net_sells: 0,
      net_qty: 0,
      net_notional_inr: 0,
      bulk_count: 0,
      block_count: 0,
      last_deal_date_iso: null,
      deals: [],
    };
    if (d.side === "BUY") {
      e.net_buys += 1;
      if (d.qty != null) e.net_qty += d.qty;
      if (d.notional_inr != null) e.net_notional_inr += d.notional_inr;
    } else if (d.side === "SELL") {
      e.net_sells += 1;
      if (d.qty != null) e.net_qty -= d.qty;
      if (d.notional_inr != null) e.net_notional_inr -= d.notional_inr;
    }
    if (d.kind === "BULK") e.bulk_count += 1;
    if (d.kind === "BLOCK") e.block_count += 1;
    if (!e.last_deal_date_iso || (d.date_iso && d.date_iso > e.last_deal_date_iso)) {
      e.last_deal_date_iso = d.date_iso;
    }
    e.deals.push(d);
    map.set(d.symbol, e);
  }
  return map;
}
