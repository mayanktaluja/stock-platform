/**
 * indianMarketFilters.js — SEBI-grade market-microstructure gates for the
 * Market Scanner. Sits alongside the existing earnings-blackout, sector-
 * exclusion, and R:R guards.
 *
 * Three gates:
 *   1. ADV (Average Daily traded Value) floor — picks below the floor are
 *      hard to exit cleanly. Computed from the 20-trading-day rolling mean
 *      of (close × volume) using the historical bars the scanner already
 *      fetches; no extra round-trip.
 *   2. NSE Surveillance overlay — reuses surveillance.js (ASM + GSM lists,
 *      cron-refreshed daily) to exclude GSM (always) and ASM Stage 2/3/4
 *      (Stage 1 is informational and stays). A SEBI RA recommending a GSM
 *      stock without flagging is a §16 red flag.
 *   3. F&O ban list — picks with positions over the 95% market-wide
 *      derivative limit are vulnerable to forced unwinds and should be
 *      excluded from a swing/value scanner. NSE publishes the daily list
 *      at archives.nseindia.com/content/fo/fo_secban.csv.
 *
 * Each gate is a separate function so callers can compose. The combined
 * `passesIndianMarketFilters(...)` returns `{ pass, reasons }` so the
 * scanner can attribute drop-offs in diagnostics.
 *
 * All filters fail OPEN (allow) when their data source is unavailable.
 * That's intentional — silently dropping every pick when an NSE feed
 * is down is worse than letting through one extra borderline pick.
 */

import { getSurveillanceFlag } from "../surveillance.js";

// ─── ADV (Average Daily traded Value) ───────────────────────────

/**
 * 20-trading-day average ₹ traded value. Uses the historical bars the
 * scanner already fetches — no extra HTTP. Returns null when fewer than
 * 20 bars are available; caller should treat null as "unknown" not "fail."
 *
 * @param {{close:number, volume:number, date?:string}[]} historical
 * @returns {number|null} ADV in ₹ (Indian Rupees), or null
 */
export function computeAdv20Day(historical) {
  if (!Array.isArray(historical) || historical.length < 20) return null;
  const last20 = historical.slice(-20);
  let sum = 0;
  let n = 0;
  for (const bar of last20) {
    const close = Number(bar?.close);
    const volume = Number(bar?.volume);
    if (Number.isFinite(close) && Number.isFinite(volume) && close > 0 && volume >= 0) {
      sum += close * volume;
      n++;
    }
  }
  if (n === 0) return null;
  return sum / n;
}

// Default ADV floors (in ₹ Crore, converted to ₹ inside the gate).
// Calibrated for the Indian market:
//   - Nifty 100: ₹25 Cr (most large-cap names sit at ₹50–500 Cr ADV)
//   - Expanded ~750 universe: ₹5 Cr (smaller mid/small-caps)
//   - Microcap-only: ₹2 Cr (lower bar, but still excludes shells)
export const ADV_FLOORS_RUPEES = Object.freeze({
  nifty100:  25 * 1e7, // 25 Cr
  expanded:  5 * 1e7,  // 5 Cr
  microcap:  2 * 1e7,  // 2 Cr
});

export function getAdvFloor(universe) {
  if (universe === "expanded") return ADV_FLOORS_RUPEES.expanded;
  if (universe === "microcap") return ADV_FLOORS_RUPEES.microcap;
  return ADV_FLOORS_RUPEES.nifty100;
}

// ─── NSE Surveillance (ASM Stage 2/3/4 + all GSM) ───────────────

/**
 * Returns the surveillance flag if the stock should be excluded from
 * scanner picks; null if it's clean or only on Stage 1 (informational).
 */
export function getExcludingSurveillance(symbol) {
  const flag = getSurveillanceFlag(symbol);
  if (!flag) return null;
  // GSM is always exclusionary — these are the strictest regulatory regimes.
  if (flag.list === "GSM") return flag;
  // ASM: only Stage 2 and above (Stage 1 is informational warning).
  if (flag.list === "ASM") {
    const stage = String(flag.stage || "").toLowerCase();
    if (/stage\s*[2-4]/.test(stage)) return flag;
  }
  return null;
}

