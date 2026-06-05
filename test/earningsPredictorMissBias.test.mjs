/**
 * Tests for the v2.1 missing-data caution penalty in earningsPredictor.js.
 *
 * The pre-v2.1 predictor never emitted MISS across 47 resolved history
 * rows because ~80% of NSE tickers land near score=50 (all four
 * "missing data" component branches silently returned 0 pts). v2.1
 * adds a small capped penalty so an uncertain-data stock leans toward
 * MISS rather than INLINE.
 *
 * Hard constraints validated here:
 *   - HIGH quality: -2 per missing input, capped at -6 total.
 *   - MEDIUM quality: total capped at -3 (single small lean).
 *   - LLM null (no classifier_provider) counts as missing; LLM
 *     bias=neutral with a stamped provider does NOT.
 *   - score_breakdown surfaces both pts and the list of missing
 *     components for audit.
 *   - PREDICTOR_VERSION rolled to v2.1.
 *
 * Run with: node test/earningsPredictorMissBias.test.mjs
 */

import {
  predictEarningsOutcome,
  PREDICTOR_VERSION,
} from "../services/earnings/earningsPredictor.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

function makeV3(overrides = {}) {
  return {
    v3_score_100: 50,
    v3_verdict: "ACCEPTABLE",
    source: "computed",
    breakdown: {
      pts_health: 11,
      pts_future: 10,
      pts_valuation: 6,
      pts_past: 6,
      pts_dividends: 4,
      pts_fv_upside: 6,
      fv_imputed: false,
      pts_mom_1y: 4,
      pts_mom_3m: 2,
      pts_mom_1m: 1,
      momentum_imputed: false,
      pts_overlay: 0,
      overlay_reasons: [],
      surveillance: null,
      ...overrides,
    },
  };
}

// "Full-signal" skeleton — all four qualitative inputs present so the
// missing-data penalty starts at 0. Tests override individual fields
// to drop them.
function makeFullSignals(overrides = {}) {
  return {
    data_quality: "HIGH",
    sector: "Technology",
    market_cap_inr: 1e12,
    snowflake_total: 18,
    v3: makeV3(),
    momentum: {
      ret_1m_pct: 2,
      ret_3m_pct: 4,
      sector_avg_1m_pct: 3,
      pre_runup_signal: "neutral",
      runup_vs_sector_pct: -1,
    },
    trajectory: { eps_yoy_pct: 5 },
    data_quality_flags: { trajectory: "covered" },
    upside_pct: 0,
    sws_upcoming_earnings: null,
    announcements: { top3: [{ classification: "ORDER_WIN", materiality_score: 4 }] },
    deals_7d: null,
    llm_signal: { bias: "neutral", confidence_delta_pct: 0, classifier_provider: "heuristic" },
    ...overrides,
  };
}

// ──── Baseline: all signals present → penalty = 0 ────
{
  const r = predictEarningsOutcome({ signals: makeFullSignals() });
  assert(
    "all qualitative signals present → missing_data_penalty = 0",
    r.score_breakdown.missing_data_penalty === 0,
    r.score_breakdown,
  );
  assert(
    "missing_data_components empty when nothing missing",
    Array.isArray(r.score_breakdown.missing_data_components) &&
      r.score_breakdown.missing_data_components.length === 0,
    r.score_breakdown.missing_data_components,
  );
}

// ──── Single missing input on HIGH quality → -2 ────
{
  const r = predictEarningsOutcome({
    signals: makeFullSignals({ announcements: { top3: [] } }),
  });
  assert(
    "HIGH quality + 1 missing → -2 pts",
    r.score_breakdown.missing_data_penalty === -2,
    r.score_breakdown,
  );
  assert(
    "missing list names the missing component",
    r.score_breakdown.missing_data_components.includes("announcements"),
    r.score_breakdown.missing_data_components,
  );
}

// ──── HIGH stack of 4 missing → capped at -6 (not -8) ────
{
  const sig = makeFullSignals({
    announcements: { top3: [] },
    data_quality_flags: { trajectory: "absent" },
    trajectory: { eps_yoy_pct: null },
    llm_signal: null,
  });
  sig.v3 = null;
  const r = predictEarningsOutcome({ signals: sig });
  assert(
    "HIGH quality + 4 missing → capped at -6 (NOT -8)",
    r.score_breakdown.missing_data_penalty === -6,
    r.score_breakdown,
  );
  assert(
    "all 4 missing components listed",
    ["v4", "trajectory", "announcements", "llm"].every((k) =>
      r.score_breakdown.missing_data_components.includes(k),
    ),
    r.score_breakdown.missing_data_components,
  );
}

// ──── MEDIUM quality stack → cap at -3 (defends sparse-coverage tickers) ────
{
  const sig = makeFullSignals({
    data_quality: "MEDIUM",
    announcements: { top3: [] },
    llm_signal: null,
  });
  sig.v3 = null;
  const r = predictEarningsOutcome({ signals: sig });
  assert(
    "MEDIUM quality + 3 missing → capped at -3 (NOT -6)",
    r.score_breakdown.missing_data_penalty === -3,
    r.score_breakdown,
  );
}

