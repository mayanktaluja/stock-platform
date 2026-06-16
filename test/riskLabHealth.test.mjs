import { buildLabHealth, formatSlackMessage } from "../services/riskLab/labHealth.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

function makePayload(overrides = {}) {
  return {
    generated_at: new Date().toISOString(),
    source_regime_generated_at: new Date().toISOString(), // fresh
    summary: {
      total_stocks: 1884,
      macro_flagged_count: 200,
      macro_vetoed_count: 10,
      macro_stale_skipped_count: 0,
      quality_flagged_count: 600,
      quality_vetoed_count: 6,
      low_quality_count: 50,
    },
    ...overrides,
  };
}

console.log("labHealth: clean payload → OK");
{
  const h = buildLabHealth(makePayload());
  assert("status OK", h.status === "OK");
  assert("no alerts", h.alerts.length === 0);
}

console.log("labHealth: macro overlay too broad → DEGRADED");
{
  const h = buildLabHealth(makePayload({
    summary: { total_stocks: 100, macro_vetoed_count: 30, quality_flagged_count: 10 },
  }));
  assert("status DEGRADED", h.status === "DEGRADED");
  assert("macro_overlay_too_broad alert fires", h.alerts.some((a) => a.category === "macro_overlay_too_broad"));
}

console.log("labHealth: quality taxonomy too loose → OK_WITH_NOTES");
{
  const h = buildLabHealth(makePayload({
    summary: { total_stocks: 100, macro_vetoed_count: 0, quality_flagged_count: 50 },
  }));
  assert("status OK_WITH_NOTES (info-only alert)", h.status === "OK_WITH_NOTES");
  assert("quality_taxonomy_too_loose alert", h.alerts.some((a) => a.category === "quality_taxonomy_too_loose"));
}

console.log("labHealth: regime stale + Macro skipped en masse → DEGRADED");
{
  const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h old
  const h = buildLabHealth(makePayload({
    source_regime_generated_at: oldDate,
    summary: { total_stocks: 100, macro_vetoed_count: 0, quality_flagged_count: 10, macro_stale_skipped_count: 80 },
  }));
  assert("regime_stale alert fires", h.alerts.some((a) => a.category === "regime_stale_overlay_skipped"));
  assert("status DEGRADED", h.status === "DEGRADED");
}

console.log("labHealth: case study positive → OK_WITH_NOTES");
{
  const h = buildLabHealth(makePayload(), {
    summary: { total_resolved: 50, original: { hit_rate_pct: 24 }, lab: { hit_rate_pct: 34 }, hit_rate_diff_pct: 10 },
    ab_status: { meaningful: true },
    lenses: {
      combined: {
        catastrophic: { improvement_count: 4 },
        flagged_avoidance: { precision_pct: 50, recall_pct: 40 },
      },
    },
    kec_case_study: { count: 5 },
    anantraj_case_study: { count: 0 },
  });
  assert("case_study_caught alert fires", h.alerts.some((a) => a.category === "case_study_caught"));
  assert("status OK_WITH_NOTES (positive info)", h.status === "OK_WITH_NOTES");
  assert("summary carries AB meaningful flag", h.summary.backtest_ab_meaningful === true);
  assert("summary carries catastrophic improvement", h.summary.backtest_combined_catastrophic_improvement_count === 4);
  assert("summary carries avoidance precision", h.summary.backtest_combined_avoidance_precision_pct === 50);
  assert("summary carries avoidance recall", h.summary.backtest_combined_avoidance_recall_pct === 40);
}

console.log("labHealth: case study regression → DEGRADED");
{
  const h = buildLabHealth(makePayload(), {
    summary: { total_resolved: 50, original: { hit_rate_pct: 30 }, lab: { hit_rate_pct: 20 }, hit_rate_diff_pct: -10 },
    ab_status: { meaningful: true },
    kec_case_study: { count: 0 },
    anantraj_case_study: { count: 0 },
  });
  assert("case_study_regression alert", h.alerts.some((a) => a.category === "case_study_regression"));
  assert("status DEGRADED on regression", h.status === "DEGRADED");
}

console.log("labHealth: backtest A/B not meaningful → no case study alert");
{
  const h = buildLabHealth(makePayload(), {
    summary: { total_resolved: 5, original: { hit_rate_pct: 100 }, lab: { hit_rate_pct: 0 }, hit_rate_diff_pct: -100 },
    ab_status: { meaningful: false },
    kec_case_study: { count: 0 },
    anantraj_case_study: { count: 0 },
  });
  assert("no case_study alert when AB not meaningful", !h.alerts.some((a) => a.category.startsWith("case_study")));
}

console.log("labHealth: formatSlackMessage");
{
  const h = buildLabHealth(makePayload());
  const msg = formatSlackMessage(h);
  assert("clean: returns single line", typeof msg === "string" && !msg.includes("\n"));
  assert("clean: has OK emoji", msg.includes("✅"));

  const hAlert = buildLabHealth(makePayload({
    summary: { total_stocks: 100, macro_vetoed_count: 30, quality_flagged_count: 10 },
  }));
  const msgAlert = formatSlackMessage(hAlert);
  assert("alert: has warn emoji", msgAlert.includes("⚠️"));
  assert("alert: includes alert text", msgAlert.includes("macro_overlay_too_broad"));
}

if (_failed === 0) {
  console.log("riskLabHealth: PASS");
  process.exit(0);
} else {
  console.error(`riskLabHealth: FAIL (${_failed})`);
  process.exit(1);
}
