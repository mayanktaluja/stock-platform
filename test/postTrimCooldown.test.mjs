/**
 * Regression tests for services/postTrimCooldown.js — the cooldown that
 * suppresses repeat Reduction-* recommendations on holdings the user
 * already trimmed.
 *
 * Covers:
 *   • Fresh-trim trigger (qty drop ≥ 10% vs prior snapshot)
 *   • Memory trigger (lastTrimmedAt within cooldown window)
 *   • Top-ups + HOLD + EXIT are never softened
 *   • Untouched holdings flow through unchanged
 *   • No prior snapshot → no cooldowns applied (first-run path)
 *   • Per-row originalAction + cooldown metadata are populated
 *   • cooledCount aggregated across the run
 *
 * Run with: node test/postTrimCooldown.test.mjs
 */

import { evaluateCooldown, applyPostTrimCooldown } from "../services/postTrimCooldown.js";
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

// ──────────────────── evaluateCooldown ────────────────────

console.log("\nevaluateCooldown — fresh-trim trigger\n");
{
  const h = holding("CIPLA", "Reduction-25%", 11);
  const priorRow = { quantity: 15, lastTrimmedAt: null }; // qty 15 → 11 = 26.7% drop
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("inCooldown true on 26.7% drop", ev.inCooldown === true, ev);
  assert("source=fresh", ev.source === "fresh", ev.source);
  assert("trimmedPct ~ 27", ev.trimmedPct === 27, ev.trimmedPct);
  assert("daysAgo = 0", ev.daysAgo === 0, ev.daysAgo);
  assert("trimmedAt stamped to now", ev.trimmedAt === FIXED_NOW, ev.trimmedAt);
}
{
  const h = holding("XYZ", "Reduction-25%", 100);
  const priorRow = { quantity: 105, lastTrimmedAt: null }; // 4.7% drop — below threshold
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("4.7% drop does NOT trigger fresh", ev.inCooldown === false, ev);
}
{
  const h = holding("ABC", "Reduction-25%", 100);
  const priorRow = { quantity: 90, lastTrimmedAt: null }; // qty went UP
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("qty increase does NOT trigger", ev.inCooldown === false, ev);
}

console.log("\nevaluateCooldown — memory trigger\n");
{
  const h = holding("CIPLA", "Reduction-25%", 11);
  const sevenDaysAgo = new Date(FIXED_NOW_MS - 7 * 86400000).toISOString();
  const priorRow = { quantity: 11, lastTrimmedAt: sevenDaysAgo };
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("memory trigger fires inside 14d window", ev.inCooldown === true, ev);
  assert("source=memory", ev.source === "memory", ev.source);
  assert("daysAgo ~ 7", ev.daysAgo === 7, ev.daysAgo);
}
{
  const h = holding("STALE", "Reduction-25%", 50);
  const twentyDaysAgo = new Date(FIXED_NOW_MS - 20 * 86400000).toISOString();
  const priorRow = { quantity: 50, lastTrimmedAt: twentyDaysAgo };
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("memory trigger expires after 14d", ev.inCooldown === false, ev);
}

console.log("\nevaluateCooldown — defensive\n");
{
  // Custom thresholds: 5% trim, 7d cooldown
  const h = holding("X", "Reduction-25%", 95);
  const priorRow = { quantity: 100, lastTrimmedAt: null };
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS, trimDetectionPct: 0.05 });
  assert("custom 5% threshold: 5% drop fires", ev.inCooldown === true, ev);
}
{
  const h = holding("X", "Reduction-25%", 100);
  const ev = evaluateCooldown({ holding: h, priorRow: null, now: FIXED_NOW_MS });
  assert("null priorRow → no cooldown", ev.inCooldown === false, ev);
}
{
  const h = { quantity: NaN, sws: { ticker: "X" } };
  const priorRow = { quantity: 100, lastTrimmedAt: null };
  const ev = evaluateCooldown({ holding: h, priorRow, now: FIXED_NOW_MS });
  assert("NaN current qty → no cooldown", ev.inCooldown === false, ev);
}

// ──────────────────── applyPostTrimCooldown ────────────────────

