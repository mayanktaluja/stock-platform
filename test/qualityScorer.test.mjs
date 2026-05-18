import { computeQualityScore } from "../services/riskLab/quality/qualityScorer.js";
import { calibrateConfidence } from "../services/riskLab/quality/confidenceCalibrator.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

// ─── KEC canonical case — the test that defines success ─────────────────
const KEC_INPUT = {
  ticker: "KEC",
  original_score: 80.1,
  original_verdict: "BEAT",
  original_confidence: 65,
  v3_breakdown: {
    fv_imputed: false,
    momentum_imputed: false,
    pts_future: 9,
    pts_health: 3.7,
  },
  sector: "Capital Goods",
  counter_thesis: null,  // KEC isn't in upcoming_earnings section
  risks: [
    "Interest payments are not well covered by earnings",
    "Dividend of 1% is not well covered by free cash flows",
    "Receivables stretched relative to industry",  // synthetic — triggers sector overlay
  ],
  news: [
    { title: "KEC International Limited to Report Q4, 2026 Results on May 16, 2026", date: "2026-05-08T10:50:00.000Z" },
    { title: "KEC International Limited Just Missed EPS By 41%: Here's What Analysts Think Will Happen Next", date: "2026-02-03T00:37:47.000Z" },
    { title: "Third quarter 2026 earnings: EPS and revenues miss analyst expectations", date: "2026-01-31T21:25:58.000Z" },
  ],
  event_iso_date: "2026-05-16T06:45:00.000Z",
};

console.log("qualityScorer: KEC end-to-end (the defining test)");
{
  const result = computeQualityScore(KEC_INPUT);

  // The single most important assertion: KEC must show as LOW quality
  assert("KEC: quality_verdict = LOW", result.quality_verdict === "LOW", result.quality_verdict);
  assert("KEC: combined_verdict = LOW_QUALITY_BEAT", result.combined_verdict === "LOW_QUALITY_BEAT");

  // Must capture at least: consecutive_miss + interest_coverage + cash_flow_weakness + sector overlay
  const types = result.quality_flags.map((f) => f.type || f.category || f.overlay);
  assert("KEC: consecutive_miss fires", types.includes("consecutive_miss"), types);
  assert("KEC: interest_coverage fires", types.includes("interest_coverage"));
  assert("KEC: cash_flow_weakness fires", types.includes("cash_flow_weakness"));
  assert("KEC: epc_td_working_capital fires", types.includes("epc_td_working_capital"));

  // Combined delta should hit the cap (-10) given KEC carries 4 strong flags
  assert("KEC: quality_score_delta hits cap", result.quality_score_delta === -10);

  // Adjusted score: 80.1 + (-10) = 70.1 — still above MISS threshold of 34
  assert("KEC: adjusted_score = 70.1", Math.abs(result.quality_adjusted_score - 70.1) < 0.01);

  // Confidence calibrator: KEC had consecutive_miss (-15) + cost_pressure
  // (interest_coverage severity -2 → -8) = -23 penalty. 65 - 23 = 42, but
  // floor is 50. So adjusted confidence = 50.
  assert("KEC: adjusted_confidence = 50 (floor)", result.quality_adjusted_confidence === 50);
  assert("KEC: penalty applied was substantial", result.quality_confidence_breakdown.penalty_applied <= -20);

  // Veto check: original is BEAT not TOP_PICK, so veto doesn't fire
  assert("KEC: not vetoed (BEAT not TOP_PICK)", result.quality_veto.vetoed === false);

  // Original fields preserved
  assert("KEC: original_score unchanged", result.original_score === 80.1);
  assert("KEC: original_verdict unchanged", result.original_verdict === "BEAT");
  assert("KEC: original_confidence unchanged", result.original_confidence === 65);
}

console.log("qualityScorer: TOP_PICK with 3+ flags + heavy delta → vetoed");
{
  const result = computeQualityScore({
    ...KEC_INPUT,
    original_verdict: "TOP_PICK",
  });
  assert("TOP_PICK + heavy quality: vetoed", result.quality_veto.vetoed === true);
  assert("TOP_PICK + heavy quality: adjusted_verdict = QUALITY_HOLD", result.quality_adjusted_verdict === "QUALITY_HOLD");
  assert("TOP_PICK + heavy quality: combined LOW_QUALITY_TOP_PICK", result.combined_verdict === "LOW_QUALITY_TOP_PICK");
}

