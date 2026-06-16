/**
 * Risk Lab backtest smoke test.
 *
 * Spawns scripts/backtest-risk-lab.mjs --json against real history files,
 * parses the JSON, asserts the report shape. This is an INTEGRATION smoke
 * test, not a unit test — it relies on production data files being present.
 *
 * Self-skips if data/catalysts/earnings-history/ is empty (CI without
 * archive data).
 */

import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";

const HISTORY_DIR = "data/catalysts/earnings-history";

if (!existsSync(HISTORY_DIR) || readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).length === 0) {
  console.log(`backtestRiskLab: SKIP — ${HISTORY_DIR} empty`);
  process.exit(0);
}

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

const child = spawn("node", ["scripts/backtest-risk-lab.mjs", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
child.stdout.on("data", (b) => { stdout += b.toString(); });
let stderr = "";
child.stderr.on("data", (b) => { stderr += b.toString(); });

await new Promise((resolve) => child.on("close", resolve));

let report;
try {
  report = JSON.parse(stdout);
} catch (err) {
  console.error("backtestRiskLab: FAIL — JSON parse error");
  console.error(stderr);
  process.exit(1);
}

console.log("backtestRiskLab: report shape");
{
  assert("has summary", report.summary && typeof report.summary.total_resolved === "number");
  assert("has original block", report.summary.original && typeof report.summary.original.scored === "number");
  assert("has lab block", report.summary.lab && typeof report.summary.lab.scored === "number");
  assert("has hit_rate_diff_pct", typeof report.summary.hit_rate_diff_pct === "number");
  assert("has ab_status", report.ab_status && typeof report.ab_status.meaningful === "boolean");
  assert("has lens blocks", report.lenses && typeof report.lenses === "object");
  for (const lensName of ["macro", "quality", "llm_disagreement", "combined"]) {
    const lens = report.lenses?.[lensName];
    assert(`${lensName}: has strict hit rate`, typeof lens?.strict_hit_rate_pct === "number", lens);
    assert(`${lensName}: has catastrophic block`, lens?.catastrophic && typeof lens.catastrophic.improvement_count === "number", lens?.catastrophic);
    assert(`${lensName}: has avoidance precision/recall`, lens?.flagged_avoidance && hasOwn(lens.flagged_avoidance, "precision_pct") && hasOwn(lens.flagged_avoidance, "recall_pct"), lens?.flagged_avoidance);
    assert(`${lensName}: has bucket counts`, lens?.bucket_counts && typeof lens.bucket_counts === "object", lens?.bucket_counts);
    assert(`${lensName}: has avoidance bucket counts`, lens?.avoidance_bucket_counts && typeof lens.avoidance_bucket_counts.flagged_avoidance === "number", lens?.avoidance_bucket_counts);
  }
  assert("ab_status requires catastrophic improvement", report.ab_status.requires_catastrophic_improvement === true);
  assert("ab_status exposes gate checks", report.ab_status.checks && typeof report.ab_status.checks === "object");
  assert("has kec_case_study", report.kec_case_study && typeof report.kec_case_study.count === "number");
  assert("has anantraj_case_study", report.anantraj_case_study && typeof report.anantraj_case_study.count === "number");
  assert("kec cases is array", Array.isArray(report.kec_case_study.cases));
  assert("anantraj cases is array", Array.isArray(report.anantraj_case_study.cases));
}

console.log("backtestRiskLab: rationality checks");
{
  // hit rate values should be 0-100
  assert("original hit rate 0-100", report.summary.original.hit_rate_pct >= 0 && report.summary.original.hit_rate_pct <= 100);
  assert("lab hit rate 0-100", report.summary.lab.hit_rate_pct >= 0 && report.summary.lab.hit_rate_pct <= 100);
  assert("summary.lab remains combined lens alias", report.summary.lab.strict_hit_rate_pct === report.lenses.combined.strict_hit_rate_pct);
  // scored cannot exceed total
  assert("original scored <= total", report.summary.original.scored <= report.summary.total_resolved);
  assert("lab scored <= total", report.summary.lab.scored <= report.summary.total_resolved);
  for (const lensName of ["macro", "quality", "llm_disagreement", "combined"]) {
    const lens = report.lenses[lensName];
    assert(`${lensName}: strict hit rate 0-100`, lens.strict_hit_rate_pct >= 0 && lens.strict_hit_rate_pct <= 100, lens.strict_hit_rate_pct);
    assert(`${lensName}: flagged avoidance count <= total`, lens.flagged_avoidance.flagged_count <= report.summary.total_resolved, lens.flagged_avoidance.flagged_count);
    if (lens.flagged_avoidance.precision_pct !== null) {
      assert(`${lensName}: precision 0-100`, lens.flagged_avoidance.precision_pct >= 0 && lens.flagged_avoidance.precision_pct <= 100, lens.flagged_avoidance.precision_pct);
    }
    if (lens.flagged_avoidance.recall_pct !== null) {
      assert(`${lensName}: recall 0-100`, lens.flagged_avoidance.recall_pct >= 0 && lens.flagged_avoidance.recall_pct <= 100, lens.flagged_avoidance.recall_pct);
    }
    assert(`${lensName}: catastrophic count cannot exceed total`, lens.catastrophic.lens_beat_miss_count <= report.summary.total_resolved, lens.catastrophic);
  }
  if (report.ab_status.meaningful) {
    assert("meaningful gate has enough resolved", report.ab_status.checks.min_resolved.ok === true);
    assert("meaningful gate has per-actual-bucket samples", report.ab_status.checks.min_actual_verdict_bucket.ok === true);
    assert("meaningful gate has per-avoidance-bucket samples", report.ab_status.checks.min_combined_avoidance_bucket.ok === true);
    assert("meaningful gate has catastrophic improvement", report.ab_status.checks.catastrophic_improvement.ok === true);
  }
  // KEC case study count should not exceed total resolved
  assert("kec count <= total_resolved", report.kec_case_study.count <= report.summary.total_resolved);
  // ANANTRAJ count should not exceed total
  assert("anantraj count <= total_resolved", report.anantraj_case_study.count <= report.summary.total_resolved);
}

if (_failed === 0) {
  console.log("backtestRiskLab: PASS");
  console.log(`  (summary: ${report.summary.total_resolved} resolved; orig=${report.summary.original.hit_rate_pct}% lab=${report.summary.lab.hit_rate_pct}% Δ=${report.summary.hit_rate_diff_pct}pp; ${report.kec_case_study.count} KEC-class, ${report.anantraj_case_study.count} ANANTRAJ-class)`);
  process.exit(0);
} else {
  console.error(`backtestRiskLab: FAIL (${_failed})`);
  process.exit(1);
}
