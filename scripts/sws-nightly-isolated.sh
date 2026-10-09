#!/usr/bin/env bash
#
# Launchd entrypoint for the SWS nightly. It keeps the data publisher out of
# the primary development checkout by running scripts/sws-nightly.sh from a
# dedicated, resettable worktree.

set -uo pipefail

PRIMARY_REPO="${SWS_NIGHTLY_PRIMARY_REPO:-/Users/mayanktaluja/code/stock-platform}"
WORKTREE_DIR="${SWS_NIGHTLY_WORKTREE_DIR:-/Users/mayanktaluja/.Codex/worktrees/stock-platform-sws-nightly}"
BASE_BRANCH="${SWS_NIGHTLY_BASE_BRANCH:-sws-nightly-isolated-base}"

# Absolute abort time, anchored to wrapper start — NOT a duration measured from
# when the body finally launches. On 2026-08-08 the run held its slot for
# 24h36m and was still alive when the next 00:30 fire came round; launchd
# treats a calendar event that arrives while the service is active as consumed,
# not queued, so that day never ran at all. One bad night cost two days.
#
# Anchoring here rather than after the AC wait below is deliberate: a run that
# waits 5h for a charger and then takes 21h would finish at 02:30 and suppress
# the next slot exactly as before. The wait has to come out of the same budget.
# 21h from a 00:30 start aborts at 21:30 IST, leaving ~3h for a human to fire a
# manual /sws-refresh before the next slot.
SWS_NIGHTLY_DEADLINE_SEC="${SWS_NIGHTLY_DEADLINE_SEC:-75600}"
SWS_NIGHTLY_DEADLINE_EPOCH=$(( $(date +%s) + SWS_NIGHTLY_DEADLINE_SEC ))

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }

source_env_if_present() {
  local file="$1"
  if [ -f "${file}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${file}" 2>/dev/null || true
    set +a
  fi
}

source_env_if_present "${PRIMARY_REPO}/.env"
source_env_if_present "${PRIMARY_REPO}/.env.local"

send_mail() {
  local subject="$1"; local body="$2"
  if [ -f "${PRIMARY_REPO}/scripts/sws-mail-summary.mjs" ]; then
    printf "%s" "${body}" | node "${PRIMARY_REPO}/scripts/sws-mail-summary.mjs" "${subject}" - 2>&1 | sed 's/^/[mail] /' || true
  fi
}

exclude_worktree_path() {
  local pattern="$1"
  local exclude_file
  exclude_file="$(git -C "${WORKTREE_DIR}" rev-parse --git-path info/exclude 2>/dev/null || true)"
  if [ -n "${exclude_file}" ]; then
    mkdir -p "$(dirname "${exclude_file}")"
    grep -qxF "${pattern}" "${exclude_file}" 2>/dev/null || printf "\n%s\n" "${pattern}" >> "${exclude_file}"
  fi
}

link_local_artifact() {
  local rel="$1"
  local src="${PRIMARY_REPO}/${rel}"
  local dest="${WORKTREE_DIR}/${rel}"
  if [ -e "${src}" ]; then
    rm -rf -- "${dest}" || fail_critical "local artifact clear failed" "Could not clear ${dest} before linking ${src} at $(ts)." 5
    mkdir -p "$(dirname "${dest}")"
    ln -s "${src}" "${dest}" || fail_critical "local artifact link failed" "Could not link ${src} into ${dest} at $(ts)." 5
  else
    rm -rf -- "${dest}" 2>/dev/null || true
  fi
}

fail_critical() {
  local subject="$1"; local body="$2"; local rc="${3:-5}"
  echo "[isolated-nightly] ${subject}"
  send_mail "🚨 SWS nightly — ${subject}" "${body}"
  exit "${rc}"
}

if [ ! -d "${PRIMARY_REPO}/.git" ] && [ ! -f "${PRIMARY_REPO}/.git" ]; then
  fail_critical "primary repo missing" "Primary repo not found at ${PRIMARY_REPO} at $(ts)." 5
fi

if [ -z "${RESEND_API_KEY:-}" ] && [ ! -f "${PRIMARY_REPO}/.env" ] && [ ! -f "${PRIMARY_REPO}/.env.local" ]; then
  # Best-effort: this may not send without RESEND_API_KEY, but it still leaves
  # an explicit launchd/log signal instead of silently losing critical alerts.
  fail_critical "mail config missing" "No RESEND_API_KEY in launchd env and neither .env nor .env.local exists in ${PRIMARY_REPO}. Critical nightly alerts may not send." 5
fi

echo "[isolated-nightly] primary=${PRIMARY_REPO}"
echo "[isolated-nightly] worktree=${WORKTREE_DIR}"
echo "[isolated-nightly] base_branch=${BASE_BRANCH}"

# ── Self-heal: always run origin/main's reviewed copy of THIS wrapper ─────────
# launchd (scripts/com.starbhai.sws-nightly.plist) and /sws-refresh both exec
# THIS file straight out of the canonical dev checkout — which floats on whatever
# feature branch the user is working on. On 2026-07-24 that checkout was parked on
# a branch that predated the single-instance lock below, so the lock simply was
# not present in the running code: the 00:30 cron collided with an in-flight
# manual /sws-refresh, its `git reset --hard origin/main` reverted the manual
# run's freshly-scored picks-latest.json + deep/*.json mid-flight, and that run's
# sanity gate then failed on stale artifacts (picks_recent 114h, price freshness).
#
# The worktree the nightly BODY runs in is always reset to origin/main, so
# sws-nightly.sh is never stale — only THIS wrapper (the lock + the destructive
# reset) can be. Re-exec origin/main's version before touching anything so the
# reviewed logic always wins, no matter which branch the checkout sits on.
# Guarded by SWS_NIGHTLY_REEXECED against loops, and fail-open: a fetch/show hiccup
# falls through to the local copy rather than skipping the nightly.
if [ -z "${SWS_NIGHTLY_REEXECED:-}" ] && [ "${SWS_NIGHTLY_NO_REEXEC:-0}" != "1" ]; then
  self_path="${BASH_SOURCE[0]:-$0}"
  git -C "${PRIMARY_REPO}" fetch origin main --quiet 2>/dev/null || true
  canonical_wrapper="$(git -C "${PRIMARY_REPO}" show origin/main:scripts/sws-nightly-isolated.sh 2>/dev/null || true)"
  if [ -n "${canonical_wrapper}" ] && [ "${canonical_wrapper}" != "$(cat "${self_path}" 2>/dev/null)" ]; then
    rm -f /tmp/sws-nightly-isolated.reexec.*.sh 2>/dev/null || true
    reexec_path="$(mktemp /tmp/sws-nightly-isolated.reexec.XXXXXX.sh)"
    printf '%s' "${canonical_wrapper}" > "${reexec_path}"
    echo "[isolated-nightly] canonical checkout wrapper differs from origin/main — re-exec'ing the reviewed version (has the single-instance lock)"
    SWS_NIGHTLY_REEXECED=1 exec /bin/bash "${reexec_path}" "$@"
  fi
fi
# ── end self-heal (extracted verbatim by test/swsNightlyReexec.test.sh) ──────

# Single-instance guard. The launchd cron and a manual /sws-refresh both enter
# here and DESTRUCTIVELY reset the shared WORKTREE_DIR (git reset --hard +
# clean). Two concurrent runs would stomp each other's tree mid-flight. Take an
# atomic PID lock; if a live instance already holds it, skip (exit 0) rather
# than corrupt the in-flight publish. A stale lock (holder dead) is reclaimed.
#
# A skip is mailed. When it is launchd's 00:30 fire that skips, that slot is
# gone (launchd consumes a calendar event that arrives while the job runs) and
# the only remaining record used to be one line in launchd-stdout.log.
# ── single-instance lock (extracted verbatim by test/swsNightlyTelemetry.test.sh) ──
LOCK_DIR="${SWS_NIGHTLY_LOCK_DIR:-/tmp/starbhai-sws-nightly.lock.d}"
lock_skip_mail() {
  local holder="$1"; local why="$2"
  send_mail "⏭️ SWS nightly — skipped, another run holds the lock" \
"This invocation (pid $$) skipped at $(ts): ${why}

Lock: ${LOCK_DIR} (holder pid ${holder:-unknown})
$(ps -o pid=,etime=,command= -p "${holder:-0}" 2>/dev/null | cut -c1-200 || true)

If this was the 00:30 launchd fire, that slot is consumed; the holder's result is what ships. Check /sws-status."
}
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  lock_holder="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")"
  if [ -n "${lock_holder}" ] && kill -0 "${lock_holder}" 2>/dev/null; then
    echo "[isolated-nightly] another SWS nightly (pid ${lock_holder}) is already running — skipping to avoid a shared-worktree collision. Check /sws-status; re-run when it finishes."
    lock_skip_mail "${lock_holder}" "another SWS nightly is already running"
    exit 0
  fi
  echo "[isolated-nightly] reclaiming stale lock (holder '${lock_holder:-none}' not alive)"
  rm -rf "${LOCK_DIR}" 2>/dev/null || true
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "[isolated-nightly] could not acquire ${LOCK_DIR}; another run raced us — skipping."
    lock_skip_mail "$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")" "another run took the lock while a stale one was being reclaimed"
    exit 0
  fi