console.log("qualityScorer: clean stock (HIGH quality)");
{
  const result = computeQualityScore({
    ticker: "JSLL",
    original_score: 83.6,
    original_verdict: "TOP_PICK",
    v3_breakdown: { fv_imputed: false, momentum_imputed: false },
    sector: "Healthcare",
    counter_thesis: { verdict_bias: "bullish", text: "+34.5% over 1Y — trend supports.", falsification_trigger: null },
    risks: ["Earnings are forecast to grow 25% per year"],  // benign
    news: [{ title: "JSLL: New product launch in Q4", date: "2026-04-01" }],
  });
  assert("clean: HIGH quality", result.quality_verdict === "HIGH");
  assert("clean: 0 flags", result.quality_flags.length === 0);
  assert("clean: 0 delta", result.quality_score_delta === 0);
  assert("clean: adjusted_score unchanged", result.quality_adjusted_score === 83.6);
  assert("clean: combined HIGH_QUALITY_TOP_PICK", result.combined_verdict === "HIGH_QUALITY_TOP_PICK");
  assert("clean: not vetoed", result.quality_veto.vetoed === false);
}

console.log("qualityScorer: MEDIUM quality (1-2 flags)");
{
  const result = computeQualityScore({
    ticker: "X",
    original_score: 70,
    original_verdict: "STRONG",
    v3_breakdown: { fv_imputed: false, momentum_imputed: false },
    sector: "IT Services",
    risks: ["Interest payments are not well covered by earnings"],
    news: [],
  });
  assert("MEDIUM: 1 flag", result.quality_flags.length === 1);
  assert("MEDIUM: quality_verdict = MEDIUM", result.quality_verdict === "MEDIUM");
  assert("MEDIUM: combined_verdict = MEDIUM_QUALITY_STRONG", result.combined_verdict === "MEDIUM_QUALITY_STRONG");
}

console.log("qualityScorer: INSUFFICIENT_DATA (no risks AND no news)");
{
  const result = computeQualityScore({
    ticker: "Y",
    original_score: 60,
    original_verdict: "STRONG",
    v3_breakdown: { fv_imputed: false, momentum_imputed: false },
    sector: "IT Services",
    risks: null,
    news: null,
  });
  assert("INSUFFICIENT_DATA: quality_verdict", result.quality_verdict === "INSUFFICIENT_DATA");
  assert("INSUFFICIENT_DATA: combined_verdict", result.combined_verdict === "INSUFFICIENT_STRONG");
}

console.log("confidenceCalibrator: per-bucket penalties");
{
  // Original 65, consecutive_miss flag (-15) → 50
  const r1 = calibrateConfidence(65, [{ type: "consecutive_miss", severity: -4 }]);
  assert("consecutive_miss: 65→50", r1.adjusted_confidence === 50);

  // Original 65, no flags → 65
  const r2 = calibrateConfidence(65, []);
  assert("no flags: unchanged 65", r2.adjusted_confidence === 65);

  // Original 65, fv_imputed flag (-10) → 55
  const r3 = calibrateConfidence(65, [{ type: "fv_imputed", severity: -2 }]);
  assert("imputation: 65→55", r3.adjusted_confidence === 55);

  // null confidence → null result
  assert("null confidence → null", calibrateConfidence(null, [{}]) === null);

  // Two buckets — sector_overlay (-5) + cost_pressure (-8) = -13 → 65-13 = 52
  const r4 = calibrateConfidence(65, [
    { overlay: "epc_td_working_capital", severity: -2 },
    { category: "interest_coverage", severity: -2 },
  ]);
  assert("two buckets: 65→52", r4.adjusted_confidence === 52);
}

if (_failed === 0) {
  console.log("qualityScorer: PASS");
  process.exit(0);
} else {
  console.error(`qualityScorer: FAIL (${_failed})`);
  process.exit(1);
}
