/**
 * Tests for the governance hard-gate path:
 *
 *   • deriveGovernanceGate() — pure helper that converts an NSE shareholding
 *     snapshot into a REVIEW verdict (or null) based on promoter-pledge
 *     thresholds. The thresholds match the patterns that preceded the
 *     Vedanta-2021 / Zee-2022 / YesBank-2020 forced-sale cascades on Indian
 *     equities (pledge ≥ 25% absolute, or +5pp QoQ delta).
 *
 *   • computeAction() priority-0 short-circuit — when context.governanceGate
 *     fires, the action engine returns REVIEW_GOVERNANCE before any P&L
 *     logic runs. Without this, a pledge-laden stock at break-even lands in
 *     HOLD because the technical scoreboard masks promoter-balance-sheet
 *     leverage.
 *
 * Run with: node test/governanceGate.test.mjs
 */

import { deriveGovernanceGate } from "../services/swsIndianRiskLayer.js";
import { computeAction } from "../portfolioIntelligence.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

// ── date-relative quarter fixtures ────────────────────────────────
//
// The staleness check compares asOfQuarter's quarter-end against
// Date.now(), so a fixture pinned to a literal label silently flips from
// fresh to stale the day GATE_STALENESS_DAYS elapses past that
// quarter-end. That is not hypothetical: these tests hardcoded "Q4FY26"
// (ends Mar 31 2026) and went red on 2026-07-30 — day 121 of a 120-day
// window — with no code change, blocking every open auto-refresh PR.
//
// So derive the labels from today instead. FRESH_QUARTER is the newest
// quarter-end the gate must still trust; STALE_QUARTER is the newest one
// it must reject. Keep this mirroring services/swsIndianRiskLayer.js —
// if GATE_STALENESS_DAYS moves there, move it here too.
const GATE_STALENESS_DAYS = 120;

// Indian FY runs Apr–Mar. Quarter-ends land in Jun/Sep/Dec/Mar; the Mar
// one closes the FY it is stamped with, the other three belong to the FY
// closing the following March.
const QUARTER_END_MONTHS = [
  { month: 2,  q: 4, fyOffset: 0 },  // Mar → Q4FY<same year>
  { month: 5,  q: 1, fyOffset: 1 },  // Jun → Q1FY<next year>
  { month: 8,  q: 2, fyOffset: 1 },  // Sep → Q2FY<next year>
  { month: 11, q: 3, fyOffset: 1 },  // Dec → Q3FY<next year>
];

// Every quarter-end within a few years of today, nearest-first, each
// carrying the label the module's parser expects and its age in days.
// Future quarter-ends come back with a negative age and are filtered out
// by the callers below.
function quarterEndsNearestFirst(yearsBack = 3) {
  const now = Date.now();
  const thisYear = new Date().getFullYear();
  const rows = [];
  for (let y = thisYear + 1; y >= thisYear - yearsBack; y--) {
    for (const { month, q, fyOffset } of QUARTER_END_MONTHS) {
      const end = new Date(y, month + 1, 0);  // day 0 of next month = last day of this one
      rows.push({
        label: `Q${q}FY${String((y + fyOffset) % 100).padStart(2, "0")}`,
        ageDays: Math.floor((now - end.getTime()) / 86400000),
      });
    }
  }
  return rows.sort((a, b) => a.ageDays - b.ageDays);
}

function pickQuarter(what, predicate) {
  const hit = quarterEndsNearestFirst().find(predicate);
  if (!hit) throw new Error(`could not derive a ${what} quarter fixture for today`);
  return hit;
}

const FRESH = pickQuarter("fresh", (r) => r.ageDays >= 0 && r.ageDays <= GATE_STALENESS_DAYS);
const STALE = pickQuarter("stale", (r) => r.ageDays > GATE_STALENESS_DAYS);

// ── deriveGovernanceGate ──────────────────────────────────────────

console.log("\n[deriveGovernanceGate]");

// 0. The fixtures themselves must straddle the cutoff. If this trips, the
//    derivation above is wrong and every staleness assertion below is
//    meaningless — so check it first rather than debugging downstream nulls.
assert(`fresh fixture ${FRESH.label} is inside the ${GATE_STALENESS_DAYS}d window (${FRESH.ageDays}d)`,
  FRESH.ageDays >= 0 && FRESH.ageDays <= GATE_STALENESS_DAYS, FRESH);
assert(`stale fixture ${STALE.label} is outside it (${STALE.ageDays}d)`,
  STALE.ageDays > GATE_STALENESS_DAYS, STALE);

// 1. Null / empty snapshots short-circuit to null
assert("null snapshot → null", deriveGovernanceGate(null) === null);
assert("undefined snapshot → null", deriveGovernanceGate(undefined) === null);
assert("empty object → null", deriveGovernanceGate({}) === null);

// 2. Below-threshold pledge → null
{
  const r = deriveGovernanceGate({ promoterPledge: 0.10, asOfQuarter: FRESH.label });
  assert("pledge 10% → null (below 25% gate)", r === null, r);
}

// 3. Pledge exactly at 25% → REVIEW (≥ threshold)
{
  const r = deriveGovernanceGate({ promoterPledge: 0.25, asOfQuarter: FRESH.label });
  assert("pledge 25% → REVIEW", r?.severity === "REVIEW", r);
  assert("reason mentions pledge %", /25\.0%/.test(r?.reason || ""), r?.reason);
}

