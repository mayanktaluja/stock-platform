#!/usr/bin/env bash
#
# Test the host-aware shard retry in scripts/sws-refresh-api.sh and the suspend
# clock + host gate it uses (scripts/sws-suspend-clock.sh).
#
# WHY THIS EXISTS: on 2026-10-24 and 10-25 a battery nightly was launched into
# closed-lid DarkWakes (2-7s awake every ~15 min). Shards 1+2 (10-24) and shard
# 2 (10-25) "exited non-zero after all retries" having scraped 0 stocks, so
# 10-25 shipped nothing (66% fresh vs the 85% floor): shard 2 was already dead
# when the lid opened at 03:47. The likely cause is the 2026-08-08 signature, a
# wall-clock timeout expiring while the process sits frozen, and the 30s `sleep`
# between attempts counts AWAKE seconds, so all three attempts burn inside a
# few DarkWakes. Nobody could check: the next run truncated the shard logs.
#
# Owner policy (2026-10-27): never scrape with the lid closed on battery. AC
# (lid open or closed) and lid-open-on-battery are the supported setups.
#
# Pinned here, on the REAL blocks extracted from the scripts:
#   1. no attempt starts while the lid is closed on battery; the shard waits and
#      resumes once the lid opens or AC returns;
#   2. an attempt the host was suspended during does not spend the retry budget
#      (WALL-clock pause, then the gate), up to SHARD_MAX_SUSPENDED_RETRIES;
#      panic codes and rc 7 are unchanged;
#   3. each failure logs wall time + suspended time, on stdout too, and a final
#      failure tails the shard log into the main log;
#   4. the previous run's shard log is rotated to .prev.log, not truncated;
#   5. the clock itself: chained reads, plus a suspend still in progress at stop.
#
# A `date` shim adds an offset (from a file) to `date +%s` only, so the test can
# make the wall clock jump the way a suspend does, without suspending anything.
# pmset/ioreg stubs read the power source and lid state from files.
#
# Run with: bash test/swsShardSuspendRetry.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/sws-refresh-api.sh"
CLOCK_LIB="${REPO_ROOT}/scripts/sws-suspend-clock.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }

BLOCK="$(awk '/── shard retry \(extracted verbatim/{f=1} f{print} /── end shard retry/{f=0}' "${SCRIPT}")"
[ -n "${BLOCK}" ] || { echo "FAIL: could not extract the shard retry block from ${SCRIPT}"; exit 1; }
grep -q '^\. "${SCRIPT_DIR}/sws-suspend-clock.sh"' "${SCRIPT}" \
  || { echo "FAIL: ${SCRIPT} does not source sws-suspend-clock.sh"; exit 1; }
# shellcheck source=scripts/sws-with-timeout.sh
. "${REPO_ROOT}/scripts/sws-with-timeout.sh"

WORK="$(mktemp -d "/tmp/sws-shard-suspend-retry-$$.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin" "${WORK}/repo/scripts" "${WORK}/repo/data/sws"

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
jump() { echo $(( $(cat "${DATE_OFFSET_FILE}") + $1 )) > "${DATE_OFFSET_FILE}"; }

# Power source: ac | battery | unknown (pmset fails). Lid: open | closed | unknown.
POWER_FILE="${WORK}/power"
LID_FILE="${WORK}/lid"
cat > "${WORK}/bin/pmset" <<STUB
#!/usr/bin/env bash
case "\$(cat "${POWER_FILE}" 2>/dev/null)" in
  ac)      echo "Now drawing from 'AC Power'" ;;
  battery) echo "Now drawing from 'Battery Power'" ;;
  *)       exit 1 ;;
esac
STUB
cat > "${WORK}/bin/ioreg" <<STUB
#!/usr/bin/env bash
case "\$(cat "${LID_FILE}" 2>/dev/null)" in
  closed) echo '  |   "AppleClamshellState" = Yes' ;;
  open)   echo '  |   "AppleClamshellState" = No' ;;
esac
STUB
chmod +x "${WORK}/bin/pmset" "${WORK}/bin/ioreg"
host() { echo "$1" > "${POWER_FILE}"; echo "$2" > "${LID_FILE}"; }

