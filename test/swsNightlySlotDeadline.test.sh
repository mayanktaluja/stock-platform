#!/usr/bin/env bash
#
# Test the slot-anchored deadline + overrun re-exec in scripts/sws-nightly-isolated.sh.
#
# WHY THIS EXISTS: the deadline was "wrapper start + 21h", which is 21:30 only
# when launchd fires on time. It does not: launchd fires a missed calendar slot
# on the next wake, DarkWakes included — 2026-09-26 started 00:42 (abort 21:42),
# 09-27 at 01:55, 09-30 at 00:40. A start after 03:30 puts the abort past the
# NEXT 00:30, and launchd DROPS a calendar event that comes due while the job is
# alive (09-06's run was still up at 09-07 00:30; nothing ran that day). So the
# deadline is now min(start + 21h, S − 3h), S = the first 00:30 leaving ≥ 9h.
#
# Why 3h and not "00:00": over 14 nights the host was asleep at 00:30 on 5, and
# on 4 of them was awake ≤ 13s between 00:00 and 00:30 — too little to tick,
# TERM, KILL, drain and mail before launchd fires on the first wake and finds the
# old instance still alive. 3h keeps today's on-time abort (21:30); whatever
# still overruns a slot is caught by the re-exec: a deadline abort that ends
# after a slot passed starts the dropped run itself.
#
# Run with: bash test/swsNightlySlotDeadline.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="${HERE}/../scripts/sws-nightly-isolated.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }

SLOT_BLOCK="$(awk '/── slot-anchored deadline \(extracted verbatim/{f=1} f{print} /── end slot-anchored deadline/{f=0}' "${WRAPPER}")"
REEXEC_BLOCK="$(awk '/── overrun re-exec \(extracted verbatim/{f=1} f{print} /── end overrun re-exec/{f=0}' "${WRAPPER}")"
[ -n "${SLOT_BLOCK}" ] || { echo "FAIL: could not extract the slot-anchored deadline from ${WRAPPER}"; exit 1; }
[ -n "${REEXEC_BLOCK}" ] || { echo "FAIL: could not extract the overrun re-exec from ${WRAPPER}"; exit 1; }

WORK="$(mktemp -d "/tmp/sws-slot-deadline-$$.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

# epoch <ISO with offset>
epoch() { node -e 'console.log(Math.floor(Date.parse(process.argv[1]) / 1000))' "$1"; }
iso_ist() { node -e 'console.log(new Date((Number(process.argv[1]) + 19800) * 1000).toISOString().slice(0, 16).replace("T", " "))' "$1"; }

slot_case() {  # slot_case <TZ> <start ISO> → prints "DEADLINE=<epoch> NEXT=<epoch>"
  local tz="$1" start
  start="$(epoch "$2")"
  {
    echo 'set -uo pipefail'
    echo 'SWS_NIGHTLY_DEADLINE_SEC=75600'
    echo "SWS_NIGHTLY_START_EPOCH=${start}"
    echo 'SWS_NIGHTLY_DEADLINE_EPOCH=$(( SWS_NIGHTLY_START_EPOCH + SWS_NIGHTLY_DEADLINE_SEC ))'
    echo "${SLOT_BLOCK}"
    echo 'echo "DEADLINE=${SWS_NIGHTLY_DEADLINE_EPOCH} NEXT=${SWS_NIGHTLY_NEXT_SLOT_EPOCH}"'
  } > "${WORK}/slot.sh"
  TZ="${tz}" PATH="${SLOT_PATH:-${PATH}}" bash "${WORK}/slot.sh" 2>&1 | tail -1
}

