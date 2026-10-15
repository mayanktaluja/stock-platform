#!/usr/bin/env bash
#
# Test scripts/sws-git-push.sh — the bounded, retrying, reconciling push every
# SWS publish path goes through.
#
# WHY THIS EXISTS: on 2026-10-15 a clean full-universe nightly passed every gate
# and committed at 10:01 IST, then `git push` stalled for ~1h on an awake,
# AC-powered host and died with
#   error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408
#   send-pack: unexpected disconnect while reading sideband packet
#   fatal: the remote end hung up unexpectedly
#   Everything up-to-date
# The push was single-shot, so the run exited 8 and prod kept the previous
# day's data. The invariants under test:
#   - a transient failure (that exact output, DNS, a stall) is retried and the
#     branch ends up on origin;
#   - a stalled attempt is cut off by the per-attempt cap, and the kill takes
#     its git-remote-https-like child with it (a survivor would hold the output
#     open and keep uploading next to the retry);
#   - rc != 0 is reconciled against ls-remote: a push that landed before the
#     connection died — or lands minutes later — is success, and the tracking
#     ref + upstream a real `push -u` writes are recreated (gh pr create needs
#     them);
#   - deterministic failures (pre-push hook "Push blocked", [rejected]) are NOT
#     retried;
#   - backoff waits on the wall clock (Darwin `sleep` counts awake time only).
#
# Run with: bash test/swsGitPush.test.sh

set -uo pipefail

# git hooks export GIT_DIR & co. into child processes; under `npm test` from
# .githooks/pre-push they would retarget every fixture git command below at
# the REAL repository. Scrub before touching git.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${HERE}/../scripts/sws-git-push.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }

REAL_GIT="$(command -v git)"
REAL_DATE="$(command -v date)"
WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT
mkdir -p "${WORK}/bin" "${WORK}/datebin" "${WORK}/tmp" "${WORK}/nohooks"

# ── git wrapper: intercepts `push`, delegates everything else to real git ────
# PUSH_PLAN is a comma list of per-attempt outcomes (the last one repeats).
# Every push appends its full argv to PUSH_LOG so assertions can count attempts
# and inspect the -c flags each one carried.
cat > "${WORK}/bin/git" <<STUB
#!/usr/bin/env bash
REAL_GIT="${REAL_GIT}"
STUB
cat >> "${WORK}/bin/git" <<'STUB'
is_push=0
for a in "$@"; do [ "$a" = "push" ] && { is_push=1; break; }; done
[ "${is_push}" = 1 ] || exec "${REAL_GIT}" "$@"

echo "$*" >> "${PUSH_LOG}"
n="$(wc -l < "${PUSH_LOG}" | tr -d ' ')"
dir=.; prev=; for a in "$@"; do [ "${prev}" = "-C" ] && dir="${a}"; prev="${a}"; done
branch="${prev}"
outcome="$(printf '%s\n' "${PUSH_PLAN}" | tr ',' '\n' | sed -n "${n}p")"
[ -n "${outcome}" ] || outcome="$(printf '%s\n' "${PUSH_PLAN}" | tr ',' '\n' | tail -1)"

http408() {
  # Verbatim 2026-10-15 output, including git's misleading last line.
  cat >&2 <<'EOF'
error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
Everything up-to-date
EOF
}

case "${outcome}" in
  ok)        exec "${REAL_GIT}" "$@" ;;
  408)       http408; exit 1 ;;
  landed408) # Land the commit on origin by URL: unlike `push origin`, that
             # writes no tracking ref or upstream locally — exactly what a
             # push that died mid-response leaves behind.
             "${REAL_GIT}" -C "${dir}" push -q "${ORIGIN_URL}" "${branch}:refs/heads/${branch}" >/dev/null 2>&1
             http408; exit 1 ;;
  dns)       echo "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com" >&2; exit 128 ;;
  blocked)   echo "[pre-push] Push blocked. Fix the failing tests, or use --no-verify if you have a strong reason."
             echo "error: failed to push some refs to 'https://github.com/x/y.git'" >&2; exit 1 ;;
  rejected)  echo " ! [rejected]        b -> b (non-fast-forward)" >&2
             echo "error: failed to push some refs to 'https://github.com/x/y.git'" >&2; exit 1 ;;
  stall)     # A grandchild holding the output fd, like git-remote-https mid-upload.
             ( exec sleep 20 ) &
             echo $! > "${STALL_CHILD_PID}"
             exec sleep 20 ;;
esac
echo "stub git: unknown PUSH_PLAN outcome '${outcome}'" >&2
exit 99
STUB
chmod +x "${WORK}/bin/git"

