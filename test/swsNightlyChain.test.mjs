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
const swsConfig = readFileSync(resolve(REPO_ROOT, "scripts/sws-config.mjs"), "utf-8");

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

const catalystInvocations = nightly.match(/node scripts\/refresh-catalysts\.mjs/g) || [];
const nseCorpInvocations = nightly.match(/node scripts\/refresh-nse-corporate\.mjs/g) || [];
assert(
  "refresh-catalysts.mjs is invoked once from the parallel NSE catalyst branch",
  catalystInvocations.length === 1 && /run_nse_catalyst_branch[\s\S]*?node scripts\/refresh-catalysts\.mjs/.test(nightly),
  { count: catalystInvocations.length },
);
assert(
  "refresh-nse-corporate.mjs is invoked once from the parallel NSE catalyst branch",
  nseCorpInvocations.length === 1 && /run_nse_catalyst_branch[\s\S]*?node scripts\/refresh-nse-corporate\.mjs/.test(nightly),
  { count: nseCorpInvocations.length },
);
assert(
  "SWS and NSE catalyst branches are launched before a shared wait barrier",
  /run_sws_primary_branch[\s\S]*?SWS_BRANCH_PID=\$![\s\S]*?run_nse_catalyst_branch[\s\S]*?NSE_BRANCH_PID=\$![\s\S]*?wait "\$\{SWS_BRANCH_PID\}"[\s\S]*?wait "\$\{NSE_BRANCH_PID\}"/.test(nightly),
  null,
);

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
const gitAddBlock = (nightly.match(/git add data\/sws\/deep\.tar\.gz[\s\S]*?fundamentalsHistory\.json/) || [""])[0];
const dataFilesBlock = (nightly.match(/DATA_FILES=\([\s\S]*?\)/) || [""])[0];
const changedFilesBlock =
  (nightly.match(/CHANGED_FILES=\$\(git status --short[\s\S]*?wc -l/) || [""])[0];

for (const f of ["surveillance.json", "governance.json"]) {
  assert(`${f} is staged in the git add list`, gitAddBlock.includes(f), null);
  assert(`${f} is in the DATA_FILES array (data-only PR path)`, dataFilesBlock.includes(f), null);
  assert(`${f} is in the CHANGED_FILES check`, changedFilesBlock.includes(f), null);
}
for (const f of ["data/macroCalendar.json", "data/nse-index-constituents.json"]) {
  assert(`${f} is staged in the git add list`, gitAddBlock.includes(f), null);
  assert(`${f} is in the DATA_FILES array (data-only PR path)`, dataFilesBlock.includes(f), null);
  assert(`${f} is in the CHANGED_FILES check`, changedFilesBlock.includes(f), null);
}

// India modals in prod read data/sws/deep.tar.gz, not loose data/sws/deep/*,
// because .vercelignore excludes the thousands of loose deep files. The inner
// refresh script packs the tarball only inside its own auto-PR block; nightly
// runs it with SWS_AUTO_PR=0, so this outer script must pack + stage it.
const packIdx = nightly.indexOf("bash scripts/sws-pack-deep.sh");
const coverageIdx = nightly.indexOf("running coverage-gap-analysis");
assert(
  "nightly packs India deep.tar.gz after sanity passes and before commit staging",
  packIdx > -1 && coverageIdx > -1 && packIdx < coverageIdx,
  { packIdx, coverageIdx },
);
assert("data/sws/deep.tar.gz is staged in the git add list", gitAddBlock.includes("data/sws/deep.tar.gz"), null);
assert("data/sws/deep.tar.gz is in the CHANGED_FILES check", changedFilesBlock.includes("data/sws/deep.tar.gz"), null);
assert(
  "nightly auto-PR does not stage loose data/sws/deep files",
  !changedFilesBlock.includes("data/sws/deep/") && !gitAddBlock.includes("data/sws/deep/"),
  null,
);
assert(
  "nightly auto-PR does not stage oversized Groww stock cache",
  !changedFilesBlock.includes("data/sws/groww-stock-latest.json") &&
    !gitAddBlock.includes("data/sws/groww-stock-latest.json"),
  null,
);
assert(
  "macOS timeout fallback enforces a real watchdog",
  /sleep "\$\{seconds\}"[\s\S]*?command exceeded[\s\S]*?kill -TERM "\$\{child_pid\}"/.test(nightly),
  null,
);

// Ordering constraint: the fundamentalsHistory refresh MUST run BEFORE
// refresh-earnings.mjs. Earnings reads fundamentalsHistory.json for the
// YoY-EPS-trajectory predictor component — running earnings first leaves
// it on yesterday's snapshot for up to 22h (the gap between fires).
const earningsInvocation = "scripts/refresh-earnings.mjs --window 60 --past-window-days 14 2>&1";
const earningsIdx = nightly.indexOf(earningsInvocation);
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
const barrierIdx = nightly.indexOf("parallel refresh barrier complete");
assert(
  "refresh-earnings.mjs runs after the parallel branch barrier",
  barrierIdx > -1 && earningsIdx > barrierIdx,
  { barrierIdx, earningsIdx },
);
assert(
  "refresh-earnings.mjs explicitly refreshes the 60-day watch window",
  earningsIdx > -1,
  null,
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
assert(
  "network preflight uses HTTPS reachability instead of ICMP-only ping",
  !/ping -c 1 -t 5 8\.8\.8\.8/.test(nightly) &&
    /curl -fsSL --connect-timeout 8 --max-time 20/.test(nightly) &&
    /https:\/\/simplywall\.st/.test(nightly),
  null,
);
assert(
  "macro calendar refresh is wired into the auxiliary chain",
  /node scripts\/refresh-macro-calendar\.mjs/.test(nightly) &&
    /aux_status "macroCalendar\.json" "OK"/.test(nightly),
  null,
);
assert(
  "early SWS scrape failure still runs auxiliary refreshes then data-only auto-ship",
  /SWS_PRIMARY_FAILED=1/.test(nightly) &&
    /continuing auxiliary refresh chain before data-only ship/.test(nightly) &&
    /ship_nightly_data_only "SWS scrape pipeline failed before sanity gate"/.test(nightly) &&
    /sws_auto_ship_market "\$\{nightly_data_only_paths\[@\]\}"/.test(nightly),
  null,
);

// ---------------------------------------------------------------- tripwire
// Mid-run revert tripwire (2026-05-19 RCA fix): the outer sanity gate's
// FAIL email must differentiate "scoring-phase failure" from "data reverted
// during aux chain" by reading the inline-pass marker file written by
// sws-refresh-api.sh. Without these, the operator can't tell which class
// of failure happened — the 2026-05-18 22:37 IST symptom was identical
// for both cases (picks_recent BLOCK), but the cause was the second.
assert(
  "sws-nightly.sh reads INLINE_PASS_FLAG to diagnose mid-run revert",
  /INLINE_PASS_FLAG=.*_inline_pass\.flag/.test(nightly),
  null,
);
assert(
  "sws-nightly.sh sets TRIPWIRE_DIAGNOSIS when inline passed but outer failed",
  /TRIPWIRE_DIAGNOSIS=.*MID-RUN REVERT DETECTED/.test(nightly),
  null,
);
assert(
  "sws-nightly.sh sets TRIPWIRE_DIAGNOSIS when inline did not pass (scoring-phase)",
  /TRIPWIRE_DIAGNOSIS=.*SCORING-PHASE FAILURE/.test(nightly),
  null,
);
assert(
  "sws-nightly.sh email body includes timestamps (picks scanned_at, lr started_at, finished_at)",
  /picks-latest\.json scanned_at[\s\S]+last-refresh\.json started_at[\s\S]+last-refresh\.json finished_at/.test(nightly),
  null,
);

// And refresh-api.sh runs the inline gate between stamp and PDF.
const refreshApi = readFileSync(
  resolve(REPO_ROOT, "scripts/sws-refresh-api.sh"),
  "utf-8",
);
assert(
  "sws-refresh-api.sh invokes the inline sanity gate (--inline)",
  /node scripts\/sws-sanity-gate\.mjs --inline/.test(refreshApi),
  null,
);
assert(
  "sws-refresh-api.sh clears INLINE_PASS_FLAG at start of inline-gate step",
  /rm -f "\$\{INLINE_PASS_FLAG\}"/.test(refreshApi),
  null,
);
assert(
  "sws-refresh-api.sh stamps RUN_STARTED_ISO into summary started_at",
  /RUN_STARTED_ISO=.*date.*-u/.test(refreshApi) &&
    /started_at: "\$\{RUN_STARTED_ISO\}"/.test(refreshApi),
  null,
);

const growwPeIdx = refreshApi.indexOf("node scripts/groww-pe-refresh.mjs");
const parserIdx = refreshApi.indexOf("node scripts/sws-api-parser.mjs --dest deep");
const scoringIdx = refreshApi.indexOf("node scripts/sws-scoring.mjs");
assert(
  "sws-refresh-api.sh refreshes/validates Groww stock cache before parser/scoring",
  growwPeIdx > -1 && parserIdx > growwPeIdx && scoringIdx > parserIdx,
  { growwPeIdx, parserIdx, scoringIdx },
);
assert(
  "sws-refresh-api.sh gates full Groww refresh to the 00:30 IST launchd window",
  /RUN_STARTED_IST_HHMM=.*Asia\/Kolkata/.test(refreshApi) &&
    /GROWW_STEP_IST_HHMM=.*Asia\/Kolkata/.test(refreshApi) &&
    /\[ "\$\{RUN_STARTED_IST_HHMM\}" -ge 0 \]/.test(refreshApi) &&
    /\[ "\$\{RUN_STARTED_IST_HHMM\}" -lt 200 \]/.test(refreshApi) &&
    /--validate-only/.test(refreshApi) &&
    /--force --max-age-days 1 --stale-grace-days 3/.test(refreshApi),
  null,
);
assert(
  "SWS circadian window allows the 00:30 launchd scrape",
  /circadianWindow:\s*\{\s*startHour:\s*0,\s*startMinute:\s*0,\s*endHour:\s*4,\s*endMinute:\s*30\s*\}/.test(swsConfig) &&
    /circadianStartJitterMinutes:\s*0/.test(swsConfig),
  null,
);
assert(
  "sws-refresh-api.sh summary includes Groww stock cache and endpoint timing telemetry",
  /groww_stock_cache: growwStockCache/.test(refreshApi) &&
    /endpoint_timing: endpointTiming/.test(refreshApi),
  null,
);
assert(
  "sws-refresh-api.sh auto-PR stages deep.tar.gz but not loose deep files",
  /git add data\/sws\/deep\.tar\.gz/.test(refreshApi) &&
    !/git add data\/sws\/deep\/(?:\s|2>)/.test(refreshApi),
  null,
);
assert(
  "sws-refresh-api.sh auto-PR does not stage oversized Groww stock cache",
  !/git add .*data\/sws\/groww-stock-latest\.json/.test(refreshApi),
  null,
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
