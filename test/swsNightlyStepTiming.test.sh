#!/usr/bin/env bash
#
# Test two timing/observability defects in scripts/sws-nightly.sh.
#
# 1. with_timeout's bash fallback (the one launchd actually runs — there is no
#    gtimeout/timeout on its PATH) padded every piped step to its FULL timeout.
#    Killing the watchdog subshell does not kill its `sleep`, and the orphaned
#    sleep held the write end of `with_timeout N cmd | sed` open. Evidence: the
#    early-aux branch always took exactly the sum of its timeouts.
#
# 2. The [sws-branch]/[aux-branch] prefixers used sed, which block-buffers into
#    a pipe. Lines landed in launchd-stdout.log in one burst at branch end
#    (2026-09-28: 18.7h late) and a killed run lost them (09-26, 09-29 looked
#    hung with zero sws-branch lines while the Mac was really asleep mid-scrape).
#
# The fallback is extracted from the real script (no copy), so this pins the
# shipped code; it is eval'd directly, so it runs even on a host with coreutils.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NIGHTLY="${REPO_ROOT}/scripts/sws-nightly.sh"
WORK="$(mktemp -d "/tmp/sws-step-timing-$$.XXXXXX")"
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ FAIL: $2 ${3:-}"; fi; }

# The fallback is the `with_timeout() {` defined inside the final `else` branch.
FALLBACK="$(awk '
  /^else$/ { in_else=1; next }
  in_else && /^  with_timeout\(\) \{$/ { f=1 }
  f { print }
  f && /^  \}$/ { exit }
' "${NIGHTLY}")"
[ -n "${FALLBACK}" ] && ok 1 "with_timeout bash fallback extracted" || ok 0 "with_timeout bash fallback extracted" "(markers moved?)"
eval "${FALLBACK}"

echo "--- with_timeout fallback ---"
# The command must outlive the watchdog's fork of `sleep` (any real step does);
# with a bare `true` the old code raced and sometimes returned at once anyway.
start=$(date +%s)
with_timeout 8 sleep 0.5 2>&1 | cat >/dev/null
elapsed=$(( $(date +%s) - start ))
[ "${elapsed}" -le 3 ] \
  && ok 1 "a 0.5s command in a pipe returns in ~0.5s (${elapsed}s; was the full 8s)" \
  || ok 0 "a 0.5s command in a pipe returns in ~0.5s" "(took ${elapsed}s — an orphaned sleep is holding the pipe)"

start=$(date +%s)
with_timeout 2 sleep 30 2>&1 | cat >/dev/null
rc=${PIPESTATUS[0]}
elapsed=$(( $(date +%s) - start ))
[ "${rc}" -ne 0 ] && [ "${elapsed}" -le 9 ] \
  && ok 1 "a slow command is still killed at its deadline (${elapsed}s, rc=${rc})" \
  || ok 0 "a slow command is still killed at its deadline" "(${elapsed}s, rc=${rc})"

with_timeout 5 sh -c 'exit 7' >/dev/null 2>&1
rc=$?
[ "${rc}" = "7" ] && ok 1 "exit code is propagated (7)" || ok 0 "exit code is propagated" "(got ${rc})"

echo "--- branch prefixers ---"
grep -q "sed 's/^/\[sws-branch\] /'" "${NIGHTLY}" \
  && ok 0 "sws-branch prefixer no longer uses block-buffered sed" \
  || ok 1 "sws-branch prefixer no longer uses block-buffered sed"
grep -q "sed 's/^/\[aux-branch\] /'" "${NIGHTLY}" \
  && ok 0 "aux-branch prefixer no longer uses block-buffered sed" \
  || ok 1 "aux-branch prefixer no longer uses block-buffered sed"

# Pull the shipped awk program off the line and prove it streams: the first
# line must reach the file while the producer is still running.
AWK_PROG="$(grep -o "awk '{ print \"\[sws-branch\] \" \$0; fflush() }'" "${NIGHTLY}" | head -1 | sed "s/^awk '//; s/'\$//")"
[ -n "${AWK_PROG}" ] && ok 1 "sws-branch prefixer is awk with fflush()" || ok 0 "sws-branch prefixer is awk with fflush()"
grep -q "awk '{ print \"\[aux-branch\] \" \$0; fflush() }'" "${NIGHTLY}" \
  && ok 1 "aux-branch prefixer is awk with fflush()" || ok 0 "aux-branch prefixer is awk with fflush()"

if [ -n "${AWK_PROG}" ]; then
  ( echo first; sleep 3; echo second ) | awk "${AWK_PROG}" > "${WORK}/streamed.log" &
  producer=$!
  sleep 1
  grep -qx '\[sws-branch\] first' "${WORK}/streamed.log" \
    && ok 1 "first line is on disk while the branch is still running" \
    || ok 0 "first line is on disk while the branch is still running" "($(cat "${WORK}/streamed.log"))"
  wait "${producer}" 2>/dev/null
  grep -qx '\[sws-branch\] second' "${WORK}/streamed.log" \
    && ok 1 "…and later lines follow" || ok 0 "…and later lines follow"
fi

echo
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ] || exit 1