# ── date shim: `date +%s` advances DATE_STEP seconds per call ────────────────
# Models a host that sleeps through the backoff: wall clock leaps while awake
# time barely moves. Everything else goes to the real date.
cat > "${WORK}/datebin/date" <<SHIM
#!/usr/bin/env bash
if [ "\$#" -eq 1 ] && [ "\$1" = "+%s" ]; then
  now="\$(cat "\${DATE_FILE}")"
  echo "\${now}"
  echo \$(( now + DATE_STEP )) > "\${DATE_FILE}"
  exit 0
fi
exec "${REAL_DATE}" "\$@"
SHIM
chmod +x "${WORK}/datebin/date"

# ── fixture repos: bare origin + clone (no hooks, branch pinned to main) ─────
"${REAL_GIT}" init -q --bare -b main "${WORK}/origin.git"
"${REAL_GIT}" init -q -b main "${WORK}/clone"
CLONE="${WORK}/clone"
"${REAL_GIT}" -C "${CLONE}" config user.email t@t
"${REAL_GIT}" -C "${CLONE}" config user.name t
"${REAL_GIT}" -C "${CLONE}" config core.hooksPath "${WORK}/nohooks"
"${REAL_GIT}" -C "${CLONE}" remote add origin "${WORK}/origin.git"
echo seed > "${CLONE}/seed.txt"
"${REAL_GIT}" -C "${CLONE}" add seed.txt
"${REAL_GIT}" -C "${CLONE}" commit -q -m seed
"${REAL_GIT}" -C "${CLONE}" push -q origin main

# new_branch <name> — a fresh branch with one new commit, checked out.
new_branch() {
  "${REAL_GIT}" -C "${CLONE}" checkout -q -B "$1" main
  echo "$1 $RANDOM" > "${CLONE}/data.txt"
  "${REAL_GIT}" -C "${CLONE}" add data.txt
  "${REAL_GIT}" -C "${CLONE}" commit -q -m "$1"
}
remote_sha() { "${REAL_GIT}" -C "${CLONE}" ls-remote origin "refs/heads/$1" | awk '{print $1}'; }
local_sha()  { "${REAL_GIT}" -C "${CLONE}" rev-parse "$1"; }
pushes()     { if [ -f "${WORK}/push.log" ]; then wc -l < "${WORK}/push.log" | tr -d ' '; else echo 0; fi; }
push_args()  { sed -n "$1p" "${WORK}/push.log"; }

# run_push <plan> [extra env assignments...] — sources the helper in a clean
# bash and pushes the checked-out branch with -C. Prints the helper's output
# plus RESULT_RC / RESULT_SECS trailers.
run_push() {
  local plan="$1"; shift
  local branch
  branch="$("${REAL_GIT}" -C "${CLONE}" branch --show-current)"
  rm -f "${WORK}/push.log"
  (
    cd "${WORK}" || exit 1
    export PATH="${WORK}/bin:${PATH}" TMPDIR="${WORK}/tmp" PUSH_LOG="${WORK}/push.log" PUSH_PLAN="${plan}"
    export ORIGIN_URL="${WORK}/origin.git" STALL_CHILD_PID="${WORK}/stall-child.pid"
    export SWS_PUSH_BACKOFF_SEC=0 SWS_PUSH_POLL_SEC=1 SWS_PUSH_SETTLE_SEC=0
    unset SWS_NIGHTLY_DEADLINE_EPOCH
    for kv in "$@"; do export "${kv?}"; done
    start="$("${REAL_DATE}" +%s)"
    # shellcheck source=scripts/sws-git-push.sh
    . "${HELPER}"
    sws_git_push -C "${CLONE}" "${branch}"
    rc=$?
    echo "RESULT_RC=${rc} RESULT_SECS=$(( $("${REAL_DATE}" +%s) - start ))"
  ) 2>&1
}
rc_of()   { sed -n 's/.*RESULT_RC=\([0-9]*\).*/\1/p' <<<"$1" | tail -1; }
secs_of() { sed -n 's/.*RESULT_SECS=\([0-9]*\).*/\1/p' <<<"$1" | tail -1; }

echo "sws-git-push"

# ── 1. clean push ─────────────────────────────────────────────────────────────
new_branch b-ok
OUT="$(run_push ok)"
check "clean push returns 0" '[ "$(rc_of "${OUT}")" = 0 ]' "${OUT}"
check "clean push: exactly one attempt" '[ "$(pushes)" = 1 ]' "$(pushes)"
check "clean push: branch on origin at local HEAD" '[ "$(remote_sha b-ok)" = "$(local_sha b-ok)" ]'
check "every attempt carries the stall abort (lowSpeedLimit/Time)" \
  'grep -q "http.lowSpeedLimit=1024" <<<"$(push_args 1)" && grep -q "http.lowSpeedTime=300" <<<"$(push_args 1)"' "$(push_args 1)"
