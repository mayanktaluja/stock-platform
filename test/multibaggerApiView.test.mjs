// Tests for services/multibagger/multibaggerApiView.js.
// Run: node test/multibaggerApiView.test.mjs

import assert from "node:assert/strict";
import {
  buildMultibaggerCandidatesView,
  buildMultibaggerOverviewView,
  clampCandidateLimit,
  computeSnapshotStatus,
  DEFAULT_SURVIVORSHIP_WARNING,
  normalizeVerdictFilter,
  shapeMultibaggerCandidate,
} from "../services/multibagger/multibaggerApiView.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nmultibaggerApiView");

const NOW = "2026-06-16T12:00:00Z";

function candidate(overrides = {}) {
  return {
    ticker: "IDEAFORGE",
    sector: "Capital Goods",
    score_0_100: 72.84,
    verdict: "5X_CANDIDATE",
    gate_blocked: false,
    gate_reasons: [],
    breakdown: { inflection: 17 },
    diagnostics: {
      adv_inr_30d: 1_000_000,
      pledge: { pass: true, reasons: [] },
      tailwind: { cohort_exhausted: false },
      health_cap_applied: false,
    },
    ...overrides,
  };
}

function scores(overrides = {}) {
  const top_50 = [
    candidate(),
    candidate({ ticker: "MAHLOG", verdict: "HIGH_CONVICTION", score_0_100: 66.2 }),
    candidate({ ticker: "WATCHME", verdict: "WATCH", score_0_100: 44.1 }),
  ];
  return {
    schema_version: "multibagger-scores-v1",
    built_at: "2026-06-16T06:00:00Z",
    universe_size: 100,
    five_x_count: 1,
    high_conviction_count: 1,
    watch_count: 1,
    hard_reject_count: 0,
    top_50,
    macro_regime: "RISK_ON",
    ...overrides,
  };
}

function health(overrides = {}) {
  return {
    schema_version: "multibagger-health-v1",
    generated_at: "2026-06-16T06:00:00Z",
    metrics: { high_conviction_count: 2 },
    alerts: [],
    ...overrides,
  };
}

it("clamps candidate limits to 1..50 with default 30 for invalid input", () => {
  assert.equal(clampCandidateLimit(0), 1);
  assert.equal(clampCandidateLimit(-10), 1);
  assert.equal(clampCandidateLimit(51), 50);
  assert.equal(clampCandidateLimit(999), 50);
  assert.equal(clampCandidateLimit("2.9"), 2);
  assert.equal(clampCandidateLimit("nope"), 30);
});

it("normalizes verdict filters deterministically", () => {
  assert.deepEqual(normalizeVerdictFilter(" high-conviction "), {
    requested: " high-conviction ",
    normalized: "HIGH_CONVICTION",
    valid: true,
    applied: true,
  });
  assert.equal(normalizeVerdictFilter("all").applied, false);
  assert.deepEqual(normalizeVerdictFilter("bad verdict"), {
    requested: "bad verdict",
    normalized: "BAD_VERDICT",
    valid: false,
    applied: true,
  });
});

it("computes snapshot status missing, ok, stale, and degraded", () => {
  assert.equal(computeSnapshotStatus({ scores: null, health: health(), now_iso: NOW }).state, "missing");
  assert.deepEqual(
    computeSnapshotStatus({ scores: scores(), health: health(), now_iso: NOW }),
    { state: "ok", built_at: "2026-06-16T06:00:00Z", age_h: 6, stale_hours: 36, reason: null },
  );
  assert.equal(
    computeSnapshotStatus({ scores: scores({ built_at: "2026-06-14T00:00:00Z" }), health: health(), now_iso: NOW }).state,
    "stale",
  );
  assert.equal(
    computeSnapshotStatus({ scores: scores(), health: health({ alerts: ["Pipeline thin"] }), now_iso: NOW }).state,
    "degraded",
  );
});

it("builds candidates with validation defaults and model-implied labels", () => {
  const view = buildMultibaggerCandidatesView({
    scores: scores(),
    health: health(),
    limit: 2,
    now_iso: NOW,
  });
  assert.equal(view.validation_gate.gate_met, false);
  assert.equal(view.age_h, 6);
  assert.ok(view.validation_gate.blocking_reasons.some((r) => /forward_archive_0mo/.test(r)));
  assert.equal(view.survivorship_warning, DEFAULT_SURVIVORSHIP_WARNING);
  assert.equal(view.validation_label, "unvalidated");
  assert.equal(view.probability_label, "model-implied");
  assert.equal(view.candidates.length, 2);
  assert.equal(view.candidates[0].validation_label, "unvalidated");
  assert.equal(view.candidates[0].probability_label, "model-implied");
  assert.equal(view.candidates[0].model_label, "model-implied/unvalidated");
});

