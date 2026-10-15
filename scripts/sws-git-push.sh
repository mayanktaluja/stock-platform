#!/usr/bin/env bash
# Bounded, retrying, reconciling `git push -u origin <branch>` for every SWS
# publish path. Source it, then:
#   sws_git_push [-C <dir>] <branch>
# Returns 0 once origin/<branch> points at the local HEAD — pushed by this call,
# or found already there on reconcile — and non-zero otherwise. Git output is
# echoed with a "[git] " prefix, exactly like the bare pushes it replaces.
#
# WHY (2026-10-15): a clean full-universe nightly passed every gate, committed
# 48 files at 10:01 IST, and then lost the whole day at `git push`. The ~50 MB
# data upload stalled for ~1h on an awake, AC-powered host (pmset shows no
# sleep and caffeinate holding), GitHub finally answered
#   error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408
#   fatal: the remote end hung up unexpectedly
# and the single-shot push exited 8. Prod kept serving the previous day's data
# and the commit sat on a local branch until a human re-pushed it. Nothing in
# that chain was deterministic: the same push succeeds on a second try.
#
# Each property below fixes one link of that chain:
#  1. A stalled upload fails in minutes, not an hour. http.lowSpeedLimit/Time
#     makes curl abort a transfer under 1 KB/s for 300s ("Operation too
#     slow"), and every attempt is wall-clock capped (20 min) with its WHOLE
#     process group killed — see _sws_push_run_bounded for why the group.
#     300s, not less: while GitHub indexes the pack it sends only ~1 B/s of
#     keepalives, and an abort then would throw away a push about to land.
#  2. Transient failures retry with WALL-CLOCK backoff: Darwin's `sleep N`
#     counts awake time only, so waits poll `date +%s`. Attempts >= 2 force
#     HTTP/1.1 — curl's HTTP/2 path is the usual source of "stream was not
#     closed cleanly" / sideband disconnects on large pushes. A retry (and
#     each attempt's cap) is fitted inside SWS_NIGHTLY_DEADLINE_EPOCH, since
#     the wrapper's deadline kill would turn "push failed, here is how to
#     re-ship" into an abort mail that says nothing about the stranded commit.
#  3. A non-zero rc means "outcome unknown", never "nothing happened" (same
#     lesson as the 2026-08-11 gh 502, see the PR reconcile block in
#     sws-nightly.sh). After every failed attempt `ls-remote` decides, and
#     before finally giving up it keeps polling for a few minutes, because a
#     pack whose connection died can still land server-side. Git itself
#     printed "Everything up-to-date" right after the fatal 408, so its own
#     output cannot be trusted here. On a reconciled success the local state
#     `push -u` would have written (tracking ref + upstream) is recreated:
#     `gh pr create` resolves the head branch from it.
#
# Only failures that cannot change on a retry stop early: the pre-push hook
# blocking the push, a ref rejection, or bad credentials. Anything else —
# including output we have never seen — is retried: a wasted retry costs
# minutes, a missed one costs a day of prod data.
#
# Knobs (env): SWS_PUSH_ATTEMPTS (4), SWS_PUSH_ATTEMPT_TIMEOUT_SEC (1200),
# SWS_PUSH_BACKOFF_SEC ("60 180 600", last value repeats),
# SWS_PUSH_LOW_SPEED_LIMIT (1024 bytes/s), SWS_PUSH_LOW_SPEED_TIME (300s),
# SWS_PUSH_SETTLE_SEC (180) / SWS_PUSH_SETTLE_POLL_SEC (30) for the final
# ls-remote polling, SWS_PUSH_POLL_SEC (5, the backoff wait's tick).
#
# bash 3.2 compatible (launchd resolves /bin/bash): no empty-array expansions
# under `set -u`, no `local -n`, no GNU-only tools.

# bash only. Sourced into zsh (a hand re-ship from an interactive shell), the
# attempt subshell's `set -m` errors out before git runs, so every attempt
# "fails" in 0s with no git output — refuse up front instead.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "sws-git-push.sh: requires bash — run it as: bash -c '. scripts/sws-git-push.sh && sws_git_push <branch>'" >&2
  return 1 2>/dev/null || exit 1
fi

# Exit 0 when the captured push output shows a failure a retry cannot fix.
#   "Push blocked"            — this repo's pre-push hook refused (tests/data
#                               validation). Re-running it would just fail again.
#   "hook declined"           — a server-side pre-receive hook refused.
#   "[rejected]"              — client-side ref rejection (non-fast-forward /
#                               fetch first). "[remote rejected]" is NOT matched:
#                               GitHub uses it for transient 5xx-style failures.
#   auth / 401 / 403 / 404    — credentials or repo access; a retry won't help.
# HTTP 408 and 5xx, "RPC failed", "remote end hung up", DNS and TLS errors are
# deliberately absent: those are the transient class this helper exists for.
sws_push_failure_is_permanent() {
  grep -qE 'Push blocked|hook declined|\[rejected\]|Authentication failed|Invalid username or password|Permission to [^ ]+ denied|returned error: 40[134]' "$1"
}

