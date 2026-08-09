#!/usr/bin/env bash
#
# Test the AC wait in scripts/sws-nightly-isolated.sh.
#
# WHY THIS EXISTS: the 2026-08-08 nightly ran on battery with the lid shut. The
# host cycled ~20s DarkWake against ~14.5min Deep Idle all night, the script
# body did not start until 12:16 IST, and 2 of 3 scrape shards then died
# because Playwright's launchPersistentContext timeout is wall-clock and
# expired while the process sat frozen. The sanity gate blocked the ship, the
# run held its slot for 24h36m, launchd suppressed the next fire, and
# production served 55h-old data.
#
# caffeinate could not have prevented it: `-s` is AC-only by design, `-u`
# without `-t` is a 5-second assertion, and `-t` is ignored entirely when
# caffeinate invokes a utility — the exact form the plist uses. `pmset -g
# custom` on that host is `sleep 1` on battery. Deferring until the charger is
# back is the only reliable answer that needs no root.
#
# Run with: bash test/swsNightlyAcWait.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="${HERE}/../scripts/sws-nightly-isolated.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }

BLOCK="$(awk '/── AC wait \(extracted verbatim/{f=1} f{print} /── end AC wait/{f=0}' "${WRAPPER}")"
[ -n "${BLOCK}" ] || { echo "FAIL: could not extract the AC wait block from ${WRAPPER}"; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT
mkdir -p "${WORK}/bin"

# Stub pmset. Emits "Battery Power" for the first N calls, then "AC Power",
# mimicking the real first line: "Now drawing from 'AC Power'".
cat > "${WORK}/bin/pmset" <<'STUB'
#!/usr/bin/env bash
COUNT_FILE="${PMSET_COUNT_FILE}"
# An empty count file yields an empty string, not 0 — `cat` succeeds so the
# `||` never fires — and an empty operand makes the -lt below error out into
# the AC branch, silently defeating the whole test.
n=$(cat "${COUNT_FILE}" 2>/dev/null || echo 0)
n="${n:-0}"
echo $((n + 1)) > "${COUNT_FILE}"
if [ "${PMSET_BATTERY_CALLS}" = "always" ] || [ "${n}" -lt "${PMSET_BATTERY_CALLS}" ]; then
  echo "Now drawing from 'Battery Power'"
  echo " -InternalBattery-0 (id=1)	22%; discharging; (no estimate) present: true"
else
  echo "Now drawing from 'AC Power'"
  echo " -InternalBattery-0 (id=1)	22%; AC attached; not charging present: true"
fi
STUB
chmod +x "${WORK}/bin/pmset"

harness() {
  local deadline_delta="$1"
  cat <<EOF
set -uo pipefail
export PATH="${WORK}/bin:\${PATH}"
ts() { date "+%H:%M:%S"; }
send_mail() { echo "[mail] \$1"; }
fail_critical() { echo "[isolated-nightly] \$1"; send_mail "🚨 \$1" "\$2"; exit "\${3:-5}"; }
SWS_NIGHTLY_DEADLINE_SEC=${deadline_delta}
SWS_NIGHTLY_DEADLINE_EPOCH=\$(( \$(date +%s) + ${deadline_delta} ))
EOF
  echo "${BLOCK}"
  echo 'echo "PROCEEDED"'
}

echo ""
echo "sws-nightly-isolated.sh AC wait"
echo ""

# ---------------------------------------------------------------- case 1
# On battery for 3 polls, then the charger comes back → proceed.
harness 300 > "${WORK}/ac1.sh"
: > "${WORK}/count1"
START=$(date +%s)
OUT=$(PMSET_COUNT_FILE="${WORK}/count1" PMSET_BATTERY_CALLS=3 \
      SWS_AC_POLL_SEC=1 \
      bash "${WORK}/ac1.sh" 2>&1)
RC=$?
ELAPSED=$(( $(date +%s) - START ))

if [ "${RC}" -eq 0 ] && printf '%s' "${OUT}" | grep -q "PROCEEDED"; then
  ok "AC returns mid-wait → run proceeds"
else
  bad "AC returns mid-wait → proceeds" "rc=${RC}, out=$(printf '%s' "${OUT}" | tr '\n' ' ')"
fi

if printf '%s' "${OUT}" | grep -q "deferring until AC returns"; then
  ok "announces the deferral"
else
  bad "announces the deferral" "$(printf '%s' "${OUT}" | tr '\n' ' ')"
fi

if printf '%s' "${OUT}" | grep -q "AC restored"; then
  ok "announces recovery"
else
  bad "announces recovery" "missing"
fi

if [ "${ELAPSED}" -ge 2 ] && [ "${ELAPSED}" -lt 30 ]; then
  ok "polls rather than busy-waits (${ELAPSED}s for 3 polls at 1s)"
else
  bad "polls rather than busy-waits" "${ELAPSED}s"
fi

# ---------------------------------------------------------------- case 2
# Never comes back on AC → clean exit 4, not a doomed run.
harness 3 > "${WORK}/ac2.sh"
: > "${WORK}/count2"
OUT2=$(PMSET_COUNT_FILE="${WORK}/count2" PMSET_BATTERY_CALLS=always \
       SWS_AC_POLL_SEC=1 \
       bash "${WORK}/ac2.sh" 2>&1)
RC2=$?

if [ "${RC2}" -eq 4 ]; then
  ok "never gets AC → exits 4 (the documented on-battery skip code)"
else
  bad "never gets AC → exits 4" "rc=${RC2}"
fi

if ! printf '%s' "${OUT2}" | grep -q "PROCEEDED"; then
  ok "never gets AC → does NOT run the body"
else
  bad "never gets AC → does not run the body" "body ran anyway"
fi

if printf '%s' "${OUT2}" | grep -q "never got AC"; then
  ok "mails the give-up reason"
else
  bad "mails the give-up reason" "$(printf '%s' "${OUT2}" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- case 3
# Already on AC → no wait at all, no deferral message.
harness 300 > "${WORK}/ac3.sh"
: > "${WORK}/count3"
START3=$(date +%s)
OUT3=$(PMSET_COUNT_FILE="${WORK}/count3" PMSET_BATTERY_CALLS=0 \
       SWS_AC_POLL_SEC=1 \
       bash "${WORK}/ac3.sh" 2>&1)
ELAPSED3=$(( $(date +%s) - START3 ))

if printf '%s' "${OUT3}" | grep -q "PROCEEDED" && ! printf '%s' "${OUT3}" | grep -q "deferring"; then
  ok "already on AC → proceeds immediately, no deferral"
else
  bad "already on AC → proceeds immediately" "$(printf '%s' "${OUT3}" | tr '\n' ' ')"
fi

if [ "${ELAPSED3}" -lt 3 ]; then
  ok "already on AC → costs no wall clock (${ELAPSED3}s)"
else
  bad "already on AC → costs no wall clock" "${ELAPSED3}s"
fi

# ---------------------------------------------------------------- case 4
# The opt-out still works, so an operator can force a battery run. Note this is
# SWS_NIGHTLY_AC_WAIT, not SWS_NIGHTLY_SKIP_BATTERY — see the wrapper for why
# the two policies are deliberately separate.
harness 300 > "${WORK}/ac4.sh"
: > "${WORK}/count4"
OUT4=$(PMSET_COUNT_FILE="${WORK}/count4" PMSET_BATTERY_CALLS=always \
       SWS_NIGHTLY_AC_WAIT=0 SWS_AC_POLL_SEC=1 \
       bash "${WORK}/ac4.sh" 2>&1)

if printf '%s' "${OUT4}" | grep -q "PROCEEDED"; then
  ok "SWS_NIGHTLY_AC_WAIT=0 bypasses the wait entirely"
else
  bad "SWS_NIGHTLY_AC_WAIT=0 bypasses the wait" "$(printf '%s' "${OUT4}" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- case 5
# Static: the AC probe must read only line 1. Line 2 of `pmset -g batt` reads
# "... AC attached; not charging" even while the machine is on battery, so a
# head -2 would match "AC Power"-less text and false-positive.
if grep -q 'pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power"' "${WRAPPER}"; then
  ok "AC probe reads line 1 only (line 2 says 'AC attached' on battery)"
else
  bad "AC probe reads line 1 only" "probe shape changed — recheck the head -1 rationale"
fi

# The deadline anchor must be set before the wait, otherwise a 5h wait plus a
# full-length run overruns the next slot exactly as the incident did.
ANCHOR_LINE=$(grep -n 'SWS_NIGHTLY_DEADLINE_EPOCH=\$((' "${WRAPPER}" | head -1 | cut -d: -f1)
WAIT_LINE=$(grep -n '── AC wait' "${WRAPPER}" | head -1 | cut -d: -f1)
if [ -n "${ANCHOR_LINE}" ] && [ -n "${WAIT_LINE}" ] && [ "${ANCHOR_LINE}" -lt "${WAIT_LINE}" ]; then
  ok "deadline is anchored before the AC wait, so waiting spends the same budget"
else
  bad "deadline anchored before the AC wait" "anchor=${ANCHOR_LINE:-none} wait=${WAIT_LINE:-none}"
fi

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