fi
echo "$$" > "${LOCK_DIR}/pid"
trap 'rm -rf "${LOCK_DIR}" 2>/dev/null || true' EXIT
# ── end single-instance lock ────────────────────────────────────────────────

# ── AC wait (extracted verbatim by test/swsNightlyAcWait.test.sh) ────────────
# Root cause of the 2026-08-08 outage. The nightly ran on battery with the lid
# shut and the host cycled ~20s DarkWake against ~14.5min Deep Idle all night:
# the body did not start until 12:16 IST, and 2 of 3 scrape shards then died
# because Playwright's launchPersistentContext timeout is wall-clock and
# expired while the process sat frozen. The same profiles launch in 0.8-1.9s on
# AC, so this is purely a power problem.
#
# caffeinate cannot fix it and never could. Per man caffeinate on this host,
# `-s` "is valid only when system is running on AC power"; `-u` without `-t`
# defaults to a 5-second assertion, and `-t` "is not used when an utility is
# invoked with this command" — which is exactly the form the plist uses. The
# 08-08 pmset log shows the whole story in three lines: caffeinate created
# PreventSystemSleep at 14:12:09, its UserIsActive assertion timed out five
# seconds later, and the machine entered an 867-second Maintenance Sleep at
# 14:12:27. `pmset -g custom` here is `sleep 1` on battery — idle-sleep after
# one minute. There is no userspace way to hold this off.
#
# So don't fight it: wait for the charger. This beats both alternatives. A hard
# skip (the exit-4 guard in sws-nightly.sh) turns every unplugged night into a
# guaranteed no-data day, which is what its own comment was written to prevent.
# Proceeding anyway is what produced the 24h36m zombie. Waiting means the data
# is late rather than missing, and needs no root and no new daemon.
#
# Placed AFTER the lock, not before, so only one instance can ever be waiting:
# two waiters would wake together when power returned and race for the tree.
# Cost is that a manual /sws-refresh skips while a deferred cron holds the
# lock, which is the correct outcome anyway.
#
# `head -1` is load-bearing: line 1 is "Now drawing from 'AC Power'". Line 2
# reads "-InternalBattery-0 ... 21%; AC attached; not charging", so widening to
# head -2 would match "AC" while the machine is running down its battery.
sws_on_ac() { pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power"; }

# Own flag, defaulting OFF since 2026-10-09 — owner decision: the nightly must
# start at its slot whatever the power state; keeping the Mac charged is the
# owner's call, not a precondition. In practice the wait turned unplugged nights
# into runs that began at 12:01 / 13:10 / 13:37 IST and then could not fit the
# deadline (09-27, 09-29, 09-30). The trade-off is the one documented above: a
# battery run with the lid shut can be suspended mid-scrape. Set
# SWS_NIGHTLY_AC_WAIT=1 to restore the wait.
#
# Deliberately NOT gated on SWS_NIGHTLY_SKIP_BATTERY. That variable controls a
# different policy: the bare `pmset` check in sws-nightly.sh, which hard-`exit
# 4`s from the BODY. Arming both would mean two files disagreeing about power
# policy. Leave that one at 1; this is the single decision point.
SWS_NIGHTLY_AC_WAIT="${SWS_NIGHTLY_AC_WAIT:-0}"
SWS_AC_POLL_SEC="${SWS_AC_POLL_SEC:-60}"
if [ "${SWS_NIGHTLY_AC_WAIT}" = "1" ] && ! sws_on_ac; then
  ac_wait_abort_at="$(date -r "${SWS_NIGHTLY_DEADLINE_EPOCH}" '+%H:%M:%S' 2>/dev/null || echo "${SWS_NIGHTLY_DEADLINE_EPOCH}")"
  echo "[isolated-nightly] on battery — deferring until AC returns (abort at ${ac_wait_abort_at})"
  # Mailed so the deferral is visible while it can still be fixed: plugging in
  # now buys the whole budget, plugging in at 18:00 buys a run that cannot finish.
  send_mail "🔌 SWS nightly — on battery, waiting for AC" \
"The nightly fired at $(ts) on battery and is waiting for the charger. It starts as soon as AC returns; every hour waited comes out of the same budget, and it gives up at ${ac_wait_abort_at}.

Plug in AND keep the Mac awake for the run: on battery it idle-sleeps after a minute, and a lid closed mid-scrape is what cost 2026-09-26 and 09-29.

$(pmset -g batt 2>&1 | head -3)"
  while ! sws_on_ac; do
    if [ "$(date +%s)" -ge "${SWS_NIGHTLY_DEADLINE_EPOCH}" ]; then
      fail_critical "deferred all night, never got AC" \
"Mac was on battery at the 00:30 slot and never came back on AC before the ${SWS_NIGHTLY_DEADLINE_SEC}s deadline at $(ts).

Skipped cleanly rather than run a suspend-riddled job that would fail its coverage gate and suppress tomorrow's slot as well.

$(pmset -g batt 2>&1 | head -3)" 4
    fi
    sleep "${SWS_AC_POLL_SEC}"
  done
  echo "[isolated-nightly] AC restored at $(ts) — proceeding"
fi
# ── end AC wait ─────────────────────────────────────────────────────────────

if ! git -C "${PRIMARY_REPO}" fetch origin main 2>&1 | sed 's/^/[git] /'; then
  fail_critical "worktree setup fetch failed" "git fetch origin main failed from ${PRIMARY_REPO} at $(ts)." 5
fi

if [ -d "${WORKTREE_DIR}/.git" ] || [ -f "${WORKTREE_DIR}/.git" ]; then
  echo "[isolated-nightly] resetting existing worktree"
  # This worktree is owned by launchd. A prior run can leave generated data
  # dirty if publish fails after commit/push, but those files must not block the
  # next scheduled reset.
  if ! git -C "${WORKTREE_DIR}" reset --hard 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree pre-reset failed" "Could not discard stale generated changes in ${WORKTREE_DIR} at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" clean -fd -- . 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree pre-clean failed" "Could not clean stale generated files in ${WORKTREE_DIR} at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" checkout -f -B "${BASE_BRANCH}" origin/main 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree reset failed" "Could not checkout -B ${BASE_BRANCH} origin/main in ${WORKTREE_DIR} at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" reset --hard origin/main 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree hard reset failed" "Could not reset ${WORKTREE_DIR} to origin/main at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" clean -fd -- . 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree clean failed" "Could not clean ${WORKTREE_DIR} at $(ts)." 5
  fi
elif [ -e "${WORKTREE_DIR}" ]; then
  fail_critical "worktree path is not a git checkout" "${WORKTREE_DIR} exists but is not a git worktree. Refusing to delete it automatically." 5
else
  echo "[isolated-nightly] creating worktree"
  mkdir -p "$(dirname "${WORKTREE_DIR}")"
  if ! git -C "${PRIMARY_REPO}" worktree add -B "${BASE_BRANCH}" "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree create failed" "Could not create ${WORKTREE_DIR} from origin/main at $(ts)." 5
  fi
fi

exclude_worktree_path "node_modules"
exclude_worktree_path ".sws-profile-*"
exclude_worktree_path "data/sws/api-queries.json"

for env_file in .env .env.local; do
  src="${PRIMARY_REPO}/${env_file}"
  dest="${WORKTREE_DIR}/${env_file}"
  if [ -f "${src}" ]; then
    ln -sfn "${src}" "${dest}" || fail_critical "env link failed" "Could not link ${src} into ${dest} at $(ts)." 5
  else
    rm -f "${dest}" 2>/dev/null || true
  fi
done

link_local_artifact "node_modules"
link_local_artifact "data/sws/api-queries.json"
link_local_artifact ".sws-profile-1"
link_local_artifact ".sws-profile-2"
link_local_artifact ".sws-profile-3"

if [ -z "${RESEND_API_KEY:-}" ] && [ ! -f "${WORKTREE_DIR}/.env" ] && [ ! -f "${WORKTREE_DIR}/.env.local" ]; then
  fail_critical "mail config unavailable in isolated worktree" "The isolated worktree has no .env/.env.local symlink and launchd env has no RESEND_API_KEY. Critical alerts may not send." 5
fi

# ── deadline supervisor (extracted verbatim by test/swsNightlyDeadline.test.sh) ──
# Bounds the run so it can never still be alive at the next 00:30 fire. See
# SWS_NIGHTLY_DEADLINE_EPOCH at the top for why the anchor is wrapper start.
#
# `set -m` is required, not cosmetic. Without job control the body shares this
# wrapper's process group, and `kill -TERM "${body_pid}"` reaches only the body
# itself: bash dies, its EXIT trap runs, and sws-refresh-api.sh, the three
# backgrounded shard subshells, node and the whole Chrome tree survive and
# reparent to init. The wrapper would then release LOCK_DIR on top of live
# writers, and the next run's `git reset --hard` + `git clean -fd` would land
# under processes still writing data/sws/deep-api/ — which is precisely the
# 2026-07-24 concurrent-collision incident. With `set -m` the body leads its own
# process group and the negative PID signals every descendant.
#
# The drain below matters for the same reason: the lock must not be released
# until the writers are actually gone, so the trap runs only after we return.
#
# Everything here acts on the process group and NOTHING else — no `pgrep -f`
# sweep by script or binary name. Such a sweep cannot distinguish this run from
# the US/KR/TW scrape forks (same script name, invoked by relative path) or from
# any `npx playwright test`, since "Google Chrome for Testing" is their browser
# too and sws-stealth-context.mjs can even default `channel` to the user's real
# system Chrome. A 21:30 deadline must never reach outside this run.
set -m
echo "[isolated-nightly] launching sws-nightly.sh from isolated worktree"
# The body gets the absolute deadline so its panic gate never waits out a flag
# into a run that this supervisor would then kill (sws-nightly.sh step 0).
SWS_NIGHTLY_REPO_DIR="${WORKTREE_DIR}" \
SWS_NIGHTLY_BASE_BRANCH="${BASE_BRANCH}" \
SWS_NIGHTLY_DEADLINE_EPOCH="${SWS_NIGHTLY_DEADLINE_EPOCH}" \
  bash "${WORKTREE_DIR}/scripts/sws-nightly.sh" "$@" &
body_pid=$!
set +m

# Membership of THIS run's process group is the only scope we ever act on.
# A pattern sweep (pgrep -f sws-api-scrape.mjs) is tempting and wrong: the
# scrape is invoked as a relative path from the worktree, so its command line
# carries nothing that distinguishes this run from the US/KR/TW forks, which
# run the same script name. A sweep would SIGKILL an unrelated scrape. The
# process group contains exactly this run's descendants and nothing else, so
# `kill -0 -PGID` is both the correct liveness probe and the correct blast
# radius. Chrome needs no separate handling — it is in the group.
sws_group_alive() { kill -0 -"${body_pid}" 2>/dev/null; }

# Per-shard cursor vs slice (scripts/sws-scrape-progress.mjs joins the
# progress files with universe.json, which is where the slice actually lives).
shard_progress_summary() {
  node "${WORKTREE_DIR}/scripts/sws-scrape-progress.mjs" summary --data-dir "${WORKTREE_DIR}/data/sws" 2>&1 \
    || echo "(shard progress unavailable)"
}

# ── Watchdog telemetry ──
# The 2026-09-26 and 09-29 runs were killed at the deadline and looked hung:
# the Mac had been unplugged after the AC wait cleared, the lid shut, and it
# slept on battery for most of the day (every pmset sleep since 10-02 was on
# battery). Nothing said so at the time. The watchdog is the one loop that runs
# all day, so it now reports what it can observe:
#
#   - Suspended time. On Darwin `sleep N` counts AWAKE time only (the kernel's
#     timer clock advanced 39ms across a 284s suspend), while `date +%s` jumps
#     by the full suspend. So a tick whose wall-clock gap exceeds 3 ticks was
#     suspended for (gap − tick), almost exactly.
#   - AC loss mid-run, mailed ONCE, only after a run that launched on AC (an
#     operator-forced battery run, SWS_NIGHTLY_AC_WAIT=0, is not news).
#   - How late the deadline itself fired.
# The same awake-only `sleep` is why the tick is 5s, not 30s: on battery the
# host DarkWakes for ~5s (median; p90 9s) every ~15 min, so a 30s tick could
# need several wake cycles — tens of minutes of wall clock — to complete and
# notice the deadline. And it is why every teardown wait below is bounded on
# `date +%s`, not on a count of sleeps: "30 × sleep 2" is 60 AWAKE seconds,
# which on a sleeping laptop can run past the next 00:30 slot.
# State goes through files in LOCK_DIR because this is a subshell.
SWS_WATCHDOG_TICK_SEC="${SWS_WATCHDOG_TICK_SEC:-5}"
# TERM → KILL grace, wall clock. 60s matches the drain below.
SWS_DEADLINE_TERM_GRACE_SEC="${SWS_DEADLINE_TERM_GRACE_SEC:-60}"
DEADLINE_FLAG="${LOCK_DIR}/deadline-fired"
SUSPENDED_FILE="${LOCK_DIR}/suspended-sec"
AC_LOST_FLAG="${LOCK_DIR}/ac-lost-mailed"
DEADLINE_LATE_FILE="${LOCK_DIR}/deadline-late-sec"
echo 0 > "${SUSPENDED_FILE}"
rm -f "${AC_LOST_FLAG}" "${DEADLINE_LATE_FILE}" 2>/dev/null || true
BODY_LAUNCH_EPOCH="$(date +%s)"
AC_AT_LAUNCH=0
sws_on_ac && AC_AT_LAUNCH=1
(
  wd_last="$(date +%s)"
  wd_suspended=0
  while [ "${wd_last}" -lt "${SWS_NIGHTLY_DEADLINE_EPOCH}" ]; do
    sleep "${SWS_WATCHDOG_TICK_SEC}"
    wd_now="$(date +%s)"
    wd_gap=$(( wd_now - wd_last ))
    wd_last="${wd_now}"
    if [ "${wd_gap}" -gt $(( 3 * SWS_WATCHDOG_TICK_SEC )) ]; then
      wd_suspended=$(( wd_suspended + wd_gap - SWS_WATCHDOG_TICK_SEC ))
      echo "${wd_suspended}" > "${SUSPENDED_FILE}"
      echo "[isolated-nightly] host was suspended ~$(( (wd_gap - SWS_WATCHDOG_TICK_SEC) / 60 ))m before $(ts) (watchdog tick took ${wd_gap}s); $(( wd_suspended / 60 ))m suspended this run so far"
    fi
    if [ "${AC_AT_LAUNCH}" = "1" ] && [ ! -f "${AC_LOST_FLAG}" ] && ! sws_on_ac; then
      : > "${AC_LOST_FLAG}"
      echo "[isolated-nightly] AC power lost mid-run at $(ts)"
      send_mail "⚠️ SWS nightly — AC lost mid-run" \
"The Mac went onto battery at $(ts), $(( (wd_now - BODY_LAUNCH_EPOCH) / 60 ))m into the run. On battery it idle-sleeps after a minute and the scrape stops while the lid is shut; 2026-09-26 and 09-29 were lost to the deadline this way.

Plug back in to keep this run alive. It aborts at $(date -r "${SWS_NIGHTLY_DEADLINE_EPOCH}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${SWS_NIGHTLY_DEADLINE_EPOCH}").

$(shard_progress_summary)

$(pmset -g batt 2>&1 | head -3)"
    fi
  done
  # Re-verify before signalling: the body may have exited during the last tick.
  kill -0 "${body_pid}" 2>/dev/null || exit 0
  : > "${DEADLINE_FLAG}"
  wd_late=$(( $(date +%s) - SWS_NIGHTLY_DEADLINE_EPOCH ))
  echo "${wd_late}" > "${DEADLINE_LATE_FILE}"
  echo "[isolated-nightly] DEADLINE reached at $(ts) ($(( wd_late / 60 ))m after it was due) — aborting so the next 00:30 slot is not suppressed"
  kill -TERM -"${body_pid}" 2>/dev/null || kill -TERM "${body_pid}" 2>/dev/null || true
  wd_kill_at=$(( $(date +%s) + SWS_DEADLINE_TERM_GRACE_SEC ))
  while sws_group_alive && [ "$(date +%s)" -lt "${wd_kill_at}" ]; do
    sleep 1
  done
  if sws_group_alive; then
    echo "[isolated-nightly] process group survived TERM — escalating to KILL"
    kill -KILL -"${body_pid}" 2>/dev/null || true
  fi
) &
watchdog_pid=$!

wait "${body_pid}"; body_rc=$?
if [ -f "${DEADLINE_FLAG}" ]; then
  # The body dies on the watchdog's TERM, but its children may not. Killing the
  # watchdog here (as this used to) cut its grace loop short before the KILL
  # escalation, so a TERM-proof grandchild survived, the drain below gave up
  # after 60s, and the lock was released on top of a live writer. Let it finish.
  wait "${watchdog_pid}" 2>/dev/null || true
else
  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true
fi
SUSPENDED_SEC="$(cat "${SUSPENDED_FILE}" 2>/dev/null || echo 0)"
case "${SUSPENDED_SEC}" in ''|*[!0-9]*) SUSPENDED_SEC=0 ;; esac
SUSPENDED_H="$(awk -v s="${SUSPENDED_SEC}" 'BEGIN { printf "%.1f", s / 3600 }')"
RUN_H="$(awk -v s="$(( $(date +%s) - BODY_LAUNCH_EPOCH ))" 'BEGIN { printf "%.1f", s / 3600 }')"
[ "${SUSPENDED_SEC}" -gt 0 ] && echo "[isolated-nightly] host suspended ~${SUSPENDED_H}h of this run's ${RUN_H}h (watchdog tick gaps)"

