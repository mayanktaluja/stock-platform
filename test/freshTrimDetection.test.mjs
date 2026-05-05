/**
 * Regression tests for services/postTrimCooldown.js — the recent-trim
 * detector. Note: the cooldown engine that softened reductions was removed
 * (2026-05-06); detection now powers an informational chip only.
 *
 * Covers:
 *   • detectFreshTrim — fresh-trim trigger (qty drop ≥ 10%)
 *   • detectFreshTrim — memory trigger (lastTrimmedAt within window)
 *   • detectFreshTrim — defensive (null priorRow, NaN qty, custom thresholds)
 *   • annotateRecentTrims — attaches recentTrimInfo, never alters action
 *   • annotateRecentTrims — null prior snapshot is a no-op
 *   • annotateRecentTrims — does not mutate inputs
 *   • buildSnapshot — quantity + lastTrimmedAt persistence
 *
 * Run with: node test/freshTrimDetection.test.mjs
 */

import { detectFreshTrim, annotateRecentTrims } from "../services/postTrimCooldown.js";
import { buildSnapshot } from "../services/analyzerDiff.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

function holding(ticker, action, qty, opts = {}) {
  return {
    quantity: qty,
    sws: { ticker, v3_score: opts.v3 ?? 50, snowflake_total: 12, surveillance: opts.surveillance ?? null },
    swsCovered: true,
    action,
    currentValue: opts.currentValue ?? (qty * 100),
  };
}

const FIXED_NOW = "2026-05-05T00:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW);

// ──────────────────── detectFreshTrim ────────────────────

console.log("\ndetectFreshTrim — fresh-trim trigger\n");
{
  const h = holding("CIPLA", "Reduction-25%", 11);
  const priorRow = { quantity: 15, lastTrimmedAt: null }; // qty 15 → 11 = 26.7% drop
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("isRecent true on 26.7% drop", ev.isRecent === true, ev);
  assert("source=fresh", ev.source === "fresh", ev.source);
  assert("trimmedPct ~ 27", ev.trimmedPct === 27, ev.trimmedPct);
  assert("daysAgo = 0", ev.daysAgo === 0, ev.daysAgo);
  assert("trimmedAt stamped to now", ev.trimmedAt === FIXED_NOW, ev.trimmedAt);
}
{
  const h = holding("XYZ", "Reduction-25%", 100);
  const priorRow = { quantity: 105, lastTrimmedAt: null }; // 4.7% drop — below threshold
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("4.7% drop does NOT trigger fresh", ev.isRecent === false, ev);
}
{
  const h = holding("ABC", "Reduction-25%", 100);
  const priorRow = { quantity: 90, lastTrimmedAt: null }; // qty went UP
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("qty increase does NOT trigger", ev.isRecent === false, ev);
}

console.log("\ndetectFreshTrim — memory trigger\n");
{
  const h = holding("CIPLA", "Reduction-25%", 11);
  const sevenDaysAgo = new Date(FIXED_NOW_MS - 7 * 86400000).toISOString();
  const priorRow = { quantity: 11, lastTrimmedAt: sevenDaysAgo };
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("memory trigger fires inside 14d window", ev.isRecent === true, ev);
  assert("source=memory", ev.source === "memory", ev.source);
  assert("daysAgo ~ 7", ev.daysAgo === 7, ev.daysAgo);
}
{
  const h = holding("STALE", "Reduction-25%", 50);
  const twentyDaysAgo = new Date(FIXED_NOW_MS - 20 * 86400000).toISOString();
  const priorRow = { quantity: 50, lastTrimmedAt: twentyDaysAgo };
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("memory trigger expires after 14d", ev.isRecent === false, ev);
}