expect_slot() {  # expect_slot <label> <TZ> <start ISO> <deadline ISO> <next-slot ISO>
  local got want_d want_n
  got="$(slot_case "$2" "$3")"
  want_d="$(epoch "$4")"; want_n="$(epoch "$5")"
  if [ "${got}" = "DEADLINE=${want_d} NEXT=${want_n}" ]; then
    ok "$1"
  else
    bad "$1" "got '${got}' (deadline $(iso_ist "${got#DEADLINE=}" 2>/dev/null) IST), want DEADLINE=${want_d} NEXT=${want_n}"
  fi
}

echo ""
echo "sws-nightly-isolated.sh slot-anchored deadline"
echo ""

echo "--- IST ---"
expect_slot "on-time 00:30 fire → 21:30 (unchanged)" \
  Asia/Kolkata 2026-10-09T00:30:04+05:30 2026-10-09T21:30:00+05:30 2026-10-10T00:30:00+05:30
expect_slot "09-26 late fire at 00:42 → 21:30, not 21:42" \
  Asia/Kolkata 2026-09-26T00:42:08+05:30 2026-09-26T21:30:00+05:30 2026-09-27T00:30:00+05:30
expect_slot "09-27 DarkWake fire at 01:55 → 21:30, not 22:55" \
  Asia/Kolkata 2026-09-27T01:55:01+05:30 2026-09-27T21:30:00+05:30 2026-09-28T00:30:00+05:30
expect_slot "fire at 07:00 after a long hibernate → 21:30, not 04:00 the next day (past the slot)" \
  Asia/Kolkata 2026-10-09T07:00:00+05:30 2026-10-09T21:30:00+05:30 2026-10-10T00:30:00+05:30
expect_slot "start 12:30 → 21:30 (the 9h minimum budget)" \
  Asia/Kolkata 2026-10-09T12:30:00+05:30 2026-10-09T21:30:00+05:30 2026-10-10T00:30:00+05:30
expect_slot "manual 13:00 → start + 21h (would get < 9h before 21:30)" \
  Asia/Kolkata 2026-10-09T13:00:00+05:30 2026-10-10T10:00:00+05:30 2026-10-10T00:30:00+05:30
expect_slot "manual 17:09 → start + 21h" \
  Asia/Kolkata 2026-10-09T17:09:00+05:30 2026-10-10T14:09:00+05:30 2026-10-10T00:30:00+05:30
expect_slot "manual 00:29:30 → the 00:30 thirty seconds later is the slot it will block" \
  Asia/Kolkata 2026-10-09T00:29:30+05:30 2026-10-09T21:29:30+05:30 2026-10-09T00:30:00+05:30

echo "--- other offsets (date +%z arithmetic, no BSD-only date flags) ---"
expect_slot "UTC−3 (negative offset) → 21:30 local" \
  Etc/GMT+3 2026-10-09T00:30:04-03:00 2026-10-09T21:30:00-03:00 2026-10-10T00:30:00-03:00
expect_slot "UTC → 21:30 local" \
  UTC 2026-10-09T00:30:04Z 2026-10-09T21:30:00Z 2026-10-10T00:30:00Z

# An unreadable %z must fall back to the old start + 21h, never to "no deadline".
mkdir -p "${WORK}/badbin"
REAL_DATE="$(command -v date)"
cat > "${WORK}/badbin/date" <<SHIM
#!/usr/bin/env bash
[ "\$#" -eq 1 ] && [ "\$1" = "+%z" ] && { echo "garbage"; exit 0; }
exec "${REAL_DATE}" "\$@"
SHIM
chmod +x "${WORK}/badbin/date"
START="$(epoch 2026-10-09T07:00:00+05:30)"
GOT="$(SLOT_PATH="${WORK}/badbin:${PATH}" slot_case Asia/Kolkata 2026-10-09T07:00:00+05:30)"
if [ "${GOT}" = "DEADLINE=$(( START + 75600 )) NEXT=" ]; then
  ok "unreadable date +%z → start + 21h, no slot (fail-safe, not unbounded)"
else
  bad "unreadable %z fallback" "${GOT}"
fi

# ─────────────────────────────────────────────── overrun re-exec
echo "--- overrun re-exec ---"
mkdir -p "${WORK}/primary/scripts"
cat > "${WORK}/primary/scripts/sws-nightly-isolated.sh" <<'STUB'
#!/usr/bin/env bash
echo "FRESH RUN reexeced=${SWS_NIGHTLY_REEXECED:-unset} slot_reexec=${SWS_NIGHTLY_SLOT_REEXEC:-unset} lock_present=$([ -d "${TEST_LOCK_DIR}" ] && echo yes || echo no)"
exit 0
STUB

# The decision (sws_slot_overrun, defined in the slot block) …
overrun_case() {  # overrun_case <next_slot_offset_sec> <run_age_sec> [extra env...] → YES|NO
  local next_off="$1" age="$2"; shift 2
  {
    echo 'set -uo pipefail'
    echo 'SWS_NIGHTLY_DEADLINE_SEC=75600'
    echo 'SWS_NIGHTLY_START_EPOCH=$(date +%s)'
    echo 'SWS_NIGHTLY_DEADLINE_EPOCH=$(( SWS_NIGHTLY_START_EPOCH + SWS_NIGHTLY_DEADLINE_SEC ))'
    echo "${SLOT_BLOCK}"
    echo "SWS_NIGHTLY_NEXT_SLOT_EPOCH=\$(( \$(date +%s) + ${next_off} ))"
    echo "SWS_NIGHTLY_START_EPOCH=\$(( \$(date +%s) - ${age} ))"
    echo 'sws_slot_overrun && echo YES || echo NO'
  } > "${WORK}/overrun.sh"
  env "$@" bash "${WORK}/overrun.sh" 2>&1 | tail -1
}
[ "$(overrun_case -600 7200)" = "YES" ] && ok "slot passed while a 2h-old run was alive → overrun" || bad "overrun detected" "$(overrun_case -600 7200)"
[ "$(overrun_case 600 7200)" = "NO" ] && ok "slot still ahead (the normal 21:30 abort) → no overrun" || bad "slot ahead → no overrun" "$(overrun_case 600 7200)"
[ "$(overrun_case -600 600)" = "NO" ] && ok "a run younger than 1h never counts (no tight loop)" || bad "young run" "$(overrun_case -600 600)"
[ "$(overrun_case -600 7200 SWS_NIGHTLY_SLOT_REEXEC=0)" = "NO" ] && ok "SWS_NIGHTLY_SLOT_REEXEC=0 turns it off" || bad "opt-out" "x"
{
  echo 'set -uo pipefail'
  echo 'SWS_NIGHTLY_DEADLINE_SEC=75600; SWS_NIGHTLY_START_EPOCH=$(( $(date +%s) - 7200 ))'
  echo 'SWS_NIGHTLY_DEADLINE_EPOCH=$(( SWS_NIGHTLY_START_EPOCH + SWS_NIGHTLY_DEADLINE_SEC ))'
  echo "${SLOT_BLOCK}"
  echo 'SWS_NIGHTLY_NEXT_SLOT_EPOCH=""'
  echo 'sws_slot_overrun && echo YES || echo NO'
} > "${WORK}/overrun-noslot.sh"
[ "$(bash "${WORK}/overrun-noslot.sh" 2>&1 | tail -1)" = "NO" ] \
  && ok "unknown slot (unreadable %z leaves NEXT empty) → never an overrun" || bad "unknown slot" "$(bash "${WORK}/overrun-noslot.sh" 2>&1 | tail -2)"

# … and the exec it gates.
reexec_case() {  # reexec_case <SLOT_REEXEC 0|1> [OVERRUN_NOW=1] [GROUP_ALIVE=1]
  mkdir -p "${WORK}/lock"
  {
    echo 'set -uo pipefail'
    echo "PRIMARY_REPO='${WORK}/primary'"
    echo "LOCK_DIR='${WORK}/lock'"
    echo 'ts() { date "+%H:%M:%S"; }'
    echo 'SWS_NIGHTLY_NEXT_SLOT_EPOCH=$(( $(date +%s) - 600 ))'
    echo 'sws_slot_overrun() { [ "${OVERRUN_NOW:-0}" = "1" ]; }'
    echo 'sws_group_alive() { [ "${GROUP_ALIVE:-0}" = "1" ]; }'
    echo "SLOT_REEXEC=$1"
    echo 'trap '\''echo EXIT_TRAP_RAN'\'' EXIT'
    echo "${REEXEC_BLOCK}"
    echo 'echo "NO REEXEC"; exit 10'
  } > "${WORK}/reexec.sh"
  shift
  env "$@" TEST_LOCK_DIR="${WORK}/lock" SWS_NIGHTLY_REEXECED=1 bash "${WORK}/reexec.sh" 2>&1
}

OUT="$(reexec_case 1)"
if printf '%s' "${OUT}" | grep -q '^FRESH RUN'; then
  ok "overrun → execs a fresh wrapper run in place of the dropped fire"
else
  bad "overrun → fresh run" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
fi
printf '%s' "${OUT}" | grep -q 'lock_present=no' \
  && ok "…with the lock released first (exec skips the EXIT trap)" || bad "lock released before exec" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
printf '%s' "${OUT}" | grep -q 'reexeced=unset' \
  && ok "…and SWS_NIGHTLY_REEXECED cleared, so it re-runs the self-heal from origin/main" || bad "self-heal guard cleared" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
printf '%s' "${OUT}" | grep -q 'launchd dropped that fire' \
  && ok "…and says why" || bad "re-exec logs its reason" "$(printf '%s' "${OUT}" | tr '\n' ' ')"

OUT="$(reexec_case 0)"
printf '%s' "${OUT}" | grep -q 'NO REEXEC' && printf '%s' "${OUT}" | grep -q 'EXIT_TRAP_RAN' \
  && ok "no overrun → plain exit 10, lock released by the EXIT trap as before" || bad "no re-exec" "$(printf '%s' "${OUT}" | tr '\n' ' ')"

# The abort mail can itself carry the teardown past the slot (it is bounded on
# wall clock, but a sleeping host's wall clock runs fast): ask again after it.
OUT="$(reexec_case 0 OVERRUN_NOW=1)"
printf '%s' "${OUT}" | grep -q '^FRESH RUN' \
  && ok "slot passed DURING the abort mail → still re-execs (decision re-asked after the mail)" || bad "post-mail re-check" "$(printf '%s' "${OUT}" | tr '\n' ' ')"

# Never on top of live writers: the fresh run starts with git reset --hard + clean.
OUT="$(reexec_case 0 OVERRUN_NOW=1 GROUP_ALIVE=1)"
printf '%s' "${OUT}" | grep -q 'NO REEXEC' && printf '%s' "${OUT}" | grep -q 'process group is still alive' \
  && ok "slot passed but this run's process group is still alive → no re-exec, says why" || bad "group alive → no re-exec" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
grep -q 'sws_slot_overrun && ! sws_group_alive && SLOT_REEXEC=1' "${WRAPPER}" \
  && ok "…and the pre-mail decision checks the group too" || bad "pre-mail group check" "missing"

# ─────────────────────────────────────────────── static
echo "--- static ---"
SLOT_LINE=$(grep -n '── slot-anchored deadline' "${WRAPPER}" | head -1 | cut -d: -f1)
WAIT_LINE=$(grep -n '── AC wait' "${WRAPPER}" | head -1 | cut -d: -f1)
[ -n "${SLOT_LINE}" ] && [ -n "${WAIT_LINE}" ] && [ "${SLOT_LINE}" -lt "${WAIT_LINE}" ] \
  && ok "slot anchor is computed before the AC wait (the wait spends the same budget)" \
  || bad "slot anchor before AC wait" "slot=${SLOT_LINE:-?} wait=${WAIT_LINE:-?}"
if grep -q 'SWS_NIGHTLY_SLOT_MARGIN_SEC="${SWS_NIGHTLY_SLOT_MARGIN_SEC:-10800}"' "${WRAPPER}"; then
  ok "margin defaults to 3h, not 30 min (see header: asleep 00:00-00:30 on 4/14 nights)"
else
  bad "3h margin default" "changed — re-read the header before shrinking it"
fi
REEXEC_LINE=$(grep -n '── overrun re-exec (extracted' "${WRAPPER}" | head -1 | cut -d: -f1)
MARKER_LINE=$(grep -n 'mark-abort' "${WRAPPER}" | grep -v '^\s*#' | head -1 | cut -d: -f1)
[ -n "${REEXEC_LINE}" ] && [ -n "${MARKER_LINE}" ] && [ "${MARKER_LINE}" -lt "${REEXEC_LINE}" ] \
  && ok "the resume marker is written before any re-exec, so the fresh run reuses this one's fetches" \
  || bad "marker before re-exec" "marker=${MARKER_LINE:-?} reexec=${REEXEC_LINE:-?}"

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
