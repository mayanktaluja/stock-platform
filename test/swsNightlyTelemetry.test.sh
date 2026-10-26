#!/usr/bin/env bash
#
# Test the watchdog telemetry + lock-skip mail in scripts/sws-nightly-isolated.sh.
#
# WHY THIS EXISTS: the 2026-09-26 and 09-29 nightlies were killed by the 21h
# deadline and looked hung. They were asleep: the AC wait cleared, then the Mac
# was unplugged and the lid shut, and it slept on battery mid-scrape (every
# pmset sleep since 10-02 was on battery). Nothing reported it — no mail when
# AC went away, an abort mail with no progress and no hint of suspend, and the
# deadline itself fired 2-7 min late. Separately, a lock skip (which, for the
# 00:30 launchd fire, consumes that day's slot) left one log line and no mail.
#
# Two Darwin facts shape the code under test:
#   - `sleep N` counts AWAKE time only, while `date +%s` jumps across a suspend.
#     So (tick wall-gap − tick) is the suspended time — and any wait written as
#     "N × sleep" is N awake seconds, which on a sleeping laptop can be hours.
#   - launchd DROPS a calendar event that comes due while the job is alive.
#
# A `date` shim adds an offset (from a file) to `date +%s` only, so the test can
# make the wall clock jump the way a suspend does, without suspending anything.
#
# Run with: bash test/swsNightlyTelemetry.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
WRAPPER="${REPO_ROOT}/scripts/sws-nightly-isolated.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }

SUPERVISOR="$(awk '/── deadline supervisor \(extracted verbatim/{f=1} f{print} /── end deadline supervisor/{f=0}' "${WRAPPER}")"
LOCK_BLOCK="$(awk '/── single-instance lock \(extracted verbatim/{f=1} f{print} /── end single-instance lock/{f=0}' "${WRAPPER}")"
ON_AC_FN="$(grep '^sws_on_ac() ' "${WRAPPER}" | head -1)"
[ -n "${SUPERVISOR}" ] || { echo "FAIL: could not extract the deadline supervisor from ${WRAPPER}"; exit 1; }
[ -n "${LOCK_BLOCK}" ] || { echo "FAIL: could not extract the single-instance lock from ${WRAPPER}"; exit 1; }
[ -n "${ON_AC_FN}" ] || { echo "FAIL: could not extract sws_on_ac from ${WRAPPER}"; exit 1; }