# Drain before returning, so the EXIT trap cannot release LOCK_DIR while a
# scraper from THIS run is still writing into the shared worktree. Without
# this, the next 00:30 run's `git reset --hard` + `git clean -fd` can land
# underneath live writers — the 2026-07-24 collision. Bounded on wall clock
# (60s), for the same awake-only-sleep reason as the watchdog's grace.
drain_until=$(( $(date +%s) + 60 ))
while sws_group_alive && [ "$(date +%s)" -lt "${drain_until}" ]; do
  echo "[isolated-nightly] waiting for this run's process group to exit"
  sleep 2
done

if [ -f "${DEADLINE_FLAG}" ]; then
  # Distinct from the body's own codes. `wait` on a TERMed child returns 143,
  # which is indistinguishable from any other signal death in launchd-stderr.log.
  echo "[isolated-nightly] aborted on deadline (body rc=${body_rc})"
  DEADLINE_LATE_SEC="$(cat "${DEADLINE_LATE_FILE}" 2>/dev/null || echo 0)"
  case "${DEADLINE_LATE_SEC}" in ''|*[!0-9-]*) DEADLINE_LATE_SEC=0 ;; esac
  send_mail "🚨 SWS nightly — run deadline exceeded" \
"Run exceeded ${SWS_NIGHTLY_DEADLINE_SEC}s and was aborted at $(ts) so the next 00:30 IST slot is not suppressed. No SWS data shipped this run.

Host suspended: ~${SUSPENDED_H}h of the ${RUN_H}h since launch (watchdog tick gaps > $(( 3 * SWS_WATCHDOG_TICK_SEC ))s). $( [ -f "${AC_LOST_FLAG}" ] && echo "AC was lost mid-run (mailed at the time)." || echo "No AC loss seen mid-run." ) The deadline fired $(( DEADLINE_LATE_SEC / 60 ))m late.
$( [ "${SUSPENDED_SEC}" -gt 3600 ] && echo "Most of this run was spent asleep, not stuck: keep the Mac on AC and awake through the run." )

Scrape progress when it stopped:
$(shard_progress_summary)

Body exit code before abort: ${body_rc}.

The 2026-08-08 run ran 24h36m and silently consumed the following day's slot; this bound exists so that cannot recur."
  exit 10
fi

exit "${body_rc}"
# ── end deadline supervisor ─────────────────────────────────────────────────