check "attempt 1 keeps git's default HTTP version" '! grep -q "http.version" <<<"$(push_args 1)"' "$(push_args 1)"
check "git output is [git]-prefixed in the log" 'grep -q "^\[git\] " <<<"${OUT}"' "${OUT}"

# ── 2. the 2026-10-15 failure: 408, 408, then the network recovers ───────────
new_branch b-408
OUT="$(run_push 408,408,ok)"
check "verbatim HTTP 408 output is retried until it succeeds" '[ "$(rc_of "${OUT}")" = 0 ]' "${OUT}"
check "408 → 408 → ok took three attempts" '[ "$(pushes)" = 3 ]' "$(pushes)"
check "branch landed on origin" '[ "$(remote_sha b-408)" = "$(local_sha b-408)" ]'
check "retries fall back to HTTP/1.1" \
  'grep -q "http.version=HTTP/1.1" <<<"$(push_args 2)" && grep -q "http.version=HTTP/1.1" <<<"$(push_args 3)"'
check "success after retry is logged with the attempt number" 'grep -q "succeeded on attempt 3/4" <<<"${OUT}"' "${OUT}"

# ── 3. unrecognised transient error (DNS) is retried, not treated as final ───
new_branch b-dns
OUT="$(run_push dns,ok)"
check "DNS failure retried" '[ "$(rc_of "${OUT}")" = 0 ] && [ "$(pushes)" = 2 ]' "${OUT}"

# ── 4. the pack landed, then the connection died: reconcile, don't re-push ───
new_branch b-landed
OUT="$(run_push landed408)"
check "rc!=0 but origin has the commit → success" '[ "$(rc_of "${OUT}")" = 0 ]' "${OUT}"
check "reconciled without a second push" '[ "$(pushes)" = 1 ]' "$(pushes)"
check "reconcile is logged" 'grep -q "treating as pushed" <<<"${OUT}"' "${OUT}"
check "reconcile records the upstream push -u would have set" \
  '[ "$("${REAL_GIT}" -C "${CLONE}" config branch.b-landed.remote)" = origin ] && [ "$("${REAL_GIT}" -C "${CLONE}" config branch.b-landed.merge)" = refs/heads/b-landed ]'
check "reconcile recreates the tracking ref gh pr create resolves the head from" \
  '[ "$("${REAL_GIT}" -C "${CLONE}" rev-parse -q --verify refs/remotes/origin/b-landed)" = "$(local_sha b-landed)" ]'

# ── 4b. the pack lands AFTER the client gave up: the settle poll catches it ──
new_branch b-late
( sleep 3; "${REAL_GIT}" -C "${CLONE}" push -q "${WORK}/origin.git" "b-late:refs/heads/b-late" >/dev/null 2>&1 ) &
LATE_PID=$!
OUT="$(run_push 408 SWS_PUSH_ATTEMPTS=1 SWS_PUSH_SETTLE_SEC=20 SWS_PUSH_SETTLE_POLL_SEC=1)"
wait "${LATE_PID}" 2>/dev/null
check "late-landing push is reconciled by the settle poll" '[ "$(rc_of "${OUT}")" = 0 ] && grep -q "treating as pushed" <<<"${OUT}"' "${OUT}"
check "settle poll ended once it saw the branch (took $(secs_of "${OUT}")s)" '[ "$(secs_of "${OUT}")" -lt 15 ]' "${OUT}"

new_branch b-never
OUT="$(run_push 408 SWS_PUSH_ATTEMPTS=1 SWS_PUSH_SETTLE_SEC=3 SWS_PUSH_SETTLE_POLL_SEC=1)"
check "settle poll gives up when nothing lands" '[ "$(rc_of "${OUT}")" != 0 ] && [ -z "$(remote_sha b-never)" ]' "${OUT}"

# ── 5. deterministic failures are not retried ────────────────────────────────
new_branch b-blocked
OUT="$(run_push blocked)"
check "pre-push 'Push blocked' fails" '[ "$(rc_of "${OUT}")" != 0 ]' "${OUT}"
check "pre-push 'Push blocked' is not retried" '[ "$(pushes)" = 1 ]' "$(pushes)"
check "non-retryable failure is logged as such" 'grep -q "non-retryable" <<<"${OUT}"' "${OUT}"
check "blocked branch is not on origin" '[ -z "$(remote_sha b-blocked)" ]'

