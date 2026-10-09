#!/usr/bin/env bash
#
# Test resume-after-abort across the scripts that share it:
#   sws-nightly-isolated.sh  writes data/sws/_resume-scrape.json on a deadline
#                            abort (exit 10)  — pinned in swsNightlyTelemetry
#   sws-refresh-api.sh       step 3 consumes it → SWS_SCRAPE_SKIP_FRESH_SEC
#   sws-api-scrape.mjs       skips a stock whose raw payload is young
#
# WHY THIS EXISTS: 2026-09-26 and 09-29 were killed by the 21h deadline at
# 21% / 67% (asleep on battery) and the next run's step-3 rewind threw all of
# that away. "Skip the rewind, continue from the cursor" was replayed against
# the real sanity gate first and fails it in every scenario (fresh_pct 33-79 vs
# the 85 block floor: carried payloads are 20-30h old at finish), so the rewind
# stays and the reuse is per stock, bounded so both the gate and the 36h top-up
# demotion keep their meaning (bound pinned in test/swsScrapeProgress.test.mjs).
#
# The step-3 block is extracted from the real script and run in a fixture.
#
# Run with: bash test/swsResumeAfterAbort.test.sh

set -uo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/sws-refresh-api.sh"
SCRAPER="${REPO_ROOT}/scripts/sws-api-scrape.mjs"
WORK="$(mktemp -d "/tmp/sws-resume-after-abort-$$.XXXXXX")"
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ FAIL: $2 ${3:-}"; fi; }

echo ""
echo "resume after a deadline abort"
echo ""

# Step 3 from the rewind comment through the end of the resume block.
STEP3="$(awk '
  index($0, "  # Reset next_local_index so each fresh invocation") == 1 { f=1 }
  f { print }
  index($0, "  # ── end resume after a deadline abort ──") == 1 { exit }
' "${SCRIPT}")"
if printf '%s' "${STEP3}" | grep -q 'consume-resume' && printf '%s' "${STEP3}" | grep -q 'next_local_index = 0'; then
  ok 1 "step-3 rewind + resume block extracted"
else
  ok 0 "step-3 rewind + resume block extracted" "(markers moved?)"
fi

mkdir -p "${WORK}/scripts"
cp "${REPO_ROOT}/scripts/sws-scrape-progress.mjs" "${REPO_ROOT}/scripts/sws-shard-partition.mjs" \
   "${REPO_ROOT}/scripts/sws-config.mjs" "${WORK}/scripts/"

fresh_fixture() {
  rm -rf "${WORK}/data"
  mkdir -p "${WORK}/data/sws"
  node -e '
    const fs = require("fs"), dir = process.argv[1];
    fs.writeFileSync(dir + "/universe.json", JSON.stringify(["AA","BB","CC","DD","EE","FF"].map((t) => ({ ticker: t }))));
    for (const sid of [1, 2, 3]) fs.writeFileSync(`${dir}/progress-api-${sid}.json`, JSON.stringify({ shard_id: sid, next_local_index: 2, done_count: 50 }));
  ' "${WORK}/data/sws"
}

write_marker() {  # write_marker <aborted_hours_ago> <carry>
  node -e '
    const [dir, h, carry] = process.argv.slice(1);
    require("fs").writeFileSync(dir + "/_resume-scrape.json", JSON.stringify({ schema: 1,
      aborted_at: new Date(Date.now() - Number(h) * 3600e3).toISOString(), carry: Number(carry) }));
  ' "${WORK}/data/sws" "$1" "$2"
}

run_step3() {  # env passes through; prints the block's output then SKIP=<sec>
  ( cd "${WORK}" && eval "${STEP3}"; echo "SKIP=${RESUME_SKIP_FRESH_SEC}" ) 2>&1
}

cursors() { node -e 'const d=process.argv[1];console.log([1,2,3].map(s=>JSON.parse(require("fs").readFileSync(`${d}/progress-api-${s}.json`)).next_local_index).join(","))' "${WORK}/data/sws"; }
consumed_verdict() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/_resume-scrape.consumed.json")).verdict)}catch{console.log("none")}' "${WORK}/data/sws"; }

echo "--- step 3 ---"
fresh_fixture; write_marker 3 1
out="$(run_step3)"
echo "${out}" | grep -qx 'SKIP=25200' && ok 1 "marker from the 21:30 abort (3h old, carry 1) → shards skip payloads < 7h" || ok 0 "fresh marker → SKIP=25200" "(${out})"
[ "$(cursors)" = "0,0,0" ] && ok 1 "…and the cursors are STILL rewound to 0 (no positional carry)" || ok 0 "cursors rewound" "($(cursors))"
[ ! -e "${WORK}/data/sws/_resume-scrape.json" ] && [ "$(consumed_verdict)" = "resume" ] \
  && ok 1 "…marker archived as consumed (verdict=resume), so it is used once" || ok 0 "marker archived" "($(consumed_verdict))"
echo "${out}" | grep -q '^\[resume\] resuming after the deadline abort' && ok 1 "…and says so in the log" || ok 0 "logs the resume" "(${out})"

fresh_fixture; write_marker 31 1
out="$(run_step3)"
echo "${out}" | grep -qx 'SKIP=0' && [ "$(consumed_verdict)" = "stale" ] \
  && ok 1 "31h-old marker → stale, no skip, archived" || ok 0 "stale marker" "(${out})"

fresh_fixture; write_marker 3 2
out="$(run_step3)"
echo "${out}" | grep -qx 'SKIP=0' && [ "$(consumed_verdict)" = "carry_exceeded" ] \
  && ok 1 "carry 2 → no skip (the run that reused the last abort was aborted too)" || ok 0 "carry 2" "(${out})"

