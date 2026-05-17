/**
 * Regression test for the step-3c auxiliary-refresh chain in
 * scripts/sws-nightly.sh.
 *
 * surveillance.json and governance.json were NOT in the nightly job — their
 * only refresh path was a Vercel cron that silently no-ops (NSE blocks Vercel
 * datacenter IPs), so both went stale in production. PR B wired them into
 * step 3c. This test guards that wiring: a future edit that drops the
 * invocation, the governance→fundamentals ordering, the freshness gate, or
 * the commit-staging lists fails here instead of silently reintroducing the
 * staleness.
 *
 * It reads the ACTUAL sws-nightly.sh, not a re-implementation.
 *
 * Run with: node test/swsNightlyChain.test.mjs
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const nightly = readFileSync(resolve(REPO_ROOT, "scripts/sws-nightly.sh"), "utf-8");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

console.log("\nsws-nightly.sh step-3c chain — surveillance + governance wiring\n");

// Both refresh scripts must be invoked in the chain.
assert("refresh-surveillance.mjs is invoked", /node scripts\/refresh-surveillance\.mjs/.test(nightly), null);
assert("refresh-governance.mjs is invoked", /node scripts\/refresh-governance\.mjs/.test(nightly), null);

// Governance is gated — quarterly-cadence data, a daily refresh is pure waste.
assert("governance has a GOV_AGE_HOURS freshness gate", /GOV_AGE_HOURS[\s\S]*?-lt\s+\d+/.test(nightly), null);

// Ordering constraint: refresh-governance.mjs reads getAllFundamentals() and
// exits 1 if the fundamentals snapshot is empty — it MUST run after the
// fundamentals refresh block.
const fundIdx = nightly.indexOf("refresh-fundamentals.mjs 2>&1");
const govIdx = nightly.indexOf("refresh-governance.mjs 2>&1");
assert(
  "governance runs after fundamentals in the chain",
  fundIdx > -1 && govIdx > fundIdx,
  { fundIdx, govIdx },
);

// Both files must be staged for commit, checked for changes, AND included in
// the sanity-fail data-only PR — otherwise a successful refresh never ships.
const gitAddBlock = (nightly.match(/git add data\/sws\/deep\/[\s\S]*?fundamentalsHistory\.json/) || [""])[0];
const dataFilesBlock = (nightly.match(/DATA_FILES=\([\s\S]*?\)/) || [""])[0];
const changedFilesBlock =
  (nightly.match(/CHANGED_FILES=\$\(git status --short[\s\S]*?wc -l/) || [""])[0];

for (const f of ["surveillance.json", "governance.json"]) {
  assert(`${f} is staged in the git add list`, gitAddBlock.includes(f), null);
  assert(`${f} is in the DATA_FILES array (data-only PR path)`, dataFilesBlock.includes(f), null);
  assert(`${f} is in the CHANGED_FILES check`, changedFilesBlock.includes(f), null);
}

// Ordering constraint: the fundamentalsHistory refresh MUST run BEFORE
// refresh-earnings.mjs. Earnings reads fundamentalsHistory.json for the
// YoY-EPS-trajectory predictor component — running earnings first leaves
// it on yesterday's snapshot for up to 22h (the gap between fires).
const earningsIdx = nightly.indexOf("scripts/refresh-earnings.mjs 2>&1");
const fhIdx = (() => {
  // The script picks between refresh-fundamentals-history.mjs (preferred)
  // and fetch-fundamentals-history.mjs (fallback) — match either invocation.
  // Allow `with_timeout` OR `timeout` so this test remains the timing-order
  // guard, while the regression check below pins the wrapper-call form.
  const m = nightly.match(/(?:with_)?timeout\s+\d+\s+node\s+"\$\{FH_SCRIPT\}"/);
  return m ? nightly.indexOf(m[0]) : -1;
})();
assert(
  "fundamentalsHistory refresh runs before refresh-earnings.mjs",
  fhIdx > -1 && earningsIdx > -1 && fhIdx < earningsIdx,
  { fhIdx, earningsIdx },
);
assert(
  "fundamentalsHistory still has its 18h freshness gate",
  /FH_AGE_HOURS[\s\S]*?-lt\s+18/.test(nightly),
  null,
);

// Regression guard for the 2026-05-18 fix — stock macOS has no `timeout`
// binary. Every long-running node call must go through the `with_timeout`
// wrapper at lines 95-101, never `timeout` directly. A bare `timeout N node`
// silently fails on macOS with "timeout: command not found", and the chained
// `if !` swallows the error → the step is skipped without anyone noticing.
// One regression of this kind hid the fundamentals-history refresh on every
// nightly run for an unknown number of days.
const bareTimeoutCalls = (nightly.match(/^\s*(?:if\s+!\s+)?timeout\s+\d+\s+/gm) || []);
assert(
  "no bare `timeout` calls — all long-running steps must use with_timeout",
  bareTimeoutCalls.length === 0,
  { offenders: bareTimeoutCalls },
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
