#!/usr/bin/env bash
#
# Test the deadline supervisor in scripts/sws-nightly-isolated.sh.
#
# WHY THIS EXISTS: the 2026-08-08 nightly ran for 24h36m — it slept most of the
# night on battery, lost 2 of 3 shards, was blocked by the sanity gate, and did
# not exit until 01:07 the next morning. It was therefore still alive when the
# 2026-08-09 00:30 slot arrived, and launchd treats a calendar event that fires
# while the service is running as consumed rather than queued. That day never
# ran at all. One bad night cost two days of stale production data.
#
# The supervisor bounds the run. The subtle part is not the timeout, it is the
# KILL: a plain `kill -TERM "${body_pid}"` reaches only the body, whose children
# (sws-refresh-api.sh, the three shard subshells, node, Chrome) survive and
# reparent to init — and then the wrapper releases its single-instance lock on
# top of live writers, so the next run's `git reset --hard` lands underneath
# them. That is the 2026-07-24 collision, recreated. Hence `set -m` plus a
# process-group signal, plus a drain before the lock is released.
#
# Run with: bash test/swsNightlyDeadline.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="${HERE}/../scripts/sws-nightly-isolated.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }

BLOCK="$(awk '/── deadline supervisor \(extracted verbatim/{f=1} f{print} /── end deadline supervisor/{f=0}' "${WRAPPER}")"
[ -n "${BLOCK}" ] || { echo "FAIL: could not extract the deadline block from ${WRAPPER}"; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

mkdir -p "${WORK}/wt/scripts" "${WORK}/lock"

# A stand-in nightly that spawns a long-lived grandchild and then blocks. The
# grandchild is the whole point: it is what survives a naive single-PID TERM.
cat > "${WORK}/wt/scripts/sws-nightly.sh" <<'BODY'
#!/usr/bin/env bash
sleep 600 &
echo "$!" > "${GRANDCHILD_PIDFILE}"
sleep 600
BODY

harness() {
  cat <<EOF
set -uo pipefail
WORKTREE_DIR="${WORK}/wt"
BASE_BRANCH="test"
LOCK_DIR="${WORK}/lock"
GRANDCHILD_PIDFILE="${WORK}/grandchild.pid"
export GRANDCHILD_PIDFILE
ts() { date "+%H:%M:%S"; }
send_mail() { echo "[mail] \$1"; }
SWS_NIGHTLY_DEADLINE_SEC="\$1"
SWS_NIGHTLY_DEADLINE_EPOCH=\$(( \$(date +%s) + \$1 ))
shift
EOF
  echo "${BLOCK}"
}

echo ""
echo "sws-nightly-isolated.sh deadline supervisor"
echo ""

# ---------------------------------------------------------------- case 1
# Deadline expires while the body is still running.
harness > "${WORK}/deadline.sh"
rm -f "${WORK}/grandchild.pid"
START=$(date +%s)
bash "${WORK}/deadline.sh" 3 > "${WORK}/out1.txt" 2>&1
RC=$?
ELAPSED=$(( $(date +%s) - START ))

if [ "${RC}" -eq 10 ]; then
  ok "deadline abort exits 10 (distinct from the body's 143 on SIGTERM)"
else
  bad "deadline abort exits 10" "rc=${RC}, output: $(tail -3 "${WORK}/out1.txt" | tr '\n' ' ')"
fi

if [ "${ELAPSED}" -lt 90 ]; then
  ok "aborts promptly once the deadline passes (${ELAPSED}s)"
else
  bad "aborts promptly" "took ${ELAPSED}s"
fi

if grep -q "DEADLINE reached" "${WORK}/out1.txt"; then
  ok "logs the abort reason"
else
  bad "logs the abort reason" "$(tail -3 "${WORK}/out1.txt" | tr '\n' ' ')"
fi

if grep -q "next 00:30 slot is not suppressed" "${WORK}/out1.txt"; then
  ok "names slot suppression as the reason the bound exists"
else
  bad "names slot suppression" "missing"
fi

# The regression that matters: the grandchild must be dead. A single-PID TERM
# leaves it alive and reparented to init.
GC="$(cat "${WORK}/grandchild.pid" 2>/dev/null || echo "")"
if [ -z "${GC}" ]; then
  bad "grandchild pid captured" "pidfile empty — body never started?"
elif kill -0 "${GC}" 2>/dev/null; then
  bad "process-group kill reaps the grandchild" "pid ${GC} still alive (orphaned)"
  kill -KILL "${GC}" 2>/dev/null || true
else
  ok "process-group kill reaps the grandchild (no orphan holding the worktree)"
fi

if grep -q "run deadline exceeded" "${WORK}/out1.txt"; then
  ok "mails on deadline abort"
else
  bad "mails on deadline abort" "$(tail -3 "${WORK}/out1.txt" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- case 2
# Body finishes well inside the deadline: rc passes through, no abort, and the
# watchdog subshell must not linger or fire.
cat > "${WORK}/wt/scripts/sws-nightly.sh" <<'BODY'
#!/usr/bin/env bash
sleep 1 &
echo "$!" > "${GRANDCHILD_PIDFILE}"
exit 6
BODY

harness > "${WORK}/deadline2.sh"
rm -f "${WORK}/lock/deadline-fired" "${WORK}/grandchild.pid"
bash "${WORK}/deadline2.sh" 3600 > "${WORK}/out2.txt" 2>&1
RC2=$?

if [ "${RC2}" -eq 6 ]; then
  ok "body exit code passes through untouched when inside the deadline"
else
  bad "body exit code passes through" "rc=${RC2}"
fi

if [ ! -f "${WORK}/lock/deadline-fired" ]; then
  ok "no deadline flag written on a normal run"
else
  bad "no deadline flag on a normal run" "flag present"
fi

if ! grep -q "DEADLINE reached" "${WORK}/out2.txt"; then
  ok "watchdog stays silent on a normal run"
else
  bad "watchdog stays silent" "$(tail -3 "${WORK}/out2.txt" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- case 3
# Static guarantees the runtime cases cannot observe.
if grep -q 'set -m' "${WRAPPER}"; then
  ok "wrapper enables job control so the body leads its own process group"
else
  bad "wrapper enables job control" "no 'set -m' — kill -TERM -PID cannot work"
fi

if grep -q 'kill -TERM -"\${body_pid}"' "${WRAPPER}"; then
  ok "signals the process GROUP (negative pid), not just the body"
else
  bad "signals the process group" "no negative-pid TERM found"
fi

# The blast radius must be the process group and nothing wider. A pattern sweep
# cannot tell this run's scrape from the US/KR/TW forks (same script name,
# relative invocation) or from a playwright run using the same Chrome build, so
# an escalation path built on pgrep/pkill would SIGKILL unrelated work. This
# very test caught that: an earlier draft swept `pgrep -f sws-api-scrape.mjs`
# and matched the live production scrape running on the same machine.
# Comment lines are stripped first — the rationale above deliberately names
# pgrep/pkill to explain why they are absent from the executable path.
CODE_ONLY="$(grep -vE '^[[:space:]]*#' "${WRAPPER}")"
if ! printf '%s' "${CODE_ONLY}" | grep -qE 'pgrep|pkill'; then
  ok "no pgrep/pkill in executable code — blast radius is the process group only"
else
  bad "no pgrep/pkill in executable code" "$(printf '%s' "${CODE_ONLY}" | grep -nE 'pgrep|pkill' | head -3 | tr '\n' ' ')"
fi

if grep -q 'kill -0 -"\${body_pid}"' "${WRAPPER}"; then
  ok "liveness probed via the process group, not a name match"
else
  bad "liveness probed via process group" "no 'kill -0 -PGID' probe found"
fi

if grep -q 'kill -KILL -"\${body_pid}"' "${WRAPPER}"; then
  ok "escalation targets the process group"
else
  bad "escalation targets the process group" "no group KILL found"
fi

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