fresh_fixture
out="$(run_step3)"
echo "${out}" | grep -qx 'SKIP=0' && [ "$(cursors)" = "0,0,0" ] && [ "$(consumed_verdict)" = "none" ] \
  && ok 1 "no marker → exactly the old behaviour (rewind, no skip)" || ok 0 "no marker" "(${out})"

fresh_fixture; write_marker 3 1
out="$( SWS_RESUME=1 run_step3 )"
echo "${out}" | grep -qx 'SKIP=0' && [ "$(cursors)" = "2,2,2" ] && [ -e "${WORK}/data/sws/_resume-scrape.json" ] \
  && ok 1 "SWS_RESUME=1 → cursors kept, marker left for the next normal run" || ok 0 "SWS_RESUME=1" "(${out}; $(cursors))"

fresh_fixture
out="$( SWS_SCRAPE_SKIP_FRESH_SEC=600 run_step3 )"
echo "${out}" | grep -qx 'SKIP=600' && ok 1 "SWS_SCRAPE_SKIP_FRESH_SEC by hand opts a manual run in" || ok 0 "manual opt-in" "(${out})"

# The helper failing must fall back to a normal full pass, never to a skip.
fresh_fixture; write_marker 3 1
mv "${WORK}/scripts/sws-scrape-progress.mjs" "${WORK}/scripts/sws-scrape-progress.mjs.off"
out="$(run_step3)"
mv "${WORK}/scripts/sws-scrape-progress.mjs.off" "${WORK}/scripts/sws-scrape-progress.mjs"
echo "${out}" | grep -qx 'SKIP=0' && echo "${out}" | grep -q 'consume-resume failed — normal full pass' \
  && ok 1 "helper missing/crashing → normal full pass, loudly" || ok 0 "helper failure fallback" "(${out})"
[ -e "${WORK}/data/sws/_resume-scrape.json" ] && ok 1 "…marker kept for a retry" || ok 0 "marker kept on helper failure"

grep -q 'SWS_SCRAPE_SKIP_FRESH_SEC="${RESUME_SKIP_FRESH_SEC:-0}"' "${SCRIPT}" \
  && ok 1 "run_shard_with_retry passes the skip to every shard attempt" || ok 0 "shards receive the skip"

# ── the marker must survive the wrapper's reset ────────────────────────────
echo "--- git clean -fd keeps the marker ---"
G="${WORK}/git"
mkdir -p "${G}/data/sws"
cp "${REPO_ROOT}/.gitignore" "${G}/.gitignore"
(
  cd "${G}" && git init -q . && git config user.email t@t && git config user.name t \
    && git add .gitignore && git commit -qm init
) >/dev/null 2>&1
echo '{}' > "${G}/data/sws/_resume-scrape.json"
echo '{}' > "${G}/data/sws/_resume-scrape.consumed.json"
echo 'x' > "${G}/data/sws/not-ignored-control.txt"
git -C "${G}" clean -fd -- . >/dev/null 2>&1
[ ! -e "${G}/data/sws/not-ignored-control.txt" ] && ok 1 "control: git clean -fd ran" || ok 0 "control: git clean -fd ran"
[ -e "${G}/data/sws/_resume-scrape.json" ] && [ -e "${G}/data/sws/_resume-scrape.consumed.json" ] \
  && ok 1 "marker + consumed record survive the reset (gitignored, clean has no -x)" \
  || ok 0 "marker survives git clean -fd" "(add data/sws/_resume-scrape* to .gitignore)"

# ── scraper ────────────────────────────────────────────────────────────────
echo "--- sws-api-scrape.mjs ---"
grep -q 'process.env.SWS_SCRAPE_SKIP_FRESH_SEC' "${SCRAPER}" && ok 1 "scraper reads SWS_SCRAPE_SKIP_FRESH_SEC" || ok 0 "scraper reads the knob"
grep -q 'import { payloadAgeMs } from "./sws-scrape-progress.mjs";' "${SCRAPER}" \
  && ok 1 "…and decides with the shared payloadAgeMs (unit-tested)" || ok 0 "scraper uses payloadAgeMs"
SKIP_AT="$(grep -n 'reason: "fresh_payload"' "${SCRAPER}" | head -1 | cut -d: -f1)"
FETCH_AT="$(grep -n 'await fetchStockData(client' "${SCRAPER}" | head -1 | cut -d: -f1)"
[ -n "${SKIP_AT}" ] && [ -n "${FETCH_AT}" ] && [ "${SKIP_AT}" -lt "${FETCH_AT}" ] \
  && ok 1 "the skip happens before the fetch (no request, no pacing sleep)" || ok 0 "skip before fetch" "(skip=${SKIP_AT:-?} fetch=${FETCH_AT:-?})"
SKIP_BLOCK="$(awk '/if \(skipFreshMs\) \{/{f=1} f{print} f&&/^      \}$/{exit}' "${SCRAPER}")"
printf '%s' "${SKIP_BLOCK}" | grep -q 'fresh_payload' && ok 1 "scraper skip block extracted" || ok 0 "scraper skip block extracted" "(markers moved?)"
[ -n "${SKIP_BLOCK}" ] && printf '%s\n' "${SKIP_BLOCK}" | grep -vE '^[[:space:]]*//' | grep -q 'done_count' \
  && ok 0 "a skip does not count as served (done_count feeds the panic clean_run)" \
  || ok 1 "a skip does not count as served (done_count feeds the panic clean_run)"
grep -q '!explicitTickers && Number.isFinite(skipFreshSec)' "${SCRAPER}" \
  && ok 1 "an explicit --tickers run never skips" || ok 0 "--tickers never skips"

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