console.log("\ndetectFreshTrim — defensive\n");
{
  const h = holding("X", "Reduction-25%", 95);
  const priorRow = { quantity: 100, lastTrimmedAt: null };
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS, trimDetectionPct: 0.05 });
  assert("custom 5% threshold: 5% drop fires", ev.isRecent === true, ev);
}
{
  const h = holding("X", "Reduction-25%", 100);
  const ev = detectFreshTrim({ holding: h, priorRow: null, now: FIXED_NOW_MS });
  assert("null priorRow → not recent", ev.isRecent === false, ev);
}
{
  const h = { quantity: NaN, sws: { ticker: "X" } };
  const priorRow = { quantity: 100, lastTrimmedAt: null };
  const ev = detectFreshTrim({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("NaN current qty → not recent", ev.isRecent === false, ev);
}

// ──────────────────── annotateRecentTrims ────────────────────

console.log("\nannotateRecentTrims — never alters action\n");
{
  const holdings = [
    holding("CIPLA",  "Reduction-25%", 11),
    holding("ARE&M",  "Reduction-25%", 60),
    holding("NETWEB", "Top-up-50%",    6),
    holding("HDFC",   "HOLD",          80),
    holding("BADCO",  "EXIT-now",      10),
  ];
  const priorRows = [
    { ticker: "CIPLA",  quantity: 15, lastTrimmedAt: null }, // user trimmed 26.7%
    { ticker: "ARE&M",  quantity: 60, lastTrimmedAt: null },
    { ticker: "NETWEB", quantity: 5,  lastTrimmedAt: null },
    { ticker: "HDFC",   quantity: 80, lastTrimmedAt: null },
    { ticker: "BADCO",  quantity: 10, lastTrimmedAt: null },
  ];
  const out = annotateRecentTrims(holdings, { rows: priorRows }, { now: FIXED_NOW_MS });

  const cipla = out.find((h) => h.sws.ticker === "CIPLA");
  const arem = out.find((h) => h.sws.ticker === "ARE&M");
  const netweb = out.find((h) => h.sws.ticker === "NETWEB");

  // Critical: actions must NOT change. The recommendation rides through.
  assert("CIPLA action UNCHANGED (still Reduction-25%)", cipla.action === "Reduction-25%", cipla.action);
  assert("CIPLA carries recentTrimInfo", cipla.recentTrimInfo?.source === "fresh", cipla.recentTrimInfo);
  assert("CIPLA recentTrimInfo.trimmedPct ~ 27", cipla.recentTrimInfo.trimmedPct === 27, cipla.recentTrimInfo);
  assert("ARE&M no recentTrimInfo (no qty change)", !arem.recentTrimInfo, arem);
  assert("ARE&M action unchanged", arem.action === "Reduction-25%", arem.action);
  assert("NETWEB top-up untouched", netweb.action === "Top-up-50%", netweb.action);
}

console.log("\nannotateRecentTrims — null prior snapshot\n");
{
  const holdings = [holding("X", "Reduction-25%", 100)];
  const out = annotateRecentTrims(holdings, null, { now: FIXED_NOW_MS });
  assert("first run: action unchanged", out[0].action === "Reduction-25%", out[0].action);
  assert("first run: no recentTrimInfo", !out[0].recentTrimInfo, out[0]);
  assert("first run: input not mutated", holdings[0].action === "Reduction-25%" && !holdings[0].recentTrimInfo, holdings[0]);
}

console.log("\nannotateRecentTrims — does not mutate input\n");
{
  const original = holding("X", "Reduction-50%", 50);
  const before = JSON.stringify(original);
  annotateRecentTrims([original], { rows: [{ ticker: "X", quantity: 100, lastTrimmedAt: null }] }, { now: FIXED_NOW_MS });
  const after = JSON.stringify(original);
  assert("input holding object untouched", before === after, { before, after });
}

// ──────────────────── buildSnapshot quantity persistence ────────────────────

console.log("\nbuildSnapshot — quantity + lastTrimmedAt\n");
{
  const holdings = [holding("X", "HOLD", 100)];
  const snap = buildSnapshot(holdings);
  assert("snapshot row carries quantity", snap.rows[0].quantity === 100, snap.rows[0]);
  assert("snapshot row carries lastTrimmedAt = null on first build", snap.rows[0].lastTrimmedAt === null, snap.rows[0]);
}
{
  const holdings = [holding("X", "Reduction-25%", 75)];
  const priorByTicker = new Map([["X", { quantity: 100, lastTrimmedAt: null }]]);
  const snap = buildSnapshot(holdings, { priorByTicker, now: FIXED_NOW });
  assert("buildSnapshot detects fresh trim and stamps lastTrimmedAt", snap.rows[0].lastTrimmedAt === FIXED_NOW, snap.rows[0]);
}
{
  const oldStamp = "2026-05-01T00:00:00.000Z";
  const holdings = [holding("X", "Reduction-25%", 75)]; // qty unchanged from prior
  const priorByTicker = new Map([["X", { quantity: 75, lastTrimmedAt: oldStamp }]]);
  const snap = buildSnapshot(holdings, { priorByTicker, now: FIXED_NOW });
  assert("buildSnapshot carries lastTrimmedAt forward when no fresh trim", snap.rows[0].lastTrimmedAt === oldStamp, snap.rows[0]);
}

// ──────────────────── Summary ────────────────────

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