it("filters verdicts after normalization and invalid filters return no rows", () => {
  const high = buildMultibaggerCandidatesView({
    scores: scores(),
    health: health(),
    verdict: " high-conviction ",
    limit: 10,
    now_iso: NOW,
  });
  assert.equal(high.verdict_filter.normalized, "HIGH_CONVICTION");
  assert.deepEqual(high.candidates.map((c) => c.ticker), ["MAHLOG"]);

  const invalid = buildMultibaggerCandidatesView({
    scores: scores(),
    health: health(),
    verdict: "unknown",
    limit: 10,
    now_iso: NOW,
  });
  assert.equal(invalid.verdict_filter.valid, false);
  assert.deepEqual(invalid.candidates, []);
});

it("shapes candidates consistently and rounds score to one decimal", () => {
  const shaped = shapeMultibaggerCandidate(candidate({ score_0_100: 72.84 }));
  assert.deepEqual(Object.keys(shaped), [
    "ticker",
    "sector",
    "score_0_100",
    "rank_score_0_100",
    "verdict",
    "verdict_label",
    "gate_blocked",
    "gate_reasons",
    "breakdown",
    "diagnostics",
    "validation_label",
    "probability_label",
	    "evidence_status",
	    "model_label",
	    "decision_contract",
	    "tradability_state",
    "entry_status",
    "tradability_reasons",
    "entry_quality",
  ]);
	  assert.equal(shaped.score_0_100, 72.8);
	  assert.equal(shaped.verdict_label, "5X CANDIDATE");
	  assert.equal(shaped.decision_contract.state, "RESEARCH_ONLY");
});

it("derives tradability and entry state from diagnostics only", () => {
  assert.deepEqual(
    {
      tradability_state: shapeMultibaggerCandidate(candidate()).tradability_state,
      entry_status: shapeMultibaggerCandidate(candidate()).entry_status,
    },
    { tradability_state: "TRADABLE_NOW", entry_status: "entry_candidate" },
  );

  const unknownLiquidity = shapeMultibaggerCandidate(candidate({ diagnostics: { adv_inr_30d: null } }));
  assert.equal(unknownLiquidity.tradability_state, "WAIT_FOR_VOLUME");
  assert.equal(unknownLiquidity.entry_status, "needs_liquidity_check");

  const blocked = shapeMultibaggerCandidate(candidate({
    gate_blocked: true,
    gate_reasons: ["liquidity_adv_unknown"],
  }));
  assert.equal(blocked.tradability_state, "AVOID_ENTRY");
  assert.equal(blocked.entry_status, "do_not_enter");

  const exhausted = shapeMultibaggerCandidate(candidate({
    diagnostics: {
      adv_inr_30d: 1_000_000,
      pledge: { pass: true, reasons: [] },
      tailwind: { cohort_exhausted: true },
    },
  }));
  assert.equal(exhausted.tradability_state, "WAIT_FOR_VOLUME");
  assert.equal(exhausted.entry_status, "wait_for_pullback");
});

it("overview reuses candidate shaping and exposes portfolio summary", () => {
  const view = buildMultibaggerOverviewView({
    scores: scores(),
    health: health(),
    slate: { slate: [{ ticker: "ABC" }] },
    portfolio: {
      starting_capital_inr: 100_000,
      cash_inr: 75_000,
      positions: [{ ticker: "IDEAFORGE" }],
      closed_positions: [],
      snapshot_at: NOW,
    },
    now_iso: NOW,
  });
  assert.equal(view.schema_version, "multibagger-overview-v1");
  assert.equal(view.snapshot_status.state, "ok");
  assert.equal(view.age_h, 6);
  assert.equal(view.top_candidates[0].tradability_state, "TRADABLE_NOW");
  assert.equal(view.catalyst_slate.length, 1);
  assert.deepEqual(view.portfolio_summary, {
    starting_capital_inr: 100_000,
    cash_inr: 75_000,
    open_positions: 1,
    closed_positions: 0,
    snapshot_at: NOW,
  });
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
