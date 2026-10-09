#!/usr/bin/env bash
#
# Test the panic handling inside scripts/sws-refresh-api.sh.
#
# WHY THIS EXISTS: on 2026-09-30 one 403 on shard 2 wrote data/sws/panic-stop.flag.
# The flag had no expiry, so it refused every nightly from 10-01 to 10-09.
# scripts/sws-panic-policy.mjs now bounds it; this file pins how refresh-api uses
# that policy, by extracting the real blocks from the script (no copies):
#
#   1. Step 1 (run-start gate): an expired flag is archived and the run goes on;
#      an active one exits 3.
#   2. run_shard_with_retry does NOT retry rc 3/4 (panic). On 09-30 the shard
#      retried rc 4 → 3 → 3: 60s of sleeps that could only hit the flag again.
#      Other non-zero codes keep their 2 retries.
#   3. `clean_run` — the only event that resets the escalation streak — is
#      recorded on measured coverage (done_count delta ≥ 50% of the universe),
#      never on shard exit codes: a shard exits 0 after a night of 503s.

set -uo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/sws-refresh-api.sh"
WORK="$(mktemp -d "/tmp/sws-refresh-api-panic-$$.XXXXXX")"
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ FAIL: $2 ${3:-}"; fi; }

mkdir -p "${WORK}/scripts" "${WORK}/data/sws"
cp "${REPO_ROOT}/scripts/sws-panic-policy.mjs" "${WORK}/scripts/"

# Extract a block between two literal marker lines (start inclusive, end exclusive).
extract() {
  awk -v a="$1" -v b="$2" 'index($0, a) == 1 {f=1} index($0, b) == 1 {f=0} f' "${SCRIPT}"
}

write_flag() {  # write_flag <detected_offset_sec> <expires_offset_sec>
  node -e '
    const [det, exp] = process.argv.slice(1).map(Number);
    const now = Date.now();
    process.stdout.write(JSON.stringify({ schema: 2, reason: "api:blocked", shard_id: 2, evidence: "status=403",
      detected_at: new Date(now + det * 1000).toISOString(), expires_at: new Date(now + exp * 1000).toISOString() }));
  ' -- "$@" > "${WORK}/data/sws/panic-stop.flag"
}

# ── 1. step-1 run-start gate ────────────────────────────────────────────────
STEP1="$(extract '# ---------- 1. Pre-flight: panic flag ----------' '# ---------- 2. Pipeline lock ----------')"
if [ -z "${STEP1}" ]; then
  ok 0 "step-1 block extracted" "(markers moved?)"
else
  ok 1 "step-1 block extracted"
fi
run_step1() {
  ( cd "${WORK}" && SWS_MAIL_FN() { echo "MAIL: $1"; }; eval "${STEP1}"; echo "PASSED_GATE" ) 2>&1
}

echo "--- step 1: expired flag ---"
write_flag -36000 -3600
out="$(run_step1)"
echo "${out}" | grep -q 'PASSED_GATE' && [ ! -e "${WORK}/data/sws/panic-stop.flag" ] \
  && ok 1 "expired flag → archived, run proceeds" \
  || ok 0 "expired flag → archived, run proceeds" "(${out})"
ls "${WORK}/data/sws/panic-archive/"panic-stop.*.json >/dev/null 2>&1 \
  && ok 1 "…archived copy kept" || ok 0 "…archived copy kept"

echo "--- step 1: active flag ---"
write_flag -600 20000
out="$(run_step1)"; rc=$?
echo "${out}" | grep -q 'PASSED_GATE' \
  && ok 0 "active flag → refused" "(${out})" \
  || ok 1 "active flag → refused"
echo "${out}" | grep -q 'MAIL: 🚨 SWS refresh aborted' \
  && ok 1 "…with the abort mail" || ok 0 "…with the abort mail" "(${out})"
[ -e "${WORK}/data/sws/panic-stop.flag" ] && ok 1 "…flag left in place" || ok 0 "…flag left in place"
rm -f "${WORK}/data/sws/panic-stop.flag"

echo "--- step 1: no flag ---"
out="$(run_step1)"
echo "${out}" | grep -q 'PASSED_GATE' && ok 1 "no flag → proceeds" || ok 0 "no flag → proceeds" "(${out})"