# Stub scraper. One plan line per attempt, "<suspend_sec> <rc> [close]" (the
# last line repeats): the wall clock jumps by suspend_sec mid-attempt, the way
# a process frozen by a suspend sees it on wake; "close" also shuts the lid.
cat > "${WORK}/repo/scripts/sws-api-scrape.mjs" <<'EOF'
import fs from "fs";
const plan = fs.readFileSync(process.env.PLAN, "utf8").trim().split("\n");
const n = fs.readFileSync(process.env.ATTEMPTS, "utf8").split("\n").filter(Boolean).length;
fs.appendFileSync(process.env.ATTEMPTS, `resume=${process.env.SWS_RESUME}\n`);
const [susp, rc, lid] = plan[Math.min(n, plan.length - 1)].split(/\s+/);
console.log(`[stub] attempt ${n + 1}: suspended ${susp}s, exit ${rc}`);
if (Number(susp) > 0) {
  const off = Number(fs.readFileSync(process.env.DATE_OFFSET_FILE, "utf8")) || 0;
  fs.writeFileSync(process.env.DATE_OFFSET_FILE, String(off + Number(susp)));
}
if (lid === "close") fs.writeFileSync(process.env.LID_FILE, "closed\n");
setTimeout(() => process.exit(Number(rc)), Number(process.env.STUB_MS || 300));
EOF

# run_retry <plan line>... — runs the extracted block for shard 2 under a 120s
# cap (a regression to an awake-seconds `sleep` must fail, not hang). Knobs
# (SHARD_*) come from the caller's environment; host state from host() first.
# Leaves RC / OUT / ATTEMPTS.
run_retry() {
  printf '%s\n' "$@" > "${WORK}/plan"
  : > "${WORK}/attempts"
  echo 0 > "${DATE_OFFSET_FILE}"
  {
    echo 'set -uo pipefail'
    echo "export PATH=\"${WORK}/bin:\${PATH}\""
    echo "export PLAN=\"${WORK}/plan\" ATTEMPTS=\"${WORK}/attempts\" DATE_OFFSET_FILE=\"${DATE_OFFSET_FILE}\" LID_FILE=\"${LID_FILE}\""
    echo "cd \"${WORK}/repo\""
    echo 'ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }'
    echo 'SWS_SUSPEND_TICK_SEC=1'
    echo 'SHARD_HOST_POLL_SEC="${SHARD_HOST_POLL_SEC:-1}"'
    echo ". \"${CLOCK_LIB}\""
    echo "${BLOCK}"
    echo 'run_shard_with_retry 2'
  } > "${WORK}/retry.sh"
  with_timeout 120 bash "${WORK}/retry.sh" > "${WORK}/out" 2>&1
  RC=$?
  ATTEMPTS="$(wc -l < "${WORK}/attempts" | tr -d ' ')"
  OUT="$(cat "${WORK}/out")"
}
shard_log() { cat "${WORK}/repo/data/sws/refresh-api-shard-2.log" 2>/dev/null; }
attempts_now() { wc -l < "${WORK}/attempts" | tr -d ' '; }

echo ""
echo "sws-refresh-api.sh host-aware shard retry"
echo ""

# ─────────────────────────────────────────────── the clock
echo "--- suspend clock ---"
clock() {  # clock <script body> → prints SWS_SUSPENDED_SEC
  ( export PATH="${WORK}/bin:${PATH}"; SWS_SUSPEND_TICK_SEC=1; . "${CLOCK_LIB}"
    eval "$1"; echo "${SWS_SUSPENDED_SEC}" )
}
echo 0 > "${DATE_OFFSET_FILE}"
S="$(clock 'sws_suspend_clock_start "${WORK}/c1"; sleep 2; sws_suspend_clock_stop "${WORK}/c1"')"
[ "${S}" = "0" ] && ok "awake run → 0s suspended" || bad "awake run → 0" "got ${S}"

echo 0 > "${DATE_OFFSET_FILE}"
S="$(clock 'sws_suspend_clock_start "${WORK}/c2"; sleep 1; jump 600; sleep 3; sws_suspend_clock_stop "${WORK}/c2"')"
[ "${S}" -ge 594 ] && [ "${S}" -le 601 ] && ok "a 600s jump seen by the ticker → ~600s (${S})" || bad "ticker-seen jump" "got ${S}"