# _sws_push_run_bounded <seconds> <outfile> <cmd...>
# Runs cmd with stdout+stderr in outfile, and kills its WHOLE process group
# once <seconds> of wall clock pass. Returns cmd's rc (143/137 when killed).
#
# Why not with_timeout: under launchd there is no gtimeout/timeout, and
# with_timeout's bash fallback kills only its direct child. For a push that is
# `git`, while `git-remote-https` — the process actually uploading — survives
# as an orphan: it holds any output pipe open (the caller then blocks until the
# upload ends on its own, which is exactly the hour this helper exists to
# avoid) and keeps competing for bandwidth with the next attempt. `set -m`
# gives the background job its own process group, so the kill reaches every
# process git spawned. Output goes to a file, never a pipe, for the same
# reason, and per-attempt files keep a late write out of the next
# classification.
_sws_push_run_bounded() {
  local secs="$1" outf="$2"
  shift 2
  (
    set -m
    "$@" >"${outf}" 2>&1 </dev/null &
    cmd_pid=$!
    kill_at=$(( $(date +%s) + secs ))
    (
      while kill -0 "${cmd_pid}" 2>/dev/null; do
        if [ "$(date +%s)" -ge "${kill_at}" ]; then
          echo "[timeout] exceeded ${secs}s; killing process group ${cmd_pid}" >>"${outf}"
          kill -TERM -- "-${cmd_pid}" 2>/dev/null
          sleep 5
          kill -KILL -- "-${cmd_pid}" 2>/dev/null
          exit 0
        fi
        sleep 1
      done
    ) </dev/null >/dev/null 2>&1 &
    wd_pid=$!
    wait "${cmd_pid}"
    rc=$?
    kill "${wd_pid}" 2>/dev/null
    wait "${wd_pid}" 2>/dev/null
    exit "${rc}"
  ) 2>/dev/null
}

# Wait until wall-clock epoch $1, in short awake ticks.
_sws_push_wait_until() {
  local target="$1" tick="${SWS_PUSH_POLL_SEC:-5}"
  while [ "$(date +%s)" -lt "${target}" ]; do
    sleep "${tick}"
  done
}

# Nth whitespace-separated value of $1 (1-based); past the end, the last one.
_sws_push_backoff_for() {
  echo "$1" | awk -v n="$2" '{ print (n <= NF) ? $n : $NF }'
}

# _sws_push_remote_sha <dir> <branch> <scratch file>
# The sha origin holds for refs/heads/<branch>, or "" when absent/unreachable.
_sws_push_remote_sha() {
  _sws_push_run_bounded 60 "$3" git -C "$1" \
    -c "http.lowSpeedLimit=${SWS_PUSH_LOW_SPEED_LIMIT:-1024}" -c http.lowSpeedTime=30 \
    ls-remote origin "refs/heads/$2" || true
  awk 'NR == 1 && $1 ~ /^[0-9a-f]+$/ { print $1 }' "$3"
}

# Seconds left before the nightly deadline minus a margin, or "" when the
# caller has no deadline.
_sws_push_time_left() {
  [ -n "${SWS_NIGHTLY_DEADLINE_EPOCH:-}" ] || return 0
  echo $(( SWS_NIGHTLY_DEADLINE_EPOCH - $(date +%s) - 60 ))
}

