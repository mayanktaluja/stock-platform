/**
 * Regression tests for services/analyzerDiff.js — the "since last review"
 * snapshot diff that powers the analyzer's diff banner.
 *
 * Covers:
 *   • buildSnapshot() output shape (lightweight per-row tuple)
 *   • First-run path (prev = null) → hasChanges:false
 *   • Action change detection (Reduction-50% → HOLD)
 *   • Score change (delta ≥ 5 fires; smaller jitter ignored)
 *   • New holding detection
 *   • Exited holding detection
 *   • Surveillance flag added/removed
 *   • Plain-English summary string
 *   • Sort stability
 *
 * Run with: node test/analyzerDiff.test.mjs
 */

import { buildSnapshot, diffSnapshots } from "../services/analyzerDiff.js";

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

// Helpers
function holding(ticker, action, v3, surveillance = null, currentValue = 1000) {
  return {
    sws: { ticker, v3_score: v3, surveillance, snowflake_total: 12 },
    action,
    currentValue,
  };
}

// ──────────────────── buildSnapshot ────────────────────

console.log("\nbuildSnapshot\n");
{
  const s = buildSnapshot([
    holding("RELIANCE", "HOLD", 50),
    holding("TCS", "Top-up-50%", 60),
  ]);
  assert("rows.length matches input", s.rows.length === 2, s.rows.length);
  assert("totalValue summed", s.totalValue === 2000, s.totalValue);
  assert("holdingsCount = 2", s.holdingsCount === 2, s.holdingsCount);
  assert("generatedAt is ISO", typeof s.generatedAt === "string" && s.generatedAt.length > 0, s.generatedAt);
  assert("first row carries ticker + action + v3Score",
    s.rows[0].ticker === "RELIANCE" && s.rows[0].action === "HOLD" && s.rows[0].v3Score === 50,
    s.rows[0]);
  assert("surveillance null on no-flag holding", s.rows[0].surveillance === null, s.rows[0].surveillance);
}

// ──────────────────── First run path ────────────────────

console.log("\nFirst run\n");
{
  const cur = buildSnapshot([holding("X", "HOLD", 50)]);
  const d = diffSnapshots(null, cur);
  assert("null prev → hasChanges false", d.hasChanges === false, d);
  assert("null prev → summary mentions first run", /first run/i.test(d.summary), d.summary);
  assert("null prev → all change arrays empty",
    d.actionChanges.length === 0 && d.scoreChanges.length === 0 &&
    d.newHoldings.length === 0 && d.exitedHoldings.length === 0 &&
    d.surveillanceChanges.length === 0,
    d);
}

// ──────────────────── Action change ────────────────────

console.log("\nAction change\n");
{
  const prev = buildSnapshot([holding("X", "Reduction-50%", 18)]);
  const cur  = buildSnapshot([holding("X", "HOLD", 35)]);
  const d = diffSnapshots(prev, cur);
  assert("action change recorded", d.actionChanges.length === 1, d.actionChanges);
  assert("prev → current actions captured",
    d.actionChanges[0].prevAction === "Reduction-50%" && d.actionChanges[0].currentAction === "HOLD",
    d.actionChanges[0]);
}

// ──────────────────── Score change threshold ────────────────────

console.log("\nScore change threshold\n");
{
  // Large delta (5+) fires
  const prev = buildSnapshot([holding("X", "HOLD", 30)]);
  const cur  = buildSnapshot([holding("X", "HOLD", 38)]);
  const d = diffSnapshots(prev, cur);
  assert("delta=8 fires", d.scoreChanges.length === 1 && d.scoreChanges[0].delta === 8, d.scoreChanges);
}
{
  // Tiny delta (<5) ignored
  const prev = buildSnapshot([holding("X", "HOLD", 30)]);
  const cur  = buildSnapshot([holding("X", "HOLD", 33)]);
  const d = diffSnapshots(prev, cur);
  assert("delta=3 ignored (below threshold)", d.scoreChanges.length === 0, d.scoreChanges);
}
{
  // Negative delta still fires (abs ≥ 5)
  const prev = buildSnapshot([holding("X", "HOLD", 50)]);
  const cur  = buildSnapshot([holding("X", "HOLD", 40)]);
  const d = diffSnapshots(prev, cur);
  assert("delta=-10 fires", d.scoreChanges.length === 1 && d.scoreChanges[0].delta === -10, d.scoreChanges);
}

// ──────────────────── New + exited holdings ────────────────────

