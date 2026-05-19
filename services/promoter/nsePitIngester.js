/**
 * nsePitIngester.js
 *
 * Fetches NSE SEBI Reg 7(2) insider/promoter transaction disclosures
 * (the "PIT" feed) and writes a rolling 30-day deduped window for
 * consumption by the Earnings Edge filter and Compounder Lab rank
 * booster.
 *
 * NSE endpoint:
 *   /api/corporates-pit?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
 *
 * MUST run from a local machine — NSE rejects Vercel datacenter IPs
 * from the cookie-source endpoint (see nse.js:76-83). Vercel cron just
 * reads the JSON file.
 *
 * Output:
 *   data/promoter-transactions/rolling-30d.json  (deduped window)
 *   data/promoter-transactions/last-refresh-status.json  (staleness alert source)
 *
 * Schema per transaction (normalised):
 *   {
 *     symbol, name, person_name, category (Promoter|Director|KMP|Other),
 *     txn_type (BUY|SELL|PLEDGE|RELEASE|OTHER),
 *     shares,
 *     value_inr_cr,
 *     txn_date_iso, filing_date_iso,
 *     post_holding_pct,
 *     mode_of_acquisition,
 *     raw_remarks,
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { nseGet } from "../../nse.js";

const ROOT = process.cwd();
const ROLLING_PATH = path.join(ROOT, "data", "promoter-transactions", "rolling-30d.json");
export const STATUS_PATH = path.join(ROOT, "data", "promoter-transactions", "last-refresh-status.json");
const ROLLING_WINDOW_DAYS = 30;
// Adversarial A9: alert if data ages past this threshold (loud failure
// in the nightly health summary).
export const STALENESS_ALERT_HOURS = 36;

function fmtDateForNse(d) {
  // NSE expects DD-MM-YYYY.
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function parseNseTimestamp(s) {
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

function classifyTxn(modeOfAcquisition, remarks) {
  const hay = `${modeOfAcquisition || ""} ${remarks || ""}`.toLowerCase();
  if (/(sale|sell|sold|s$)/i.test(modeOfAcquisition || "")) return "SELL";
  if (/(purchase|buy|bought|p$)/i.test(modeOfAcquisition || "")) return "BUY";
  if (hay.includes("pledge") && hay.includes("release")) return "RELEASE";
  if (hay.includes("pledge") || hay.includes("invoke")) return "PLEDGE";
  if (hay.includes("market")) {
    if (hay.includes("sell") || hay.includes("sale")) return "SELL";
    if (hay.includes("buy") || hay.includes("purchase")) return "BUY";
  }
  return "OTHER";
}

function normalizeCategory(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("promoter")) return "Promoter";
  if (s.includes("director")) return "Director";
  if (s.includes("kmp") || s.includes("key managerial")) return "KMP";
  return "Other";
}

// Public for unit testing
export function normalizeRow(row) {
  if (!row || typeof row !== "object") return null;
  const symbol = (row.symbol || row.Symbol || "").toString().trim().toUpperCase();
  if (!symbol) return null;
  const txn_date_iso = parseNseTimestamp(row.acqfromDt || row.date || row.txnDate);
  if (!txn_date_iso) return null;
  const shares = Number(
    (row.secAcq || row.secVal || row.secAcqValue || row.acqAmt || "").toString().replace(/,/g, ""),
  );
  const value_raw = Number(
    (row.acqAmt || row.value || row.totalValue || "").toString().replace(/,/g, ""),
  );
  const txn_type = classifyTxn(row.acqMode, row.remarks);
  return {
    symbol,
    name: row.company || row.Company || row.name || null,
    person_name: row.anex || row.acqName || row.name || null,
    category: normalizeCategory(row.personCategory || row.category || row.acqPerson),
    txn_type,
    shares: Number.isFinite(shares) && shares > 0 ? shares : null,
    value_inr_cr: Number.isFinite(value_raw) && value_raw > 0 ? value_raw / 1e7 : null,
    txn_date_iso,
    filing_date_iso: parseNseTimestamp(row.dt || row.filingDate),
    post_holding_pct: Number(row.afterAcqSharesPer || row.holdingPctAfter) || null,
    mode_of_acquisition: row.acqMode || null,
    raw_remarks: row.remarks || null,
  };
}

export async function fetchPitWindow(daysBack = ROLLING_WINDOW_DAYS) {
  const to = new Date();
  const from = new Date(Date.now() - daysBack * 86_400_000);
  const url = `/api/corporates-pit?index=equities&from_date=${fmtDateForNse(from)}&to_date=${fmtDateForNse(to)}`;
  const refererSymbol = "RELIANCE"; // any real symbol works
  const res = await nseGet(url, refererSymbol);
  if (!res || !Array.isArray(res.data)) return null;
  const out = [];
  for (const row of res.data) {
    const n = normalizeRow(row);
    if (n) out.push(n);
  }
  return out;
}

export function loadRolling() {
  if (!fs.existsSync(ROLLING_PATH)) {
    return { schema_version: "promoter-pit-rolling-v1", window_days: ROLLING_WINDOW_DAYS, transactions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ROLLING_PATH, "utf-8"));
  } catch {
    return { schema_version: "promoter-pit-rolling-v1", window_days: ROLLING_WINDOW_DAYS, transactions: [] };
  }
}

function dedupKey(t) {
  return `${t.symbol}|${t.person_name}|${t.txn_type}|${t.txn_date_iso}|${t.shares}`;
}

export function mergeIntoRolling(existing, fresh, opts = {}) {
  const windowDays = opts.windowDays || ROLLING_WINDOW_DAYS;
  const today = opts.today_iso || new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(today) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const seen = new Map();
  for (const t of (existing?.transactions || [])) {
    if (!t.txn_date_iso || t.txn_date_iso < cutoff) continue;
    seen.set(dedupKey(t), t);
  }
  for (const t of (fresh || [])) {
    if (!t.txn_date_iso || t.txn_date_iso < cutoff) continue;
    seen.set(dedupKey(t), t); // fresh overwrites
  }
  const transactions = Array.from(seen.values()).sort((a, b) =>
    String(b.txn_date_iso).localeCompare(String(a.txn_date_iso)),
  );
  return {
    schema_version: "promoter-pit-rolling-v1",
    window_days: windowDays,
    as_of: today,
    refreshed_at_iso: new Date().toISOString(),
    transaction_count: transactions.length,
    transactions,
  };
}

export function writeRolling(merged) {
  if (!fs.existsSync(path.dirname(ROLLING_PATH))) {
    fs.mkdirSync(path.dirname(ROLLING_PATH), { recursive: true });
  }
  const tmp = `${ROLLING_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, ROLLING_PATH);
}

export function writeStatus(status) {
  if (!fs.existsSync(path.dirname(STATUS_PATH))) {
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  }
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
}

export function readStatus() {
  if (!fs.existsSync(STATUS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function evaluateStaleness(status, nowMs = Date.now(), alertHours = STALENESS_ALERT_HOURS) {
  if (!status || !status.last_success_iso) {
    return { stale: true, hours_since: null, reason: "never-succeeded" };
  }
  const lastMs = Date.parse(status.last_success_iso);
  if (!Number.isFinite(lastMs)) {
    return { stale: true, hours_since: null, reason: "invalid-timestamp" };
  }
  const hours = (nowMs - lastMs) / 3_600_000;
  return {
    stale: hours > alertHours,
    hours_since: Math.round(hours * 10) / 10,
    alert_threshold_hours: alertHours,
    reason: hours > alertHours ? "stale-beyond-threshold" : "ok",
  };
}

// Aggregate net-buy signal per symbol over a window (last N days). Used by
// the Earnings Edge filter as a rejection signal — recent promoter SELL
// activity vetoes a BEAT entry.
export function computePromoterSignal(rolling, opts = {}) {
  const windowDays = opts.windowDays || 7;
  const today = opts.today_iso || new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(today) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const bySymbol = new Map();
  for (const t of (rolling?.transactions || [])) {
    if (t.category !== "Promoter") continue;
    if (!t.txn_date_iso || t.txn_date_iso < cutoff) continue;
    const cur = bySymbol.get(t.symbol) || { buys_inr_cr: 0, sells_inr_cr: 0, txn_count: 0 };
    if (t.txn_type === "BUY") cur.buys_inr_cr += Number(t.value_inr_cr) || 0;
    if (t.txn_type === "SELL") cur.sells_inr_cr += Number(t.value_inr_cr) || 0;
    cur.txn_count++;
    bySymbol.set(t.symbol, cur);
  }
  const out = Object.create(null);
  for (const [sym, agg] of bySymbol) {
    out[sym] = {
      ...agg,
      net_inr_cr: agg.buys_inr_cr - agg.sells_inr_cr,
      direction: agg.buys_inr_cr > agg.sells_inr_cr ? "BUY" : agg.sells_inr_cr > agg.buys_inr_cr ? "SELL" : "NEUTRAL",
    };
  }
  return out;
}
