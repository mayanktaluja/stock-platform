/**
 * Run with: node test/portfolioEarningsSection.test.mjs
 *
 * Covers the selector that feeds the "upcoming results in your portfolio"
 * email section. The fixtures below are modelled on real rows from
 * data/catalysts/earnings-watch-latest.json — specifically the two that break
 * a naive implementation:
 *
 *   INDBANK  (days_until: 0)            → escapeHtml(0) === "", renders blank
 *   GANGOTRI (INSUFFICIENT_DATA)        → playbook.position_size_tier undefined
 *
 * Both are asserted explicitly. Do not delete them.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_MAX_DAYS,
  DEFAULT_MAX_STALENESS_MS,
  buildPortfolioEarningsRows,
  formatBranchTree,
  formatConfidence,
  formatDaysUntil,
  isPreviewPlaybook,
} from "../services/earnings/portfolioEarningsSection.js";

const NOW = Date.parse("2026-07-08T04:00:00.000Z");
const FRESH_BUILT_AT = "2026-07-08T01:55:24.496Z";

/** Verbatim shape of reactionPlaybook.js buildPreviewPlaybook() for a BEAT. */
function previewPlaybook(verdict = "BEAT") {
  return {
    mode: "preview",
    tradable: true,
    predicted_verdict: verdict,
    highlight_branch: "RAISE",
    primary: { key: `${verdict}_MAINTAIN`, label: `${verdict} + Maintain (often a fade)` },
    branches: [
      { guidance: "RAISE", plan: { key: `${verdict}_RAISE`, label: "Beat + Raise (strongest)" }, is_highlighted: true },
      { guidance: "MAINTAIN", plan: { key: `${verdict}_MAINTAIN`, label: "Beat + Maintain (often a fade)" }, is_highlighted: false },
      { guidance: "CUT", plan: { key: `${verdict}_CUT`, label: "Beat + Cut (the trap)" }, is_highlighted: false },
    ],
    position_size_multiplier: 0.6,
    position_size_tier: { label: "Reduced size", min_confidence: 48 },
  };
}

/** Verbatim shape of reactionPlaybook.js:249-258 — note: NO position_size_tier. */
function insufficientDataPlaybook() {
  return {
    mode: "preview",
    tradable: false,
    primary: null,
    branches: [],
    headline: "Insufficient data — no playbook.",
    version: "earnings-playbook-v1-2026-05",
  };
}

/** Post-result shape from buildT1Playbook — `plan`/`cell_key`, no `branches`. */
function t1Playbook() {
  return {
    mode: "t1",
    tradable: true,
    cell_key: "BEAT_RAISE",
    plan: { key: "BEAT_RAISE", label: "Beat + Raise (strongest)" },
  };
}

function event(symbol, daysUntil, overrides = {}) {
  return {
    symbol,
    company: `${symbol} Limited`,
    event_iso_date: "2026-07-09",
    days_until: daysUntil,
    fiscal_quarter: "Q1 FY27",
    prediction: { verdict: "BEAT", confidence_pct: 63 },
    playbook: previewPlaybook("BEAT"),
    ...overrides,
  };
}

function snapshot(events, builtAt = FRESH_BUILT_AT) {
  return { schema_version: "earnings-watch-v4", built_at: builtAt, events };
}

const opts = { nowMs: NOW };

// ──── formatDaysUntil: the escapeHtml(0) trap ────
assert.equal(formatDaysUntil(0), "Today", "days_until 0 must not stringify to a falsy value");
assert.equal(formatDaysUntil(1), "Tomorrow");
assert.equal(formatDaysUntil(3), "in 3 days");
assert.equal(formatDaysUntil(7), "in 7 days");
assert.equal(formatDaysUntil(NaN), "—");
assert.equal(formatDaysUntil(undefined), "—");
assert.ok(formatDaysUntil(0).length > 0, "the d=0 label must be a non-empty string");

// ──── formatConfidence ────
assert.equal(formatConfidence(63), "63%");
assert.equal(formatConfidence(null), "—", "INSUFFICIENT_DATA confidence must not render null%");
assert.equal(formatConfidence(undefined), "—");

// ──── isPreviewPlaybook / formatBranchTree guards ────
assert.equal(isPreviewPlaybook(previewPlaybook()), true);
assert.equal(isPreviewPlaybook(insufficientDataPlaybook()), false, "tradable:false is not a preview tree");
assert.equal(isPreviewPlaybook(t1Playbook()), false, "t1 has no branches");
assert.equal(isPreviewPlaybook(null), false);
assert.equal(isPreviewPlaybook(undefined), false);