// ─── NSE F&O Ban List ───────────────────────────────────────────
//
// NSE publishes the daily F&O ban list at:
//   https://archives.nseindia.com/content/fo/fo_secban.csv
// CSV shape (typically): Sr. No.,Security
// Symbols are bare (e.g., "RELIANCE", not "RELIANCE-EQ" or "RELIANCE.NS").
//
// The list rolls over daily; cache for 4 hours (well below the 1-day
// staleness threshold but enough to avoid hammering the archive on every
// scan). Single-flight to prevent thundering-herd on cache miss.

const FNO_BAN_URL = "https://archives.nseindia.com/content/fo/fo_secban.csv";
const FNO_BAN_TTL_MS = 4 * 60 * 60 * 1000; // 4h

let _fnoBanCache = null;     // { fetchedAt:Date, set:Set<string> }
let _fnoBanInflight = null;  // Promise<Set<string>>

async function fetchFnoBanFresh() {
  const res = await fetch(FNO_BAN_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Starbhai/1.0)",
      Accept: "text/csv,*/*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fno-ban HTTP ${res.status}`);
  const text = await res.text();
  const set = new Set();
  // Robust CSV parse: skip header rows, take last column (security name).
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (/^sr\.?\s*no/i.test(line)) continue; // header
    const cols = line.split(",").map((s) => s.trim());
    if (cols.length === 0) continue;
    const sym = (cols[cols.length - 1] || "").toUpperCase();
    if (!sym || /^security$/i.test(sym)) continue;
    set.add(sym);
  }
  return set;
}

/**
 * Returns the current F&O ban set (NSE symbols, bare — no .NS suffix).
 * Cached 4 hours. Returns an empty set if NSE is unreachable.
 */
export async function loadFnoBanSet() {
  const now = Date.now();
  if (_fnoBanCache && (now - _fnoBanCache.fetchedAt) < FNO_BAN_TTL_MS) {
    return _fnoBanCache.set;
  }
  if (_fnoBanInflight) return _fnoBanInflight;
  _fnoBanInflight = (async () => {
    try {
      const set = await fetchFnoBanFresh();
      _fnoBanCache = { fetchedAt: now, set };
      return set;
    } catch (err) {
      console.warn("[indianMarketFilters] F&O ban list fetch failed:", err.message);
      // Stale-while-failing: keep returning the previous set if we have one,
      // else empty. Empty is safer than throwing — fail-open.
      return _fnoBanCache?.set || new Set();
    } finally {
      _fnoBanInflight = null;
    }
  })();
  return _fnoBanInflight;
}

/**
 * Strip ".NS" / "-EQ" / etc. suffix to match the bare symbol form NSE
 * uses in its F&O ban CSV.
 */
export function bareNseSymbol(symbol) {
  if (!symbol) return "";
  return String(symbol).toUpperCase().replace(/\.NS$/i, "").replace(/-EQ$/i, "");
}

// ─── Composite gate ─────────────────────────────────────────────

/**
 * Run all three gates against a single pick. Caller should `await`
 * loadFnoBanSet() once per scan and pass the result via opts.fnoBanSet.
 *
 * @param {object} pick               { symbol, ... }
 * @param {object[]} historical       OHLCV bars used for ADV computation
 * @param {object} opts
 * @param {Set<string>} opts.fnoBanSet  result of loadFnoBanSet()
 * @param {string} opts.universe        "nifty100" | "expanded" | "microcap"
 * @returns {{pass: boolean, reasons: string[], advRupees: number|null}}
 */
export function passesIndianMarketFilters(pick, historical, opts = {}) {
  const reasons = [];
  // 1. ADV
  const adv = computeAdv20Day(historical);
  const floor = getAdvFloor(opts.universe);
  if (adv != null && adv < floor) {
    reasons.push(`adv_below_floor:${(adv / 1e7).toFixed(1)}Cr<${(floor / 1e7).toFixed(1)}Cr`);
  }
  // 2. Surveillance
  const surv = getExcludingSurveillance(pick.symbol);
  if (surv) {
    reasons.push(`surveillance:${surv.list}${surv.stage ? `(${surv.stage})` : ""}`);
  }
  // 3. F&O ban
  if (opts.fnoBanSet && opts.fnoBanSet.size > 0) {
    if (opts.fnoBanSet.has(bareNseSymbol(pick.symbol))) {
      reasons.push("fno_ban");
    }
  }
  return { pass: reasons.length === 0, reasons, advRupees: adv };
}
