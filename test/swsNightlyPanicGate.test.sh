#!/usr/bin/env bash
#
# Test the panic-gate ordering in scripts/sws-nightly.sh.
#
# WHY THIS EXISTS: from 2026-09-10 to 2026-09-17 the India nightly shipped no data
# at all. A transient Cloudflare 403 on one shard wrote data/sws/panic-stop.flag on
# 2026-09-09; the flag is gitignored and the isolated wrapper cleans with
# `git clean -fd` (no -x), so it survived every worktree reset and every subsequent
# run exited 3 about a second after starting.
#
# The outage stayed invisible for seven days because the "run started" mail was sent
# BEFORE the panic check. The operator received a 🚀 kickoff mail every morning and
# reasonably read it as proof the pipeline was alive. Two mails landed a second
# apart and only the second one meant anything.
#
# The fix moves the panic gate ahead of the started mail: a flagged run is REFUSED,
# not started, so it must never announce a start. The other pre-flight aborts
# (battery / network / git sync) deliberately keep the started->abort pair — those
# runs genuinely began before hitting a condition.
#
# Verifies:
#   1. Panic flag set -> exit 3 and NO "started" mail is sent.
#   2. Panic flag set -> the 🚨 refusal mail IS sent.
#   3. No panic flag -> the "started" mail is still sent (no regression).
#   4. Source ordering: the panic gate appears before the started mail in the file.

set -uo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NIGHTLY="${REPO_ROOT}/scripts/sws-nightly.sh"
WORK="$(mktemp -d "/tmp/sws-panic-gate-test-$$.XXXXXX")"
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ FAIL: $2 ${3:-}"; fi; }

# Build a throwaway repo dir the script will cd into. SWS_NIGHTLY_REPO_DIR is the
# supported override, so the real checkout is never touched. The stub mailer
# records subjects instead of sending; the script only calls it when the file
# exists, so its presence is what makes mail observable at all.
mkdir -p "${WORK}/scripts" "${WORK}/data/sws"
cp "${NIGHTLY}" "${WORK}/scripts/sws-nightly.sh"
cat > "${WORK}/scripts/sws-mail-summary.mjs" <<'EOF'
import fs from "fs";
fs.appendFileSync(process.env.MAIL_LOG, process.argv[2] + "\n");
EOF

run_nightly() {
  MAIL_LOG="$1" SWS_NIGHTLY_REPO_DIR="${WORK}" \
    bash "${WORK}/scripts/sws-nightly.sh" --dry-run >/dev/null 2>&1
  echo $?
}

echo "--- panic flag present ---"
printf '%s\n' '{"reason":"api:blocked","shard_id":3,"evidence":"status=403"}' \
  > "${WORK}/data/sws/panic-stop.flag"
: > "${WORK}/mail-panic.txt"
rc="$(run_nightly "${WORK}/mail-panic.txt")"

[ "${rc}" = "3" ] && ok 1 "flagged run exits 3" || ok 0 "flagged run exits 3" "(got ${rc})"

if grep -q '🚀' "${WORK}/mail-panic.txt"; then
  ok 0 "flagged run sends NO 'started' mail" "(a 🚀 mail was sent — this is the 7-day-outage bug)"
else
  ok 1 "flagged run sends NO 'started' mail"
fi

grep -q '🚨' "${WORK}/mail-panic.txt" \
  && ok 1 "flagged run sends the refusal mail" \
  || ok 0 "flagged run sends the refusal mail"

echo "--- no panic flag ---"
rm -f "${WORK}/data/sws/panic-stop.flag"
: > "${WORK}/mail-clean.txt"
# Exits non-zero further down (the fixture is not a git repo); irrelevant here —
# what matters is that it got PAST the gate and announced the start.
run_nightly "${WORK}/mail-clean.txt" >/dev/null

grep -q '🚀' "${WORK}/mail-clean.txt" \
  && ok 1 "unflagged run still sends the 'started' mail (no regression)" \
  || ok 0 "unflagged run still sends the 'started' mail (no regression)"

echo "--- source ordering ---"
gate_line="$(grep -n '^if \[ -f data/sws/panic-stop.flag \]; then' "${NIGHTLY}" | head -1 | cut -d: -f1)"
mail_line="$(grep -n '^START_SUBJECT=' "${NIGHTLY}" | head -1 | cut -d: -f1)"
if [ -n "${gate_line}" ] && [ -n "${mail_line}" ] && [ "${gate_line}" -lt "${mail_line}" ]; then
  ok 1 "panic gate precedes the started mail in source (gate:${gate_line} < mail:${mail_line})"
else
  ok 0 "panic gate precedes the started mail in source" "(gate:${gate_line:-?} mail:${mail_line:-?})"
fi

echo
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ] || exit 1