# The command ends in the same wake the clock jumped in, before the next tick.
echo 0 > "${DATE_OFFSET_FILE}"
S="$(clock 'sws_suspend_clock_start "${WORK}/c3"; sleep 1.2; jump 900; sws_suspend_clock_stop "${WORK}/c3"')"
[ "${S}" -ge 894 ] && [ "${S}" -le 901 ] && ok "a jump still pending at stop is counted (${S})" || bad "pending jump at stop" "got ${S}"

echo 0 > "${DATE_OFFSET_FILE}"
S="$(clock 'sws_suspend_clock_start "${WORK}/c4"; sleep 1.5; jump 1; sleep 2; sws_suspend_clock_stop "${WORK}/c4"')"
[ "${S}" = "0" ] && ok "jitter inside 3 ticks is not a suspend" || bad "jitter ignored" "got ${S}"
[ ! -e "${WORK}/c1" ] && [ ! -e "${WORK}/c3" ] && ok "state files are removed at stop" || bad "state files removed" "$(ls "${WORK}")"

# ─────────────────────────────────────────────── the host gate
echo "--- host gate: AC, or lid open ---"
gate() { ( export PATH="${WORK}/bin:${PATH}"; . "${CLOCK_LIB}"; sws_host_can_scrape && echo yes || echo no ); }
host battery closed; [ "$(gate)" = "no" ]  && ok "battery + lid closed → may not scrape" || bad "battery+closed" "$(gate)"
host battery open;   [ "$(gate)" = "yes" ] && ok "battery + lid open → may scrape" || bad "battery+open" "$(gate)"
host ac closed;      [ "$(gate)" = "yes" ] && ok "AC + lid closed → may scrape" || bad "ac+closed" "$(gate)"
host unknown unknown; [ "$(gate)" = "yes" ] && ok "pmset/ioreg unreadable → may scrape (fail open)" || bad "unknown host" "$(gate)"

echo "--- 10-25 replay: launched with the lid closed on battery ---"
# Launched 01:14 lid closed on battery; lid opened 03:47 (~2.5h, ~9000s).
host battery closed
( sleep 3; attempts_now > "${WORK}/attempts-while-closed"; jump 9000; echo open > "${LID_FILE}" ) &
SHARD_RETRY_SLEEP_SEC=0 run_retry "0 0"
wait
if [ "$(cat "${WORK}/attempts-while-closed")" = "0" ] && [ "${RC}" -eq 0 ] && [ "${ATTEMPTS}" = "1" ]; then
  ok "no attempt while the lid is closed; one attempt once it opens → rc 0 (was rc 1 after 3)"
else
  bad "lid-closed launch" "while_closed=$(cat "${WORK}/attempts-while-closed") rc=${RC} attempts=${ATTEMPTS}"
fi
printf '%s' "${OUT}" | grep -q 'shard 2 waiting at .*: lid closed on battery' \
  && printf '%s' "${OUT}" | grep -qE 'shard 2 resuming at .* after 900[0-9]s wall clock \(lid open\)' \
  && ok "…the wait and the resume are logged on stdout, with the wall time waited" \
  || bad "wait/resume logged" "$(printf '%s' "${OUT}" | head -3 | tr '\n' ' ')"
[ "$(shard_log | grep -n 'waiting at' | cut -d: -f1)" -lt "$(shard_log | grep -n 'attempt 1 (SWS_RESUME=0)' | cut -d: -f1)" ] \
  && ok "…and in the shard log, before attempt 1" || bad "wait precedes attempt in shard log" "$(shard_log | head -4 | tr '\n' ' ')"

host ac closed
SHARD_RETRY_SLEEP_SEC=0 run_retry "0 0"
[ "${RC}" -eq 0 ] && [ "${ATTEMPTS}" = "1" ] && ! printf '%s' "${OUT}" | grep -q 'waiting at' \
  && ok "lid closed on AC → scrapes without waiting" || bad "AC + lid closed" "rc=${RC} $(printf '%s' "${OUT}" | head -2 | tr '\n' ' ')"

