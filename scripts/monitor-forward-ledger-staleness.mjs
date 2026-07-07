#!/usr/bin/env node
/**
 * Forward-ledger staleness guard (defence-in-depth, non-blocking).
 * ================================================================
 *
 * The Track Record forward ledger (data/track-record/paper-trades-live.jsonl)
 * only produces a real, resolvable track record if the nightly snapshot keeps
 * ACCRUING fresh V2 rows (rows with returns_by_horizon). It went silently
 * dormant for ~2 months once already (no accrual 2026-05-08 -> 2026-07-06) —
 * exactly the kind of outage that hides for weeks because nothing errors.
 *
 * This monitor reads the ledger, finds the most recent V2 snapshot, and warns
 * if the ledger hasn't accrued in more than STALE_DAYS. It also surfaces how
 * many rows have actually RESOLVED (a closed horizon) so "0 resolved" is
 * visible rather than mistaken for "working". It never mutates anything and
 * always exits 0 so it can sit in the nightly chain / a cron harmlessly.
 *
 * Usage:
 *   node scripts/monitor-forward-ledger-staleness.mjs
 *   node scripts/monitor-forward-ledger-staleness.mjs --json
 *   node scripts/monitor-forward-ledger-staleness.mjs --stale-days 4
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const LEDGER_PATH = path.join(REPO, "data", "track-record", "paper-trades-live.jsonl");
const DEFAULT_STALE_DAYS = 4; // allow a long weekend + a holiday before crying wolf

// A row is "resolved" once any horizon slot has closed (status closed / alpha set).
function isResolved(trade) {
  const rbh = trade && trade.returns_by_horizon;
  if (!rbh || typeof rbh !== "object") return false;
  return Object.values(rbh).some((h) => h && (h.status === "closed" || h.alpha_pct != null || h.return_pct != null));
}

// computeLedgerFreshness(trades, nowMs, staleDays) — pure + testable.
// Returns the latest V2 accrual date, days since, staleness flag, and counts.
export function computeLedgerFreshness(trades, nowMs, staleDays = DEFAULT_STALE_DAYS) {
  const list = Array.isArray(trades) ? trades : [];
  const v2 = list.filter((t) => t && t.returns_by_horizon && t.target_horizons);
  let latestMs = null;
  for (const t of v2) {
    const at = t.snapshotAt ? Date.parse(t.snapshotAt) : NaN;
    if (Number.isFinite(at) && (latestMs == null || at > latestMs)) latestMs = at;
  }
  const daysSince = latestMs == null ? null : (nowMs - latestMs) / 86400000;
  const resolved = v2.filter(isResolved).length;
  return {
    total_rows: list.length,
    v2_rows: v2.length,
    resolved_rows: resolved,
    latest_v2_snapshot: latestMs == null ? null : new Date(latestMs).toISOString().slice(0, 10),
    days_since_accrual: daysSince == null ? null : +daysSince.toFixed(1),
    stale_threshold_days: staleDays,
    // Stale if we have V2 rows but they stopped accruing, OR there are no V2 rows at all.
    stale: v2.length === 0 || (daysSince != null && daysSince > staleDays),
  };
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return null;
  const out = [];
  const lines = fs.readFileSync(LEDGER_PATH, "utf8").split("\n");
  for (const ln of lines) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { /* skip malformed */ }
  }
  return out;
}

function main() {
  const asJson = process.argv.includes("--json");
  const sdIdx = process.argv.indexOf("--stale-days");
  const staleDays = sdIdx !== -1 ? parseInt(process.argv[sdIdx + 1], 10) : DEFAULT_STALE_DAYS;
  const trades = loadLedger();
  if (!trades) {
    const msg = { ok: false, reason: "forward ledger absent", stale: true };
    console.log(asJson ? JSON.stringify(msg) : "[ledger-monitor] forward ledger absent — nothing accruing (stale).");
    process.exit(0);
  }
  const r = computeLedgerFreshness(trades, Date.now(), staleDays);
  const report = { ok: true, ...r };
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  console.log("\n=== Forward-ledger staleness guard (non-blocking) ===");
  console.log(`ledger: ${r.total_rows} rows | ${r.v2_rows} V2 (resolvable) | ${r.resolved_rows} resolved`);
  console.log(`latest V2 accrual: ${r.latest_v2_snapshot ?? "—"}  (${r.days_since_accrual ?? "—"} days ago; threshold ${r.stale_threshold_days}d)`);
  if (r.stale) {
    console.log("\n⚠️  STALE — the forward ledger has not accrued fresh V2 rows. The nightly");
    console.log("   Track Record snapshot may be dormant (it silently was for ~2 months once).");
  } else {
    console.log("\n✓ Accruing normally.");
  }
  if (r.v2_rows > 0 && r.resolved_rows === 0) {
    console.log("ℹ  0 resolved yet — the oldest V2 rows haven't reached their first horizon");
    console.log("   anniversary. section-performance correctly stays 'illustrative' until they do.");
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
