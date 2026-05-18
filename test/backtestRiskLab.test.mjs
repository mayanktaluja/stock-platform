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
  // scored cannot exceed total
  assert("original scored <= total", report.summary.original.scored <= report.summary.total_resolved);
  assert("lab scored <= total", report.summary.lab.scored <= report.summary.total_resolved);
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