// ──── LLM null vs LLM neutral — only null counts as missing ────
{
  // LLM null (signal failed to produce) → counted as missing
  const nullLlm = predictEarningsOutcome({
    signals: makeFullSignals({ llm_signal: null }),
  });
  assert(
    "LLM null → counted as missing",
    nullLlm.score_breakdown.missing_data_components.includes("llm"),
    nullLlm.score_breakdown.missing_data_components,
  );

  // LLM neutral WITH classifier_provider → NOT missing (we read it,
  // it was just neutral)
  const neutralLlm = predictEarningsOutcome({
    signals: makeFullSignals({
      llm_signal: { bias: "neutral", confidence_delta_pct: 0, classifier_provider: "heuristic" },
    }),
  });
  assert(
    "LLM neutral with stamped provider → NOT missing",
    !neutralLlm.score_breakdown.missing_data_components.includes("llm"),
    neutralLlm.score_breakdown.missing_data_components,
  );

  // LLM signal present but no classifier_provider → still counted as
  // missing (defensive: signal is fragmentary).
  const noProvider = predictEarningsOutcome({
    signals: makeFullSignals({
      llm_signal: { bias: "neutral", confidence_delta_pct: 0 },
    }),
  });
  assert(
    "LLM signal without classifier_provider → counted as missing",
    noProvider.score_breakdown.missing_data_components.includes("llm"),
    noProvider.score_breakdown.missing_data_components,
  );
}

// ──── Trajectory: only data_quality_flags.trajectory === "absent" counts ────
{
  // eps_yoy null without explicit "absent" flag → NOT missing
  // (back-compat — pre-flag tickers don't get penalised retroactively).
  const noFlag = predictEarningsOutcome({
    signals: makeFullSignals({ trajectory: { eps_yoy_pct: null }, data_quality_flags: { trajectory: "covered" } }),
  });
  assert(
    "trajectory null + 'covered' flag → NOT missing",
    !noFlag.score_breakdown.missing_data_components.includes("trajectory"),
    noFlag.score_breakdown.missing_data_components,
  );

  // Explicit absent flag → counted
  const absent = predictEarningsOutcome({
    signals: makeFullSignals({
      trajectory: { eps_yoy_pct: null },
      data_quality_flags: { trajectory: "absent" },
    }),
  });
  assert(
    "trajectory absent flag → counted as missing",
    absent.score_breakdown.missing_data_components.includes("trajectory"),
    absent.score_breakdown.missing_data_components,
  );
}

// ──── MISS-pulling integration: uncertain HIGH stock now scores <50 ────
// The point of the penalty is that an uncertain stock (no V3, no
// trajectory, no news, no LLM read) drops below 50 instead of sitting
// on the BEAT side of the line. With balanced other signals the new
// score should land in INLINE-leaning-MISS rather than dead-centre.
{
  const sig = makeFullSignals({
    data_quality: "HIGH",
    announcements: { top3: [] },
    data_quality_flags: { trajectory: "absent" },
    trajectory: { eps_yoy_pct: null },
    llm_signal: null,
    momentum: { ret_1m_pct: 0, sector_avg_1m_pct: 0, pre_runup_signal: "neutral", runup_vs_sector_pct: 0 },
  });
  sig.v3 = null;
  const r = predictEarningsOutcome({ signals: sig });
  assert(
    "uncertain HIGH stock now scores <50 (was ≈50 pre-v2.1)",
    r.score_100 < 50,
    { score: r.score_100, breakdown: r.score_breakdown },
  );
}

// ──── Version stamp updated (rolled to v3 in PR2 thresholds commit) ────
{
  assert(
    "PREDICTOR_VERSION rolled to v3 (covers v2.1 penalty + v3 thresholds)",
    PREDICTOR_VERSION.includes("v3"),
    PREDICTOR_VERSION,
  );
}

// ──── v3 threshold provenance is stamped onto every prediction ────
{
  const r = predictEarningsOutcome({ signals: makeFullSignals() });
  assert(
    "score_breakdown carries threshold_source",
    typeof r.score_breakdown.threshold_source === "string",
    r.score_breakdown.threshold_source,
  );
  assert(
    "score_breakdown carries miss_cut and beat_cut",
    typeof r.score_breakdown.miss_cut === "number" &&
      typeof r.score_breakdown.beat_cut === "number",
    { miss: r.score_breakdown.miss_cut, beat: r.score_breakdown.beat_cut },
  );
  assert(
    "default thresholds are empirical (34/56), not static (35/65)",
    r.score_breakdown.miss_cut === 34 && r.score_breakdown.beat_cut === 56,
    { miss: r.score_breakdown.miss_cut, beat: r.score_breakdown.beat_cut },
  );
}

// ──── Static-fallback env var path ────
{
  process.env.EARNINGS_PREDICTOR_STATIC_THRESHOLDS = "1";
  try {
    const r = predictEarningsOutcome({ signals: makeFullSignals() });
    assert(
      "EARNINGS_PREDICTOR_STATIC_THRESHOLDS=1 → static 35/65 thresholds applied",
      r.score_breakdown.miss_cut === 35 && r.score_breakdown.beat_cut === 65,
      { miss: r.score_breakdown.miss_cut, beat: r.score_breakdown.beat_cut },
    );
    assert(
      "static-fallback path stamps threshold_source='static_fallback'",
      r.score_breakdown.threshold_source === "static_fallback",
      r.score_breakdown.threshold_source,
    );
  } finally {
    delete process.env.EARNINGS_PREDICTOR_STATIC_THRESHOLDS;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