new_branch b-rejected
OUT="$(run_push rejected)"
check "[rejected] fails without retry" '[ "$(rc_of "${OUT}")" != 0 ] && [ "$(pushes)" = 1 ]' "${OUT}"

# ── 6. a sustained outage gives up after SWS_PUSH_ATTEMPTS ───────────────────
new_branch b-down
OUT="$(run_push 408 SWS_PUSH_ATTEMPTS=3)"
check "sustained 408 fails" '[ "$(rc_of "${OUT}")" != 0 ]' "${OUT}"
check "sustained 408 stops at SWS_PUSH_ATTEMPTS" '[ "$(pushes)" = 3 ]' "$(pushes)"
check "give-up is logged" 'grep -q "giving up after 3 attempt(s)" <<<"${OUT}"' "${OUT}"

# ── 7. a stalled upload is cut off by the per-attempt cap ────────────────────
# The stub sleeps 20s with a grandchild holding the output fd. A `| tee | sed`
# pipeline, or a killer that spares the grandchild, waits for it.
new_branch b-stall
OUT="$(run_push stall,ok SWS_PUSH_ATTEMPT_TIMEOUT_SEC=2)"
check "stalled attempt is killed and the retry ships" '[ "$(rc_of "${OUT}")" = 0 ] && [ "$(pushes)" = 2 ]' "${OUT}"
check "stall cut off well before the 20s stall ends (took $(secs_of "${OUT}")s)" '[ "$(secs_of "${OUT}")" -lt 15 ]' "${OUT}"
check "stalled branch landed on origin" '[ "$(remote_sha b-stall)" = "$(local_sha b-stall)" ]'
check "the stalled attempt's child process was killed with it" \
  '[ -s "${WORK}/stall-child.pid" ] && ! kill -0 "$(cat "${WORK}/stall-child.pid")" 2>/dev/null' \
  "pid $(cat "${WORK}/stall-child.pid" 2>/dev/null) still alive"

# ── 8. no retry that would run into the nightly deadline ─────────────────────
new_branch b-deadline
OUT="$(run_push 408 "SWS_NIGHTLY_DEADLINE_EPOCH=$(( $("${REAL_DATE}" +%s) + 30 ))")"
check "deadline too close: one attempt, then stop" '[ "$(rc_of "${OUT}")" != 0 ] && [ "$(pushes)" = 1 ]' "${OUT}"
check "deadline stop is logged" 'grep -q "nightly deadline is too close" <<<"${OUT}"' "${OUT}"

# ── 9. backoff waits on the wall clock, not on awake seconds ─────────────────
# Backoff is 3600s; `date +%s` leaps 600s per call (a host asleep through the
# wait). A `sleep 3600`-style wait would hang; a wall-clock wait ends in a few
# 1s ticks.
new_branch b-wall
echo "$("${REAL_DATE}" +%s)" > "${WORK}/date-now"
OUT="$(DATE_FILE="${WORK}/date-now" DATE_STEP=600 PATH="${WORK}/datebin:${PATH}" \
  run_push 408,ok SWS_PUSH_BACKOFF_SEC=3600)"
check "a 3600s backoff ends once the wall clock passes it" '[ "$(rc_of "${OUT}")" = 0 ] && [ "$(pushes)" = 2 ]' "${OUT}"
check "wall-clock backoff took $(secs_of "${OUT}")s of real time (< 30)" '[ "$(secs_of "${OUT}")" -lt 30 ]' "${OUT}"

# ── 10. default call shape (no -C) works from the repo's cwd ─────────────────
new_branch b-cwd
rm -f "${WORK}/push.log"
OUT="$(cd "${CLONE}" && PATH="${WORK}/bin:${PATH}" TMPDIR="${WORK}/tmp" PUSH_LOG="${WORK}/push.log" PUSH_PLAN=ok \
  bash -c '. "$1" && sws_git_push b-cwd; echo "RESULT_RC=$?"' _ "${HELPER}" 2>&1)"
check "sws_git_push <branch> pushes the cwd repo" '[ "$(rc_of "${OUT}")" = 0 ] && [ "$(remote_sha b-cwd)" = "$(local_sha b-cwd)" ]' "${OUT}"

# ── 11. the old bare pushes are gone from every publish path ─────────────────
# Code quotes the branch variable; the mails' copy-paste replay commands don't.
for f in sws-nightly.sh sws-auto-ship.sh sws-refresh-api.sh; do
  bare="$(grep -nE '^[^#]*git (-C "[^"]+" )?push -u origin "\$\{' "${HERE}/../scripts/${f}" || true)"
  check "${f}: no bare 'git push -u origin' left (all go through sws_git_push)" '[ -z "${bare}" ]' "${bare}"
done

echo
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