console.log("\nNew + exited holdings\n");
{
  const prev = buildSnapshot([holding("OLD", "HOLD", 50)]);
  const cur  = buildSnapshot([holding("NEW", "Top-up-50%", 65)]);
  const d = diffSnapshots(prev, cur);
  assert("NEW recorded as new holding",
    d.newHoldings.length === 1 && d.newHoldings[0].ticker === "NEW",
    d.newHoldings);
  assert("OLD recorded as exited",
    d.exitedHoldings.length === 1 && d.exitedHoldings[0].ticker === "OLD",
    d.exitedHoldings);
}

// ──────────────────── Surveillance changes ────────────────────

console.log("\nSurveillance changes\n");
{
  // Added
  const prev = buildSnapshot([holding("X", "HOLD", 50)]);
  const cur  = buildSnapshot([holding("X", "HOLD", 50, { list: "ASM", stage: 1 })]);
  const d = diffSnapshots(prev, cur);
  assert("ASM added → surveillanceChanges length 1",
    d.surveillanceChanges.length === 1, d.surveillanceChanges);
  assert("ASM added entry has prev=null current=ASM",
    d.surveillanceChanges[0].prev === null && d.surveillanceChanges[0].current?.list === "ASM",
    d.surveillanceChanges[0]);
}
{
  // Removed
  const prev = buildSnapshot([holding("X", "HOLD", 50, { list: "GSM", stage: 3 })]);
  const cur  = buildSnapshot([holding("X", "HOLD", 50)]);
  const d = diffSnapshots(prev, cur);
  assert("GSM removed → surveillanceChanges length 1",
    d.surveillanceChanges.length === 1, d.surveillanceChanges);
}
{
  // Stage change
  const prev = buildSnapshot([holding("X", "HOLD", 50, { list: "GSM", stage: 2 })]);
  const cur  = buildSnapshot([holding("X", "HOLD", 50, { list: "GSM", stage: 5 })]);
  const d = diffSnapshots(prev, cur);
  assert("GSM stage change recorded",
    d.surveillanceChanges.length === 1, d.surveillanceChanges);
}

// ──────────────────── No changes ────────────────────

console.log("\nNo material changes\n");
{
  const prev = buildSnapshot([holding("X", "HOLD", 50), holding("Y", "Top-up-25%", 55)]);
  const cur  = buildSnapshot([holding("X", "HOLD", 51), holding("Y", "Top-up-25%", 56)]);
  const d = diffSnapshots(prev, cur);
  assert("identical action + tiny score jitter → hasChanges:false",
    d.hasChanges === false, d);
  assert("summary says no material changes", /no material changes/i.test(d.summary), d.summary);
}

// ──────────────────── Sort stability ────────────────────

console.log("\nSort stability\n");
{
  // Multiple new holdings should be alphabetised so the banner is stable.
  const prev = buildSnapshot([holding("X", "HOLD", 50)]);
  const cur  = buildSnapshot([
    holding("X", "HOLD", 50),
    holding("ZNEW", "Top-up-25%", 50),
    holding("ANEW", "Top-up-25%", 50),
    holding("MNEW", "Top-up-25%", 50),
  ]);
  const d = diffSnapshots(prev, cur);
  assert("newHoldings alphabetically sorted",
    JSON.stringify(d.newHoldings.map((n) => n.ticker)) === '["ANEW","MNEW","ZNEW"]',
    d.newHoldings.map((n) => n.ticker));
}
{
  // scoreChanges sorted by abs delta descending
  const prev = buildSnapshot([
    holding("A", "HOLD", 30),
    holding("B", "HOLD", 30),
    holding("C", "HOLD", 30),
  ]);
  const cur  = buildSnapshot([
    holding("A", "HOLD", 35), // +5
    holding("B", "HOLD", 50), // +20
    holding("C", "HOLD", 22), // -8
  ]);
  const d = diffSnapshots(prev, cur);
  assert("scoreChanges sorted by abs delta desc (B first)",
    d.scoreChanges[0].ticker === "B" && d.scoreChanges[1].ticker === "C" && d.scoreChanges[2].ticker === "A",
    d.scoreChanges.map((s) => s.ticker));
}

// ──────────────────── Summary string ────────────────────

console.log("\nSummary string\n");
{
  const prev = buildSnapshot([holding("X", "Reduction-50%", 18)]);
  const cur  = buildSnapshot([
    holding("X", "HOLD", 35),
    holding("Y", "Top-up-25%", 55), // new
  ]);
  const d = diffSnapshots(prev, cur);
  assert("summary mentions new + action + score",
    /1 new/i.test(d.summary) && /1 action change/i.test(d.summary) && /score shift/i.test(d.summary),
    d.summary);
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