console.log("\napplyPostTrimCooldown — softens reductions only\n");
{
  const holdings = [
    holding("CIPLA",  "Reduction-25%", 11),  // trimmed
    holding("ARE&M",  "Reduction-25%", 60),  // NOT trimmed
    holding("NETWEB", "Top-up-50%",    6),   // top-up — never softened
    holding("HDFC",   "HOLD",          80),  // HOLD — never softened
    holding("BADCO",  "EXIT-now",      10),  // EXIT — never softened
  ];
  const priorRows = [
    { ticker: "CIPLA",  quantity: 15, lastTrimmedAt: null },
    { ticker: "ARE&M",  quantity: 60, lastTrimmedAt: null },
    { ticker: "NETWEB", quantity: 5,  lastTrimmedAt: null },  // user added
    { ticker: "HDFC",   quantity: 80, lastTrimmedAt: null },
    { ticker: "BADCO",  quantity: 10, lastTrimmedAt: null },
  ];
  const priorSnapshot = { rows: priorRows };
  const out = applyPostTrimCooldown(holdings, priorSnapshot, { now: FIXED_NOW_MS });

  assert("cooledCount === 1 (only CIPLA)", out.cooledCount === 1, out.cooledCount);
  const cipla = out.holdings.find((h) => h.sws.ticker === "CIPLA");
  const arem = out.holdings.find((h) => h.sws.ticker === "ARE&M");
  const netweb = out.holdings.find((h) => h.sws.ticker === "NETWEB");
  const hdfc = out.holdings.find((h) => h.sws.ticker === "HDFC");
  const badco = out.holdings.find((h) => h.sws.ticker === "BADCO");

  assert("CIPLA action softened to HOLD", cipla.action === "HOLD", cipla.action);
  assert("CIPLA originalAction = Reduction-25%", cipla.originalAction === "Reduction-25%", cipla.originalAction);
  assert("CIPLA carries recentlyTrimmedReason", typeof cipla.recentlyTrimmedReason === "string" && cipla.recentlyTrimmedReason.length > 0, cipla.recentlyTrimmedReason);
  assert("CIPLA cooldown.source=fresh", cipla.cooldown?.source === "fresh", cipla.cooldown);

  assert("ARE&M unchanged (no trim)", arem.action === "Reduction-25%" && !arem.recentlyTrimmedReason, arem);
  assert("NETWEB top-up not softened", netweb.action === "Top-up-50%", netweb.action);
  assert("HDFC HOLD unchanged", hdfc.action === "HOLD" && !hdfc.recentlyTrimmedReason, hdfc);
  assert("BADCO EXIT-now never softened", badco.action === "EXIT-now", badco.action);
}

console.log("\napplyPostTrimCooldown — null prior snapshot (first run)\n");
{
  const holdings = [holding("X", "Reduction-25%", 100)];
  const out = applyPostTrimCooldown(holdings, null, { now: FIXED_NOW_MS });
  assert("first run: cooledCount = 0", out.cooledCount === 0, out.cooledCount);
  assert("first run: action unchanged", out.holdings[0].action === "Reduction-25%", out.holdings[0].action);
  assert("first run: input array not mutated", holdings[0].action === "Reduction-25%" && !holdings[0].recentlyTrimmedReason, holdings[0]);
}

console.log("\napplyPostTrimCooldown — memory carry-forward across multi-run\n");
{
  // Run 1: user trims CIPLA from 15 → 11 (fresh trim)
  const run1Holdings = [holding("CIPLA", "Reduction-25%", 11)];
  const r1 = applyPostTrimCooldown(run1Holdings, { rows: [{ ticker: "CIPLA", quantity: 15, lastTrimmedAt: null }] }, { now: FIXED_NOW_MS });
  assert("run1: CIPLA softened (fresh trim)", r1.holdings[0].action === "HOLD", r1.holdings[0]);

  // Build the snapshot that would be persisted for run 2
  const run1Snapshot = buildSnapshot(r1.holdings, {
    priorByTicker: new Map([["CIPLA", { quantity: 15, lastTrimmedAt: null }]]),
    now: FIXED_NOW,
  });
  const run1Row = run1Snapshot.rows.find((r) => r.ticker === "CIPLA");
  assert("run1 snapshot stamps lastTrimmedAt", run1Row.lastTrimmedAt === FIXED_NOW, run1Row);

  // Run 2 — 5 days later, no further trim. Memory trigger should fire.
  const run2NowIso = "2026-05-10T00:00:00.000Z";
  const run2NowMs = Date.parse(run2NowIso);
  const run2Holdings = [holding("CIPLA", "Reduction-25%", 11)]; // qty unchanged
  const r2 = applyPostTrimCooldown(run2Holdings, run1Snapshot, { now: run2NowMs });
  assert("run2: still in cooldown via memory trigger", r2.holdings[0].action === "HOLD", r2.holdings[0]);
  assert("run2: cooldown.source=memory", r2.holdings[0].cooldown?.source === "memory", r2.holdings[0].cooldown);
  assert("run2: daysAgo ~ 5", r2.holdings[0].cooldown?.daysAgo === 5, r2.holdings[0].cooldown);

  // Run 3 — 20 days later. Cooldown expired. Reduction surfaces again.
  const run2Snapshot = buildSnapshot(r2.holdings, {
    priorByTicker: new Map(run1Snapshot.rows.map((r) => [r.ticker, r])),
    now: run2NowIso,
  });
  const run3NowIso = "2026-05-25T00:00:00.000Z";
  const run3NowMs = Date.parse(run3NowIso);
  const run3Holdings = [holding("CIPLA", "Reduction-25%", 11)];
  const r3 = applyPostTrimCooldown(run3Holdings, run2Snapshot, { now: run3NowMs });
  assert("run3: cooldown expired, Reduction surfaces", r3.holdings[0].action === "Reduction-25%", r3.holdings[0].action);
  assert("run3: no cooldown metadata", !r3.holdings[0].recentlyTrimmedReason, r3.holdings[0]);
}

console.log("\napplyPostTrimCooldown — does not mutate input\n");
{
  const original = holding("X", "Reduction-50%", 50);
  const before = JSON.stringify(original);
  applyPostTrimCooldown([original], { rows: [{ ticker: "X", quantity: 100, lastTrimmedAt: null }] }, { now: FIXED_NOW_MS });
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