# ── 2. shard retry loop ─────────────────────────────────────────────────────
RETRY_FN="$(awk '/^  run_shard_with_retry\(\) \{/{f=1} f{print} f&&/^  \}$/{exit}' "${SCRIPT}")"
[ -n "${RETRY_FN}" ] && ok 1 "run_shard_with_retry extracted" || ok 0 "run_shard_with_retry extracted"

# Stub scraper: counts attempts and exits with STUB_RC.
cat > "${WORK}/scripts/sws-api-scrape.mjs" <<'EOF'
import fs from "fs";
fs.appendFileSync(process.env.ATTEMPTS, "x\n");
process.exit(Number(process.env.STUB_RC));
EOF

attempts_for_rc() {
  local want_rc="$1"
  : > "${WORK}/attempts"
  ( cd "${WORK}" && eval "${RETRY_FN}"
    SHARD_MAX_RETRIES=2 SHARD_RETRY_SLEEP_SEC=0 ATTEMPTS="${WORK}/attempts" STUB_RC="${want_rc}" \
      run_shard_with_retry 2
    echo "rc=$?" > "${WORK}/rc" )
  echo "$(wc -l < "${WORK}/attempts" | tr -d ' ') $(sed 's/rc=//' "${WORK}/rc")"
}

echo "--- retry loop ---"
set -- $(attempts_for_rc 4); [ "$1" = "1" ] && [ "$2" = "4" ] \
  && ok 1 "rc 4 (this shard tripped) → 1 attempt, returns 4" || ok 0 "rc 4 → 1 attempt, returns 4" "(attempts=$1 rc=$2)"
set -- $(attempts_for_rc 3); [ "$1" = "1" ] && [ "$2" = "3" ] \
  && ok 1 "rc 3 (flag already set) → 1 attempt, returns 3" || ok 0 "rc 3 → 1 attempt, returns 3" "(attempts=$1 rc=$2)"
set -- $(attempts_for_rc 2); [ "$1" = "3" ] && [ "$2" = "2" ] \
  && ok 1 "rc 2 (crash) still gets its 2 retries" || ok 0 "rc 2 still gets its 2 retries" "(attempts=$1 rc=$2)"
set -- $(attempts_for_rc 0); [ "$1" = "1" ] && [ "$2" = "0" ] \
  && ok 1 "rc 0 → 1 attempt" || ok 0 "rc 0 → 1 attempt" "(attempts=$1 rc=$2)"

# ── 3. clean-run record ─────────────────────────────────────────────────────
CLEAN="$(extract '# No panic and SWS demonstrably served this run' '# ---------- 5b.')"
[ -n "${CLEAN}" ] && ok 1 "clean-run block extracted" || ok 0 "clean-run block extracted"
rm -f "${WORK}/data/sws/panic-history.ndjson" "${WORK}/data/sws/panic-stop.flag"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(Array.from({length: 10}, (_, i) => ({ticker: "T" + i}))))' \
  "${WORK}/data/sws/universe.json"
progress() { printf '{"shard_id":1,"done_count":%s}\n' "$1" > "${WORK}/data/sws/progress-api-1.json"; }
run_clean() { ( cd "${WORK}" && SCRAPE_SKIPPED=false FAIL="$1" ELAPSED=10 PANIC_SERVED_BEFORE="$2" && eval "${CLEAN}" ) >/dev/null 2>&1; }
has_clean() { grep -q '"event":"clean_run"' "${WORK}/data/sws/panic-history.ndjson" 2>/dev/null; }

echo "--- clean-run record ---"
progress 100
run_clean 0 100
has_clean && ok 0 "all shards exit 0 but 0 stocks served → NOT clean" || ok 1 "all shards exit 0 but 0 stocks served → NOT clean"
progress 104
run_clean 0 100
has_clean && ok 0 "4/10 served → NOT clean" || ok 1 "4/10 served → NOT clean"
progress 106
run_clean 0 ""
has_clean && ok 0 "no served-count snapshot → NOT clean (never over-count)" || ok 1 "no served-count snapshot → NOT clean (never over-count)"
run_clean 1 100
has_clean && ok 1 "6/10 served with one shard failed → clean_run" || ok 0 "6/10 served with one shard failed → clean_run"

echo
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ] || exit 1