// 4. Heavy pledge → REVIEW with Vedanta/Zee/YesBank pattern label
{
  const r = deriveGovernanceGate({ promoterPledge: 0.60, asOfQuarter: FRESH.label });
  assert("pledge 60% → REVIEW", r?.severity === "REVIEW", r);
  assert("pattern names historical cases", /Vedanta|Zee|YesBank/.test(r?.pattern || ""), r?.pattern);
  assert("pledge captured", r?.pledge === 0.60, r);
}

// 5. Pledge below absolute threshold but QoQ delta above → REVIEW
{
  const r = deriveGovernanceGate({
    promoterPledge: 0.10,
    promoterPledgeDeltaQoQ: 0.08,  // +8pp QoQ spike
    asOfQuarter: FRESH.label,
  });
  assert("pledge spike +8pp → REVIEW", r?.severity === "REVIEW", r);
  assert("delta reason text", /\+8\.0pp/.test(r?.reason || ""), r?.reason);
}

// 6. Pledge QoQ delta exactly at 5pp → null (must be > 5, not ≥ 5)
{
  const r = deriveGovernanceGate({
    promoterPledge: 0.05,
    promoterPledgeDeltaQoQ: 0.05,
    asOfQuarter: FRESH.label,
  });
  assert("delta 5pp → null (boundary; must exceed)", r === null, r);
}

// 7. Stale data → null (don't fire forced-review banners off ancient
//    SEBI Reg 31 filings). STALE is the *newest* out-of-window quarter, so
//    this pins the tight side of the boundary, not a trivially old one.
{
  const r = deriveGovernanceGate({ promoterPledge: 0.60, asOfQuarter: STALE.label });
  assert(`${STALE.label} (stale) → null`, r === null, r);
}

// 8. Newest in-window quarter → still fires
{
  const r = deriveGovernanceGate({ promoterPledge: 0.60, asOfQuarter: FRESH.label });
  assert(`${FRESH.label} (recent) → REVIEW`, r?.severity === "REVIEW", r);
}

// 9. Malformed asOfQuarter → fires anyway (no skip — we don't penalise missing
//    metadata; the file-level refresh keeps the snapshot fresh on average).
{
  const r = deriveGovernanceGate({ promoterPledge: 0.60, asOfQuarter: "garbage" });
  assert("garbage asOfQuarter → still REVIEW", r?.severity === "REVIEW", r);
}

// 10. Missing asOfQuarter → fires anyway
{
  const r = deriveGovernanceGate({ promoterPledge: 0.60 });
  assert("missing asOfQuarter → still REVIEW", r?.severity === "REVIEW", r);
}

// ── computeAction priority-0 gate ─────────────────────────────────

console.log("\n[computeAction priority-0]");

function holdingOf(opts = {}) {
  return {
    symbol: opts.symbol || "TEST",
    name: "Test Co",
    pnlPercent: opts.pnlPercent ?? 0,
    investedValue: 100000,
    currentValue: 100000 * (1 + (opts.pnlPercent ?? 0) / 100),
    sector: "Energy",
  };
}
function ctxOf(opts = {}) {
  return {
    positionWeight: opts.positionWeight ?? 5,
    hasLiveData: true,
    macroInfo: null,
    governanceGate: opts.governanceGate ?? null,
  };
}
function scoresOf(opts = {}) {
  return {
    combinedScore: opts.combinedScore ?? 60,
    technicalScore: 60,
    fundamentalScore: 60,
    fundamentalVerdict: opts.fundamentalVerdict ?? "FAIR_VALUE",
  };
}

// 11. No gate → falls through to normal logic (HOLD here)
{
  const r = computeAction(holdingOf(), scoresOf(), ctxOf());
  assert("no gate, normal holding → HOLD", r.action === "HOLD", r);
}

// 12. Gate fires → REVIEW_GOVERNANCE regardless of P&L / score
{
  const gate = deriveGovernanceGate({ promoterPledge: 0.60, asOfQuarter: FRESH.label });
  const r = computeAction(holdingOf({ pnlPercent: 20 }), scoresOf({ combinedScore: 85 }), ctxOf({ governanceGate: gate }));
  assert("gate fires on positive P&L + high score → REVIEW_GOVERNANCE", r.action === "REVIEW_GOVERNANCE", r);
  assert("displayAction mentions governance", /governance/i.test(r.displayAction || ""), r);
  assert("reasoning carries cascade pattern", /Vedanta|Zee|YesBank/.test(r.reasoning || ""), r.reasoning);
}

// 13. Gate fires + deep drawdown — gate wins over CUT_LOSS (priority-0)
{
  const gate = deriveGovernanceGate({ promoterPledge: 0.30, asOfQuarter: FRESH.label });
  const r = computeAction(holdingOf({ pnlPercent: -45 }), scoresOf({ combinedScore: 25 }), ctxOf({ governanceGate: gate }));
  assert("gate beats deep drawdown → REVIEW_GOVERNANCE (not CUT_LOSS)", r.action === "REVIEW_GOVERNANCE", r);
}

// 14. NO_DATA still wins over gate (gate needs the holding to have prices)
{
  const gate = deriveGovernanceGate({ promoterPledge: 0.60, asOfQuarter: FRESH.label });
  const r = computeAction(holdingOf(), scoresOf(), {
    positionWeight: 5,
    hasLiveData: false,
    governanceGate: gate,
  });
  assert("no live data → NO_DATA (before gate)", r.action === "NO_DATA", r);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