echo "--- lid shut mid-attempt ---"
host battery open
( sleep 3; attempts_now > "${WORK}/attempts-while-closed"; echo open > "${LID_FILE}" ) &
SHARD_RETRY_SLEEP_SEC=0 run_retry "900 1 close" "0 0"
wait
if [ "$(cat "${WORK}/attempts-while-closed")" = "1" ] && [ "${RC}" -eq 0 ] && [ "${ATTEMPTS}" = "2" ]; then
  ok "suspended failure → no retry while shut, retried once the lid opens → rc 0"
else
  bad "lid shut mid-attempt" "while_closed=$(cat "${WORK}/attempts-while-closed") rc=${RC} attempts=${ATTEMPTS}"
fi
printf '%s' "${OUT}" | grep -q 'not counted against its 2 retries (suspend-affected 1/48)' \
  && ok "…and the suspended attempt is not counted" || bad "forgiven line" "$(printf '%s' "${OUT}" | grep -i suspended | head -2 | tr '\n' ' ')"
SUSP="$(printf '%s' "${OUT}" | sed -n 's/.*exited rc=1 at [0-9TZ:-]* after [0-9]*s wall clock, host suspended ~\([0-9]*\)s of it.*/\1/p' | head -1)"
[ -n "${SUSP}" ] && [ "${SUSP}" -ge 899 ] \
  && ok "failure line carries timestamp, wall time and suspended time (~${SUSP}s)" \
  || bad "failure evidence line" "$(printf '%s' "${OUT}" | grep 'exited rc=' | head -1)"

# ─────────────────────────────────────────────── retry budget
echo "--- suspend-affected attempts don't spend the budget ---"
host battery open
SHARD_RETRY_SLEEP_SEC=0 run_retry "900 1" "900 1" "900 1" "900 1" "900 1" "0 0"
[ "${RC}" -eq 0 ] && [ "${ATTEMPTS}" = "6" ] \
  && ok "5 suspend-affected failures, then success → rc 0 after 6 attempts" \
  || bad "forgiven run" "rc=${RC} attempts=${ATTEMPTS} $(printf '%s' "${OUT}" | tail -3 | tr '\n' ' ')"
[ "$(sed -n 1p "${WORK}/attempts")" = "resume=0" ] && [ "$(grep -c 'resume=1' "${WORK}/attempts")" = "5" ] \
  && ok "…every retry resumes from the saved cursor (SWS_RESUME=1)" || bad "SWS_RESUME on retries" "$(tr '\n' ' ' < "${WORK}/attempts")"

SHARD_RETRY_SLEEP_SEC=0 run_retry "0 1"
[ "${RC}" -eq 1 ] && [ "${ATTEMPTS}" = "3" ] && ok "no suspend → 3 attempts, rc 1 (unchanged)" || bad "awake budget" "rc=${RC} attempts=${ATTEMPTS}"
if printf '%s' "${OUT}" | grep -q '^\[refresh-api\] shard 2 log: \[refresh-api\] shard 2 failed after 2 retries (last rc=1; 0 suspend-affected'; then
  ok "final failure tails the shard log into the main log"
else
  bad "final failure log tail" "$(printf '%s' "${OUT}" | tail -3 | tr '\n' ' ')"
fi
printf '%s' "${OUT}" | grep -q '^\[refresh-api\] shard 2 log: \[stub\] attempt 3' \
  && ok "…including the scraper's own last lines" || bad "tail includes scraper output" "$(printf '%s' "${OUT}" | grep 'log:' | head -3 | tr '\n' ' ')"

SHARD_RETRY_SLEEP_SEC=0 run_retry "900 1" "0 1" "900 1" "0 1" "0 1"
[ "${RC}" -eq 1 ] && [ "${ATTEMPTS}" = "5" ] && ok "mixed: 2 forgiven + 3 counted → 5 attempts" || bad "mixed" "rc=${RC} attempts=${ATTEMPTS}"

SHARD_RETRY_SLEEP_SEC=0 SHARD_MAX_SUSPENDED_RETRIES=2 run_retry "900 1"
[ "${RC}" -eq 1 ] && [ "${ATTEMPTS}" = "5" ] \
  && ok "SHARD_MAX_SUSPENDED_RETRIES caps forgiveness (2 forgiven, then 3 counted)" || bad "forgiveness cap" "rc=${RC} attempts=${ATTEMPTS}"

