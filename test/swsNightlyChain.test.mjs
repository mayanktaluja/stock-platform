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
  const m = nightly.match(/timeout\s+\d+\s+node\s+"\$\{FH_SCRIPT\}"/);
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

// ---- Autostash resilience: resolve_unmerged() helper + wiring ----
//
// Chronic stash-pop conflicts on .claude/launch.json kept leaving the
// working tree in an unresolved-merge state; the NEXT run's `git stash
// push` then refused to run on an unmerged tree and exited 5. The helper
// auto-resolves unmerged paths by taking --theirs and is called both
// before the autostash (sweep leftover state from prior runs) and after
// the pop (recover in-flight). The post-pop branch also drops the stash
// so the list doesn't grow without bound.

assert(
  "resolve_unmerged() helper is defined",
  /^resolve_unmerged\(\)\s*\{/m.test(nightly),
  null,
);
assert(
  "resolve_unmerged uses cut -f2 (handles paths with spaces)",
  /git ls-files --unmerged \| cut -f2/.test(nightly),
  null,
);
assert(
  "resolve_unmerged takes --theirs on conflict",
  /git checkout --theirs --/.test(nightly),
  null,
);

const preAutostashIdx = nightly.indexOf('resolve_unmerged "pre-autostash leftover-state cleanup"');
// Match the actual invocation (with the `if` guard), not the verbatim
// "git stash push" strings that also appear in the helper's docstring.
const stashPushIdx = nightly.indexOf("if git stash push --include-untracked -m");
assert(
  "resolve_unmerged is called BEFORE the autostash push",
  preAutostashIdx > -1 && stashPushIdx > -1 && preAutostashIdx < stashPushIdx,
  { preAutostashIdx, stashPushIdx },
);

const popConflictIdx = nightly.indexOf('resolve_unmerged "stash pop conflicted"');
const stashDropIdx = nightly.indexOf("git stash drop stash@{0}");
assert(
  "resolve_unmerged is called when stash pop conflicts",
  popConflictIdx > stashPushIdx,
  { popConflictIdx, stashPushIdx },
);
assert(
  "stash is dropped after pop-conflict auto-resolve",
  stashDropIdx > popConflictIdx,
  { stashDropIdx, popConflictIdx },
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