assert.equal(
  formatBranchTree(previewPlaybook("BEAT")),
  "RAISE → Beat + Raise (strongest) · MAINTAIN → Beat + Maintain (often a fade) · CUT → Beat + Cut (the trap)",
);
// The regression that would have thrown: .position_size_tier.label on a 6-key object.
assert.doesNotThrow(() => formatBranchTree(insufficientDataPlaybook()));
assert.equal(formatBranchTree(insufficientDataPlaybook()), "");
assert.doesNotThrow(() => formatBranchTree(t1Playbook()));
assert.equal(formatBranchTree(t1Playbook()), "", "archived t1 playbook yields no tree");
assert.equal(formatBranchTree(null), "");
assert.equal(formatBranchTree(undefined), "");

// A partial tree reads as a guidance call by omission — suppress it entirely.
const missingCut = previewPlaybook();
missingCut.branches = missingCut.branches.filter((b) => b.guidance !== "CUT");
assert.equal(formatBranchTree(missingCut), "", "2-of-3 branches must render nothing");

// Branch labels carry no trade instruction (email footer asserts this).
assert.doesNotMatch(formatBranchTree(previewPlaybook()), /\b(buy|sell)\b/i);

// ──── window bounds ────
{
  const snap = snapshot([
    event("AAA", 0),
    event("BBB", 7),
    event("CCC", 8),
    event("DDD", -1),
  ]);
  const { rows, suppressed_reason } = buildPortfolioEarningsRows(
    snap,
    ["AAA", "BBB", "CCC", "DDD"],
    opts,
  );
  assert.equal(suppressed_reason, null);
  assert.deepEqual(rows.map((r) => r.symbol), ["AAA", "BBB"], "window is [0, 7] inclusive");
  assert.equal(DEFAULT_MAX_DAYS, 7);
}

// ──── symbol join: earnings is bare, holdings are .NS-suffixed ────
{
  const snap = snapshot([
    event("TCS", 1),
    event("UMIYA-MRO", 2), // hyphens are legal NSE symbols; must survive
    event("RELIANCE", 3),
  ]);
  const { rows } = buildPortfolioEarningsRows(
    snap,
    ["TCS.NS", "umiya-mro.BO", "  reliance  "],
    opts,
  );
  assert.deepEqual(rows.map((r) => r.symbol), ["TCS", "UMIYA-MRO", "RELIANCE"]);
}
{
  // A holding not in the calendar, and a calendar event not held.
  const { rows } = buildPortfolioEarningsRows(snapshot([event("TCS", 1)]), ["INFY.NS"], opts);
  assert.deepEqual(rows, []);
}

// ──── INSUFFICIENT_DATA row: the GANGOTRI case ────
{
  const snap = snapshot([
    event("GANGOTRI", 4, {
      prediction: { verdict: "INSUFFICIENT_DATA", confidence_pct: null, score_100: null },
      playbook: insufficientDataPlaybook(),
    }),
  ]);
  let rows;
  assert.doesNotThrow(() => {
    ({ rows } = buildPortfolioEarningsRows(snap, ["GANGOTRI"], opts));
  }, "an INSUFFICIENT_DATA row must never throw");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "INSUFFICIENT_DATA");
  assert.equal(rows[0].verdict_label, "Insufficient data");
  assert.equal(rows[0].confidence_label, "—");
  assert.equal(rows[0].branch_tree, "");
}

// ──── days_until: 0 row survives end to end: the INDBANK case ────
{
  const { rows } = buildPortfolioEarningsRows(snapshot([event("INDBANK", 0)]), ["INDBANK"], opts);
  assert.equal(rows[0].days_until, 0);
  assert.equal(rows[0].days_until_label, "Today");
  assert.notEqual(rows[0].days_until_label, "", "the reports-today row must never be blank");
}

// ──── non-numeric days_until never reaches the sort comparator ────
{
  const snap = snapshot([
    { ...event("AAA", 2), days_until: undefined },
    { ...event("BBB", 2), days_until: null },
    event("CCC", 2),
  ]);
  const { rows } = buildPortfolioEarningsRows(snap, ["AAA", "BBB", "CCC"], opts);
  assert.deepEqual(rows.map((r) => r.symbol), ["CCC"]);
}

// ──── sort: days_until asc, then symbol asc ────
{
  const snap = snapshot([event("ZZZ", 3), event("AAA", 3), event("MMM", 1)]);
  const { rows } = buildPortfolioEarningsRows(snap, ["ZZZ", "AAA", "MMM"], opts);
  assert.deepEqual(rows.map((r) => r.symbol), ["MMM", "AAA", "ZZZ"]);
}