echo "--- panic and ladder codes are never forgiven ---"
SHARD_RETRY_SLEEP_SEC=0 run_retry "900 4"
[ "${RC}" -eq 4 ] && [ "${ATTEMPTS}" = "1" ] && ok "rc 4 while suspended → not retried" || bad "rc 4 suspended" "rc=${RC} attempts=${ATTEMPTS}"
SHARD_RETRY_SLEEP_SEC=0 run_retry "900 3"
[ "${RC}" -eq 3 ] && [ "${ATTEMPTS}" = "1" ] && ok "rc 3 while suspended → not retried" || bad "rc 3 suspended" "rc=${RC} attempts=${ATTEMPTS}"
SHARD_RETRY_SLEEP_SEC=0 run_retry "900 7"
[ "${RC}" -eq 7 ] && [ "${ATTEMPTS}" = "3" ] && ok "rc 7 while suspended → normal budget (3 attempts)" || bad "rc 7 suspended" "rc=${RC} attempts=${ATTEMPTS}"

echo "--- the retry pause is wall clock ---"
# 600s pause; the host 'sleeps' 700s 3s into it. On the wall clock the pause is
# over, so the retry runs at once instead of after 600 more awake seconds.
( sleep 3; jump 700 ) &
START=$(date +%s)
SHARD_RETRY_SLEEP_SEC=600 run_retry "900 1" "0 0"
ELAPSED=$(( $(date +%s) - START ))
wait
if [ "${RC}" -eq 0 ] && [ "${ATTEMPTS}" = "2" ] && [ "${ELAPSED}" -lt 30 ]; then
  ok "a suspend during the 600s pause ends it (${ELAPSED}s real)"
else
  bad "wall-clock pause" "rc=${RC} attempts=${ATTEMPTS} ${ELAPSED}s"
fi
printf '%s' "${OUT}" | grep -q 'after 600s of wall clock, once the lid is open or on AC' \
  && ok "…and the pause is logged" || bad "pause logged" "$(printf '%s' "${OUT}" | grep 'wall clock' | tr '\n' ' ')"

# ─────────────────────────────────────────────── log rotation
echo "--- shard log is rotated, not truncated ---"
LOGF="${WORK}/repo/data/sws/refresh-api-shard-2.log"
PREV="${WORK}/repo/data/sws/refresh-api-shard-2.prev.log"
rm -f "${PREV}"
echo "OLD RUN: shard 2 TimeoutError" > "${LOGF}"
SHARD_RETRY_SLEEP_SEC=0 run_retry "0 0"
grep -q 'OLD RUN: shard 2 TimeoutError' "${PREV}" 2>/dev/null && ! shard_log | grep -q 'OLD RUN' \
  && ok "previous run's log → refresh-api-shard-2.prev.log; current log starts fresh" \
  || bad "rotation" "prev=$(cat "${PREV}" 2>&1 | head -2 | tr '\n' ' ') cur=$(shard_log | head -2 | tr '\n' ' ')"
SHARD_RETRY_SLEEP_SEC=0 run_retry "0 0"
grep -q 'attempt 1 (SWS_RESUME=0) at ' "${PREV}" && ! grep -q 'OLD RUN' "${PREV}" \
  && ok "one run back is kept (the next run rotates again)" || bad "second rotation" "$(head -2 "${PREV}" | tr '\n' ' ')"
echo "KEEP" > "${PREV}"; : > "${LOGF}"
SHARD_RETRY_SLEEP_SEC=0 run_retry "0 0"
[ "$(cat "${PREV}")" = "KEEP" ] && ok "an empty log does not overwrite .prev.log" || bad "empty log keeps prev" "$(cat "${PREV}")"
grep -q '^data/sws/refresh\*\.log$' "${REPO_ROOT}/.gitignore" \
  && ok ".prev.log is gitignored (survives the isolated wrapper's git clean -fd)" || bad ".prev.log gitignored" "no data/sws/refresh*.log rule"

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
