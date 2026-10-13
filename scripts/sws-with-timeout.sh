#!/usr/bin/env bash
# Shared step timeout for the SWS nightly scripts. Source it, then:
#   with_timeout <seconds> <command...>
# Exit code is the command's own, or non-zero (143/137) when it was killed.
#
# ONE definition on purpose. sws-refresh-api.sh used to carry its own
# run_with_timeout that fell back to running the command UNBOUNDED when no
# `timeout` binary existed — which is always, under launchd: the plist PATH
# (/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin) has neither
# GNU `timeout` nor coreutils' `gtimeout`. On 2026-08-14 its "900s" sector-news
# step ran 2h40m. A second hand-written copy of the fallback below would drift
# the same way, and the fallback is subtle enough (see the sleep comment) that
# it already shipped broken once.
#
# Prefer gtimeout, then timeout, then a small bash watchdog so vanilla macOS
# still enforces step deadlines. bash 3.2 compatible.
if command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
elif command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
else
  with_timeout() {
    local seconds="$1"
    shift
    "$@" &
    local child_pid=$!
    # The sleeps MUST NOT inherit stdout/stderr. Killing the watchdog subshell
    # below does not kill its `sleep`, and an orphaned sleep holding the write
    # end of `with_timeout N cmd 2>&1 | sed ...` keeps that pipe open — so the
    # pipeline only finished when the sleep did, padding EVERY piped step to
    # its full timeout. This fallback is the one that runs under launchd (no
    # gtimeout/timeout on its PATH): the early-aux branch always took exactly
    # the sum of its timeouts (4621s / 7023s / 7621s), and ~25 min a night sat
    # on the critical path after the barrier.
    (
      sleep "${seconds}" >/dev/null 2>&1 </dev/null
      if kill -0 "${child_pid}" >/dev/null 2>&1; then
        echo "[timeout] command exceeded ${seconds}s; terminating pid ${child_pid}: $*" >&2
        kill -TERM "${child_pid}" >/dev/null 2>&1 || true
        sleep 5 >/dev/null 2>&1 </dev/null
        kill -KILL "${child_pid}" >/dev/null 2>&1 || true
      fi
    ) &
    local watchdog_pid=$!
    wait "${child_pid}"
    local rc=$?
    kill "${watchdog_pid}" >/dev/null 2>&1 || true
    wait "${watchdog_pid}" >/dev/null 2>&1 || true
    return "${rc}"
  }
fi