// ──── staleness gate fails CLOSED ────
{
  const stale = snapshot([event("TCS", 1)], "2026-07-01T00:00:00.000Z"); // 7d old
  const out = buildPortfolioEarningsRows(stale, ["TCS"], opts);
  assert.deepEqual(out, { rows: [], suppressed_reason: "stale" });
}
{
  // Date.parse(null) is NaN, and `NaN > maxStalenessMs` is false. A naive
  // comparison would wave this through as fresh.
  const corrupt = snapshot([event("TCS", 1)], null);
  assert.equal(buildPortfolioEarningsRows(corrupt, ["TCS"], opts).suppressed_reason, "stale");
  const garbage = snapshot([event("TCS", 1)], "not-a-date");
  assert.equal(buildPortfolioEarningsRows(garbage, ["TCS"], opts).suppressed_reason, "stale");
}
{
  // Exactly at the bound is still fresh; one ms past is not.
  const atBound = snapshot([event("TCS", 1)], new Date(NOW - DEFAULT_MAX_STALENESS_MS).toISOString());
  assert.equal(buildPortfolioEarningsRows(atBound, ["TCS"], opts).rows.length, 1);
  const pastBound = snapshot([event("TCS", 1)], new Date(NOW - DEFAULT_MAX_STALENESS_MS - 1).toISOString());
  assert.equal(buildPortfolioEarningsRows(pastBound, ["TCS"], opts).suppressed_reason, "stale");
}

// ──── missing snapshot ────
for (const bad of [null, undefined, {}, { _missing: true, events: [], built_at: null }]) {
  assert.equal(
    buildPortfolioEarningsRows(bad, ["TCS"], opts).suppressed_reason,
    "missing",
    `missing snapshot: ${JSON.stringify(bad)}`,
  );
}

// ──── empty / absent holdings is NOT a suppression ────
for (const held of [[], null, undefined, [""], [null]]) {
  const out = buildPortfolioEarningsRows(snapshot([event("TCS", 1)]), held, opts);
  assert.deepEqual(out, { rows: [], suppressed_reason: null });
}

// ──── rows carry scalars only: no retained references, no trade fields ────
{
  const snap = snapshot([event("TCS", 1)]);
  const { rows } = buildPortfolioEarningsRows(snap, ["TCS"], opts);
  const row = rows[0];
  for (const banned of ["playbook", "price_band", "signals", "band", "position_size_multiplier", "position_size_tier", "entry", "stoploss", "target"]) {
    assert.equal(banned in row, false, `row must not carry '${banned}' — email ships no trade instruction`);
  }
  assert.deepEqual(Object.values(row).filter((v) => v !== null && typeof v === "object"), [], "row values are scalars only");
  // Mutating the row cannot corrupt predictionFreeze's module-scope cache.
  row.symbol = "MUTATED";
  assert.equal(snap.events[0].symbol, "TCS");
}

// ──── full row shape ────
{
  const { rows } = buildPortfolioEarningsRows(snapshot([event("TCS", 1)]), ["TCS.NS"], opts);
  assert.deepEqual(rows[0], {
    symbol: "TCS",
    company: "TCS Limited",
    event_iso_date: "2026-07-09",
    days_until: 1,
    days_until_label: "Tomorrow",
    fiscal_quarter: "Q1 FY27",
    verdict: "BEAT",
    verdict_label: "BEAT",
    confidence_pct: 63,
    confidence_label: "63%",
    branch_tree: "RAISE → Beat + Raise (strongest) · MAINTAIN → Beat + Maintain (often a fade) · CUT → Beat + Cut (the trap)",
  });
}

// ──── degenerate fields fall back rather than emit "undefined" ────
{
  const snap = snapshot([
    { symbol: "xyz.ns", days_until: 2, prediction: {}, playbook: null },
  ]);
  const { rows } = buildPortfolioEarningsRows(snap, ["XYZ"], opts);
  assert.equal(rows[0].symbol, "XYZ");
  assert.equal(rows[0].company, "XYZ", "company falls back to the symbol");
  assert.equal(rows[0].fiscal_quarter, "—");
  assert.equal(rows[0].event_iso_date, "");
  assert.equal(rows[0].verdict, "INSUFFICIENT_DATA");
  assert.equal(rows[0].branch_tree, "");
}

console.log("portfolioEarningsSection tests passed");