sws_git_push() {
  local dir="."
  if [ "${1:-}" = "-C" ]; then
    dir="$2"
    shift 2
  fi
  local branch="${1:-}"
  if [ -z "${branch}" ]; then
    echo "[git] sws_git_push: branch name required" >&2
    return 2
  fi

  local attempts="${SWS_PUSH_ATTEMPTS:-4}"
  local attempt_timeout="${SWS_PUSH_ATTEMPT_TIMEOUT_SEC:-1200}"
  local backoff="${SWS_PUSH_BACKOFF_SEC:-60 180 600}"
  local low_limit="${SWS_PUSH_LOW_SPEED_LIMIT:-1024}"
  local low_time="${SWS_PUSH_LOW_SPEED_TIME:-300}"
  local settle="${SWS_PUSH_SETTLE_SEC:-180}" settle_poll="${SWS_PUSH_SETTLE_POLL_SEC:-30}"
  # A retry needs room for the stall abort plus the ls-remote that follows.
  local min_attempt=$(( low_time + 120 ))

  local local_sha
  local_sha="$(git -C "${dir}" rev-parse HEAD 2>/dev/null)"

  local base
  base="$(mktemp "${TMPDIR:-/tmp}/sws-git-push.XXXXXX")" || return 1

  local attempt=1 rc=1 out remote_sha delay started cap left settle_until permanent=0
  while :; do
    local -a cfg=(-c "http.lowSpeedLimit=${low_limit}" -c "http.lowSpeedTime=${low_time}")
    [ "${attempt}" -ge 2 ] && cfg+=(-c "http.version=HTTP/1.1")

    cap="${attempt_timeout}"
    left="$(_sws_push_time_left)"
    if [ -n "${left}" ] && [ "${left}" -lt "${cap}" ]; then
      cap="${left}"
      [ "${cap}" -lt 60 ] && cap=60
    fi

    out="${base}.${attempt}"
    started="$(date +%s)"
    _sws_push_run_bounded "${cap}" "${out}" git -C "${dir}" "${cfg[@]}" push -u origin "${branch}"
    rc=$?
    sed 's/^/[git] /' "${out}"
    if [ "${rc}" -eq 0 ]; then
      [ "${attempt}" -gt 1 ] && echo "[git] push of ${branch} succeeded on attempt ${attempt}/${attempts}"
      rm -f "${base}" "${base}".* 2>/dev/null
      return 0
    fi

    # rc != 0 is "unknown": the pack may have landed before the connection
    # died. Ask origin before deciding anything.
    remote_sha="$(_sws_push_remote_sha "${dir}" "${branch}" "${base}.ls")"
    [ -n "${local_sha}" ] && [ "${remote_sha}" = "${local_sha}" ] && break

    if sws_push_failure_is_permanent "${out}"; then
      echo "[git] push of ${branch} failed (rc=${rc}) with a non-retryable error — not retrying"
      permanent=1
      break
    fi
    if [ "${attempt}" -ge "${attempts}" ]; then
      echo "[git] push of ${branch} failed (rc=${rc}) — giving up after ${attempts} attempt(s)"
      break
    fi

    delay="$(_sws_push_backoff_for "${backoff}" "${attempt}")"
    left="$(_sws_push_time_left)"
    if [ -n "${left}" ] && [ $(( left - delay )) -lt "${min_attempt}" ]; then
      echo "[git] push of ${branch} failed (rc=${rc}) — no retry, the nightly deadline is too close"
      break
    fi
    echo "[git] push attempt ${attempt}/${attempts} of ${branch} failed (rc=${rc}, $(( $(date +%s) - started ))s) — retrying in ${delay}s over HTTP/1.1"
    _sws_push_wait_until $(( $(date +%s) + delay ))
    attempt=$((attempt + 1))
  done

  # A transient failure may still be landing server-side (GitHub finishes
  # indexing a pack after the client gave up). Poll before calling it lost.
  # Deterministic refusals never reached origin, so they skip this.
  if [ "${permanent}" = 0 ] && [ -n "${local_sha}" ] && [ "${remote_sha}" != "${local_sha}" ]; then
    settle_until=$(( $(date +%s) + settle ))
    left="$(_sws_push_time_left)"
    [ -n "${left}" ] && [ "${left}" -lt "${settle}" ] && settle_until=$(( $(date +%s) + left ))
    while [ "$(date +%s)" -lt "${settle_until}" ]; do
      _sws_push_wait_until $(( $(date +%s) + settle_poll < settle_until ? $(date +%s) + settle_poll : settle_until ))
      remote_sha="$(_sws_push_remote_sha "${dir}" "${branch}" "${base}.ls")"
      [ "${remote_sha}" = "${local_sha}" ] && break
    done
  fi

  if [ -n "${local_sha}" ] && [ "${remote_sha}" = "${local_sha}" ]; then
    echo "[git] push rc=${rc}, but origin/${branch} is at ${local_sha} — treating as pushed"
    # Recreate what a successful `push -u` writes locally. Without the
    # tracking ref, `gh pr create` aborts with "you must first push the
    # current branch to a remote, or use the --head flag".
    git -C "${dir}" update-ref "refs/remotes/origin/${branch}" "${local_sha}" >/dev/null 2>&1 || true
    git -C "${dir}" config "branch.${branch}.remote" origin >/dev/null 2>&1 || true
    git -C "${dir}" config "branch.${branch}.merge" "refs/heads/${branch}" >/dev/null 2>&1 || true
    rm -f "${base}" "${base}".* 2>/dev/null
    return 0
  fi

  rm -f "${base}" "${base}".* 2>/dev/null
  return "${rc}"
}