WORK="$(mktemp -d "/tmp/sws-nightly-telemetry-$$.XXXXXX")"
cleanup() {
  [ -n "${HOLDER_PID:-}" ] && kill "${HOLDER_PID}" 2>/dev/null
  for f in "${WORK}"/*.gcpid; do [ -f "${f}" ] && kill -KILL "$(cat "${f}")" 2>/dev/null; done
  rm -rf "${WORK}"
}
trap cleanup EXIT

mkdir -p "${WORK}/bin" "${WORK}/wt/scripts" "${WORK}/wt/data/sws"
cp "${REPO_ROOT}/scripts/sws-scrape-progress.mjs" "${REPO_ROOT}/scripts/sws-shard-partition.mjs" \
   "${REPO_ROOT}/scripts/sws-config.mjs" "${WORK}/wt/scripts/"

# 9-stock universe → 3 per shard; cursors 1/2/3 so the summary is checkable.
node -e '
  const fs = require("fs"), dir = process.argv[1];
  fs.writeFileSync(dir + "/universe.json", JSON.stringify(["AAA","BBB","CCC","DDD","EEE","FFF","GGG","HHH","III"].map((t) => ({ ticker: t }))));
  for (const sid of [1, 2, 3]) fs.writeFileSync(`${dir}/progress-api-${sid}.json`, JSON.stringify({
    shard_id: sid, next_local_index: sid, done_count: 100, last_ticker: "X" + sid, last_run_at: new Date().toISOString() }));
' "${WORK}/wt/data/sws"

DATE_OFFSET_FILE="${WORK}/date-offset"
echo 0 > "${DATE_OFFSET_FILE}"
REAL_DATE="$(command -v date)"
cat > "${WORK}/bin/date" <<SHIM
#!/usr/bin/env bash
# Only the epoch read jumps; every other format passes through untouched.
if [ "\$#" -eq 1 ] && [ "\$1" = "+%s" ]; then
  off="\$(cat "${DATE_OFFSET_FILE}" 2>/dev/null || echo 0)"
  echo \$(( \$("${REAL_DATE}" +%s) + \${off:-0} ))
else
  exec "${REAL_DATE}" "\$@"
fi
SHIM
chmod +x "${WORK}/bin/date"

PMSET_MODE_FILE="${WORK}/pmset-mode"
# SUSPEND_IN_PMSET_FILE present: the next pmset call "sleeps" 1080s — the host
# suspends while the watchdog is in its own work, not in its `sleep`.
SUSPEND_IN_PMSET_FILE="${WORK}/suspend-in-pmset"
cat > "${WORK}/bin/pmset" <<STUB
#!/usr/bin/env bash
if [ -f "${SUSPEND_IN_PMSET_FILE}" ]; then
  rm -f "${SUSPEND_IN_PMSET_FILE}"
  echo \$(( \$(cat "${DATE_OFFSET_FILE}") + 1080 )) > "${DATE_OFFSET_FILE}"
fi
if [ "\$(cat "${PMSET_MODE_FILE}" 2>/dev/null)" = "battery" ]; then
  echo "Now drawing from 'Battery Power'"
  echo " -InternalBattery-0 (id=1)	41%; discharging; 3:10 remaining present: true"
else
  echo "Now drawing from 'AC Power'"
  echo " -InternalBattery-0 (id=1)	41%; AC attached; not charging present: true"
fi
STUB
chmod +x "${WORK}/bin/pmset"

MAIL_LOG="${WORK}/mail.log"

# Common prelude: stubs + the real sws_on_ac, then the extracted block.
prelude() {
  cat <<EOF
set -uo pipefail
export PATH="${WORK}/bin:\${PATH}"
WORKTREE_DIR="${WORK}/wt"
BASE_BRANCH="test"
ts() { date "+%H:%M:%S"; }
send_mail() {
  # HANG_MAIL=<subject substring>: that mail never returns, like a Resend call
  # on a sleeping host. fds closed so an abandoned one cannot hold the test pipe.
  if [ -n "\${HANG_MAIL:-}" ] && case "\$1" in *"\${HANG_MAIL}"*) true ;; *) false ;; esac; then
    sleep 600 >/dev/null 2>&1 </dev/null & echo "\$!" >> "${WORK}/hung-mail.pids"; wait
  fi
  printf 'SUBJECT: %s\n%s\n---\n' "\$1" "\$2" >> "${MAIL_LOG}"; echo "[mail] \$1"
}
${ON_AC_FN}
EOF
}

supervisor_harness() {  # supervisor_harness <lock_dir>
  prelude
  cat <<EOF
LOCK_DIR="$1"
mkdir -p "\${LOCK_DIR}"
SWS_NIGHTLY_DEADLINE_SEC="\$1"
SWS_NIGHTLY_START_EPOCH=\$(date +%s)
SWS_NIGHTLY_DEADLINE_EPOCH=\$(( \$(date +%s) + \$1 ))
shift
EOF
  echo "${SUPERVISOR}"
}

lock_harness() {  # lock_harness <lock_dir>
  prelude
  echo "LOCK_DIR_OVERRIDE='$1'"
  echo 'SWS_NIGHTLY_LOCK_DIR="${LOCK_DIR_OVERRIDE}"'
  echo "${LOCK_BLOCK}"
  echo 'echo "ACQUIRED pid=$(cat "${LOCK_DIR}/pid")"'
}

write_body() { cat > "${WORK}/wt/scripts/sws-nightly.sh"; }
reset_state() { echo 0 > "${DATE_OFFSET_FILE}"; echo ac > "${PMSET_MODE_FILE}"; : > "${MAIL_LOG}"; rm -f "${SUSPEND_IN_PMSET_FILE}"; }

echo ""
echo "sws-nightly-isolated.sh watchdog telemetry + lock-skip mail"
echo ""

# ─────────────────────────────────────────────── lock skip
echo "--- single-instance lock ---"
reset_state
sleep 300 &
HOLDER_PID=$!
mkdir -p "${WORK}/lock-held"; echo "${HOLDER_PID}" > "${WORK}/lock-held/pid"
lock_harness "${WORK}/lock-held" > "${WORK}/lock1.sh"
OUT="$(bash "${WORK}/lock1.sh" 2>&1)"; RC=$?
if [ "${RC}" -eq 0 ] && ! printf '%s' "${OUT}" | grep -q ACQUIRED; then
  ok "live holder → skip with exit 0 (unchanged)"
else
  bad "live holder → skip with exit 0" "rc=${RC} $(printf '%s' "${OUT}" | tr '\n' ' ')"
fi
if grep -q '^SUBJECT: ⏭️ SWS nightly — skipped, another run holds the lock' "${MAIL_LOG}" \
   && grep -q "holder pid ${HOLDER_PID}" "${MAIL_LOG}"; then
  ok "…and the skip is mailed, naming the holder (a skipped 00:30 fire is a lost slot)"
else
  bad "…and the skip is mailed" "$(cat "${MAIL_LOG}" | tr '\n' ' ')"
fi
kill "${HOLDER_PID}" 2>/dev/null; wait "${HOLDER_PID}" 2>/dev/null; HOLDER_PID=""

reset_state
mkdir -p "${WORK}/lock-stale"; echo 999999 > "${WORK}/lock-stale/pid"
lock_harness "${WORK}/lock-stale" > "${WORK}/lock2.sh"
OUT="$(bash "${WORK}/lock2.sh" 2>&1)"
if printf '%s' "${OUT}" | grep -q ACQUIRED && [ ! -s "${MAIL_LOG}" ]; then
  ok "stale holder → reclaimed silently, no skip mail"
else
  bad "stale holder → reclaimed silently" "$(printf '%s' "${OUT}" | tr '\n' ' ') mail=$(cat "${MAIL_LOG}" | head -1)"
fi

reset_state
lock_harness "${WORK}/lock-free" > "${WORK}/lock3.sh"
OUT="$(bash "${WORK}/lock3.sh" 2>&1)"
if printf '%s' "${OUT}" | grep -q ACQUIRED && [ ! -s "${MAIL_LOG}" ]; then
  ok "free lock → acquired, no mail"
else
  bad "free lock → acquired, no mail" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
fi

# ─────────────────────────────────────────────── suspend + AC loss, normal exit
echo "--- suspend detection + AC loss (run finishes normally) ---"
reset_state
write_body <<BODY
#!/usr/bin/env bash
sleep 3
echo 600 > "${DATE_OFFSET_FILE}"        # a 10-minute suspend, as the watchdog sees it
sleep 3
echo battery > "${PMSET_MODE_FILE}"     # charger pulled mid-run
sleep 4
exit 0
BODY
supervisor_harness "${WORK}/lock-s1" > "${WORK}/s1.sh"
OUT="$(SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/s1.sh" 3600 2>&1)"; RC=$?
[ "${RC}" -eq 0 ] && ok "body rc passes through (0)" || bad "body rc passes through" "rc=${RC}"
if printf '%s' "${OUT}" | grep -q 'host was suspended ~10m'; then
  ok "a wall-clock jump across one tick is logged as ~10m suspended"
else
  bad "suspend logged" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
fi
if printf '%s' "${OUT}" | grep -q 'host suspended ~0.2h of this run'; then
  ok "end-of-run line totals the suspended time (600s → 0.2h)"
else
  bad "end-of-run suspended total" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
fi
AC_MAILS="$(grep -c '^SUBJECT: ⚠️ SWS nightly — AC lost mid-run' "${MAIL_LOG}")"
if [ "${AC_MAILS}" = "1" ]; then
  ok "AC loss is mailed exactly once across several battery ticks"
else
  bad "AC loss mailed once" "got ${AC_MAILS}"
fi
if grep -q 'shard 2: next_local_index 2/3' "${MAIL_LOG}"; then
  ok "…with per-shard cursor/slice progress"
else
  bad "AC-loss mail has shard progress" "$(cat "${MAIL_LOG}" | tr '\n' ' ')"
fi
if ! grep -q 'deadline exceeded' "${MAIL_LOG}"; then
  ok "no abort mail on a run that finished inside the deadline"
else
  bad "no abort mail on a normal run" "abort mail sent"
fi
if ! grep -q 'starting on battery' "${MAIL_LOG}"; then
  ok "a run launched on AC sends no battery-start mail"
else
  bad "no battery-start mail on AC" "sent anyway"
fi

# The 2026-10-25 undercount: 0.7h reported vs pmset's 2.5h. A suspend that began
# while the watchdog was in its pmset call landed between the tick's two clock
# reads and vanished — 7 of that night's 10 Deep Idle sleeps (1.7h). One read
# per tick, chained, puts it in the next gap.
reset_state
write_body <<BODY
#!/usr/bin/env bash
sleep 3
: > "${SUSPEND_IN_PMSET_FILE}"
sleep 4
exit 0
BODY
supervisor_harness "${WORK}/lock-s4" > "${WORK}/s4.sh"
OUT="$(SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/s4.sh" 3600 2>&1)"
if [ ! -e "${SUSPEND_IN_PMSET_FILE}" ] && printf '%s' "${OUT}" | grep -q 'host was suspended ~18m' \
   && printf '%s' "${OUT}" | grep -q 'host suspended ~0.3h of this run'; then
  ok "a suspend that begins during the tick's pmset call is still counted (1080s → ~18m, 0.3h)"
else
  bad "suspend during pmset counted" "$(printf '%s' "${OUT}" | grep -i suspended | tr '\n' ' ')"
fi

# A start on battery is the DEFAULT since #1645 (owner, 2026-10-09: start at the
# slot whatever the power state). It gets one heads-up mail, and is not itself
# an "AC loss".
reset_state
echo battery > "${PMSET_MODE_FILE}"
write_body <<'BODY'
#!/usr/bin/env bash
sleep 3
exit 0
BODY
supervisor_harness "${WORK}/lock-s2" > "${WORK}/s2.sh"
SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/s2.sh" 3600 >/dev/null 2>&1
if [ "$(grep -c '^SUBJECT: 🔋 SWS nightly — starting on battery (41%)' "${MAIL_LOG}")" = "1" ]; then
  ok "a start on battery is mailed once, with the charge"
else
  bad "battery-start mail once" "$(grep '^SUBJECT' "${MAIL_LOG}" | tr '\n' ' ')"
fi
if ! grep -q 'AC lost' "${MAIL_LOG}"; then
  ok "…and is not reported as 'AC lost'"
else
  bad "launched on battery → no AC-lost mail" "mailed anyway"
fi

# Battery start → plugged in → unplugged again: THAT is an AC loss, once, and
# never while it is actually on AC.
reset_state
echo battery > "${PMSET_MODE_FILE}"
write_body <<BODY
#!/usr/bin/env bash
sleep 3
echo ac > "${PMSET_MODE_FILE}"
sleep 3
grep -c 'AC lost' "${MAIL_LOG}" > "${WORK}/s3-while-on-ac"
echo battery > "${PMSET_MODE_FILE}"
sleep 4
exit 0
BODY
supervisor_harness "${WORK}/lock-s3" > "${WORK}/s3.sh"
SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/s3.sh" 3600 >/dev/null 2>&1
if [ "$(cat "${WORK}/s3-while-on-ac" 2>/dev/null)" = "0" ] \
   && [ "$(grep -c '^SUBJECT: ⚠️ SWS nightly — AC lost mid-run' "${MAIL_LOG}")" = "1" ]; then
  ok "plugged in after a battery start, then unplugged → 'AC lost' once, not while on AC"
else
  bad "battery → AC → battery" "while_on_ac=$(cat "${WORK}/s3-while-on-ac" 2>/dev/null) mails=$(grep -c 'AC lost' "${MAIL_LOG}")"
fi

# ─────────────────────────────────────────────── abort mail content
echo "--- deadline abort after a long suspend ---"
reset_state
write_body <<BODY
#!/usr/bin/env bash
sleep 2
echo 5400 > "${DATE_OFFSET_FILE}"       # asleep 90 min, straight past the deadline
sleep 600
BODY
supervisor_harness "${WORK}/lock-a1" > "${WORK}/a1.sh"
START=$(date +%s)
OUT="$(SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/a1.sh" 6 2>&1)"; RC=$?
ELAPSED=$(( $(date +%s) - START ))
[ "${RC}" -eq 10 ] && ok "deadline abort still exits 10" || bad "deadline abort exits 10" "rc=${RC} $(printf '%s' "${OUT}" | tail -3 | tr '\n' ' ')"
[ "${ELAPSED}" -lt 30 ] && ok "abort is prompt after the jump (${ELAPSED}s)" || bad "abort is prompt" "${ELAPSED}s"
if printf '%s' "${OUT}" | grep -qE 'DEADLINE reached .*\(89m after it was due\)'; then
  ok "logs how late the deadline fired"
else
  bad "logs deadline lateness" "$(printf '%s' "${OUT}" | grep DEADLINE)"
fi
ABORT_MAIL="$(awk '/^SUBJECT: 🚨 SWS nightly — run deadline exceeded/{f=1} f{print} /^---$/{f=0}' "${MAIL_LOG}")"
if printf '%s' "${ABORT_MAIL}" | grep -q 'Host suspended: ~1.5h'; then
  ok "abort mail reports suspended hours"
else
  bad "abort mail reports suspended hours" "$(printf '%s' "${ABORT_MAIL}" | tr '\n' ' ')"
fi
if printf '%s' "${ABORT_MAIL}" | grep -q 'Most of this run was spent asleep'; then
  ok "abort mail says 'asleep, not stuck' when suspend dominates"
else
  bad "abort mail asleep hint" "$(printf '%s' "${ABORT_MAIL}" | tr '\n' ' ')"
fi
if printf '%s' "${ABORT_MAIL}" | grep -q 'shard 1: next_local_index 1/3 (33%)' \
   && printf '%s' "${ABORT_MAIL}" | grep -q 'shard 3: next_local_index 3/3 (100%) · slice finished'; then
  ok "abort mail lists per-shard next_local_index/slice"
else
  bad "abort mail lists shard progress" "$(printf '%s' "${ABORT_MAIL}" | tr '\n' ' ')"
fi

# Resume marker: written on the deadline abort, gitignored, read by the next
# refresh-api step 3 (test/swsResumeAfterAbort.test.sh covers that side).
MARKER="${WORK}/wt/data/sws/_resume-scrape.json"
if node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(m.carry===1&&m.aborted_at&&m.run_started_at?0:1)' "${MARKER}" 2>/dev/null; then
  ok "deadline abort writes data/sws/_resume-scrape.json (carry 1, aborted_at, run_started_at)"
else
  bad "deadline abort writes the resume marker" "$(cat "${MARKER}" 2>&1)"
fi
if printf '%s' "${ABORT_MAIL}" | grep -q 'Next run: resume marker written (carry 1)'; then
  ok "…and the abort mail says what the next run will reuse"
else
  bad "abort mail mentions the resume marker" "$(printf '%s' "${ABORT_MAIL}" | grep -i 'next run' || echo missing)"
fi
rm -f "${WORK}/wt/data/sws/_resume-scrape"*

# A hanging abort mail must not hold the lock past its wall-clock bound (it
# used to be inline and unbounded: on a sleeping host that can be past 00:30).
reset_state
write_body <<'BODY'
#!/usr/bin/env bash
sleep 600
BODY
supervisor_harness "${WORK}/lock-m1" > "${WORK}/m1.sh"
START=$(date +%s)
OUT="$(HANG_MAIL="deadline exceeded" SWS_ABORT_MAIL_MAX_SEC=3 SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/m1.sh" 2 2>&1)"; RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ "${RC}" -eq 10 ] && [ "${ELAPSED}" -lt 30 ] && printf '%s' "${OUT}" | grep -q 'mail still pending after 3s'; then
  ok "a hung abort mail is abandoned at its bound (${ELAPSED}s) and the abort still exits 10"
else
  bad "bounded abort mail" "rc=${RC} ${ELAPSED}s $(printf '%s' "${OUT}" | tail -3 | tr '\n' ' ')"
fi
for p in $(cat "${WORK}/hung-mail.pids" 2>/dev/null); do kill "${p}" 2>/dev/null; done
rm -f "${WORK}/hung-mail.pids" "${WORK}/wt/data/sws/_resume-scrape"*

# The watchdog's own mails are async: a hung AC-loss mail must not stop the
# watchdog from enforcing the deadline.
reset_state
write_body <<BODY
#!/usr/bin/env bash
sleep 2
echo battery > "${PMSET_MODE_FILE}"
sleep 600
BODY
supervisor_harness "${WORK}/lock-m2" > "${WORK}/m2.sh"
START=$(date +%s)
OUT="$(HANG_MAIL="AC lost" SWS_WATCHDOG_TICK_SEC=1 bash "${WORK}/m2.sh" 6 2>&1)"; RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ "${RC}" -eq 10 ] && [ "${ELAPSED}" -lt 40 ] && printf '%s' "${OUT}" | grep -q 'DEADLINE reached'; then
  ok "a hung AC-loss mail does not stall the watchdog — the deadline still fires (${ELAPSED}s)"
else
  bad "async watchdog mail" "rc=${RC} ${ELAPSED}s $(printf '%s' "${OUT}" | tail -3 | tr '\n' ' ')"
fi
for p in $(cat "${WORK}/hung-mail.pids" 2>/dev/null); do kill "${p}" 2>/dev/null; done
rm -f "${WORK}/hung-mail.pids" "${WORK}/wt/data/sws/_resume-scrape"*

# ─────────────────────────────────────────────── KILL escalation completes
# The body dies on TERM, its grandchild does not. The main process used to kill
# the watchdog as soon as the body exited — mid-grace, before the KILL — so the
# grandchild survived and the lock was released on top of it.
echo "--- KILL escalation is not cut short ---"
reset_state
write_body <<BODY
#!/usr/bin/env bash
# fds closed: if it survives (the bug), the test must FAIL, not hang on the
# command substitution's pipe.
( trap '' TERM; while :; do sleep 1; done ) >/dev/null 2>&1 </dev/null &
echo \$! > "${WORK}/k1.gcpid"
sleep 600
BODY
supervisor_harness "${WORK}/lock-k1" > "${WORK}/k1.sh"
OUT="$(SWS_WATCHDOG_TICK_SEC=1 SWS_DEADLINE_TERM_GRACE_SEC=3 bash "${WORK}/k1.sh" 2 2>&1)"
GC="$(cat "${WORK}/k1.gcpid" 2>/dev/null || echo "")"
if [ -n "${GC}" ] && ! kill -0 "${GC}" 2>/dev/null; then
  ok "a TERM-proof grandchild is KILLed before the wrapper returns"
else
  bad "TERM-proof grandchild is KILLed" "pid ${GC:-?} alive; $(printf '%s' "${OUT}" | tail -4 | tr '\n' ' ')"
fi
printf '%s' "${OUT}" | grep -q 'escalating to KILL' \
  && ok "…via the watchdog's escalation" || bad "…via the watchdog's escalation" "no KILL line"

# Grace is wall-clock: a suspend during the grace must not stretch it. With a
# 600s grace the KILL lands as soon as the clock says the grace is over.
echo "--- TERM grace is measured on the wall clock ---"
reset_state
write_body <<BODY
#!/usr/bin/env bash
( trap '' TERM; i=0; while :; do sleep 1; i=\$((i + 1)); [ "\$i" -eq 5 ] && echo 99999 > "${DATE_OFFSET_FILE}"; done ) >/dev/null 2>&1 </dev/null &
echo \$! > "${WORK}/k2.gcpid"
sleep 600
BODY
supervisor_harness "${WORK}/lock-k2" > "${WORK}/k2.sh"
START=$(date +%s)
OUT="$(SWS_WATCHDOG_TICK_SEC=1 SWS_DEADLINE_TERM_GRACE_SEC=600 bash "${WORK}/k2.sh" 2 2>&1)"
ELAPSED=$(( $(date +%s) - START ))
GC="$(cat "${WORK}/k2.gcpid" 2>/dev/null || echo "")"
if [ "${ELAPSED}" -lt 60 ] && [ -n "${GC}" ] && ! kill -0 "${GC}" 2>/dev/null; then
  ok "a clock jump past the grace triggers KILL at once (${ELAPSED}s, not 600 awake seconds)"
else
  bad "wall-clock grace" "${ELAPSED}s, gc=${GC:-?} $(kill -0 "${GC:-0}" 2>/dev/null && echo alive)"
fi

# ─────────────────────────────────────────────── static
echo "--- static ---"
if ! printf '%s' "${SUPERVISOR}" | grep -vE '^[[:space:]]*#' | grep -q 'seq 1'; then
  ok "no count-of-sleeps loops left in the supervisor (awake-only sleep)"
else
  bad "no count-of-sleeps loops" "$(printf '%s' "${SUPERVISOR}" | grep -n 'seq 1')"
fi
if printf '%s' "${SUPERVISOR}" | grep -q 'SWS_WATCHDOG_TICK_SEC="${SWS_WATCHDOG_TICK_SEC:-5}"'; then
  ok "watchdog ticks every 5s by default (fits inside one ~5s battery DarkWake)"
else
  bad "watchdog default tick" "changed — recheck the DarkWake rationale"
fi

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
