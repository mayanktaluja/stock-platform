#!/usr/bin/env bash
#
# Test the self-heal re-exec guard from scripts/sws-nightly-isolated.sh.
#
# WHY THIS EXISTS: on 2026-07-24 the SWS nightly's sanity gate failed because the
# launchd cron and a manual /sws-refresh both exec the wrapper straight out of the
# canonical dev checkout, which was parked on a feature branch that predated the
# single-instance lock. With no lock in the running code, the 00:30 cron reset the
# in-flight manual run's worktree mid-flight and its sanity gate then read stale
# picks/deep artifacts. The re-exec guard makes the wrapper always run origin/main's
# reviewed copy of itself (which has the lock), regardless of the checkout's branch.
#
# Verifies:
#   1. Local wrapper differs from origin/main -> re-exec runs the origin/main body.
#   2. SWS_NIGHTLY_REEXECED=1 -> no re-exec (loop guard).
#   3. SWS_NIGHTLY_NO_REEXEC=1 -> no re-exec (escape hatch).
#   4. Local == origin/main -> no re-exec (steady state, no temp churn).
#   5. Fail-open: origin/main copy unreachable -> fall through to the local body.
#
# Like test/macroOnlyLockPid.test.sh, it extracts just the guard block (between
# the banner markers) so the git/worktree/scrape work below it never runs.

set -uo pipefail

# This test builds throwaway git repos under $WORK. git hooks export GIT_DIR,
# GIT_WORK_TREE and friends into every child process, so when `npm test` runs
# from .githooks/pre-push those vars leak in here and every `git init` /
# `git remote add` / `git commit` below silently retargets the REAL repository
# instead of the fixture — surfacing as "remote origin already exists" and
# "fatal: this operation must be run in a work tree", and failing the push.
# The suite passes standalone and fails only under `git push`, so scrub the
# inherited git environment before touching git at all.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="${REPO_ROOT}/scripts/sws-nightly-isolated.sh"
WORK="$(mktemp -d "/tmp/sws-reexec-test-$$.XXXXXX")"
trap 'rm -rf "${WORK}" /tmp/sws-nightly-isolated.reexec.*.sh 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ok: $2"; else fail=$((fail+1)); echo "  FAIL: $2 ${3:-}"; fi; }

# Extract the guard block verbatim from the real wrapper.
GUARD="$(awk '/── Self-heal: always run origin\/main/{f=1} f{print} /── end self-heal/{f=0}' "${WRAPPER}")"
[ -n "${GUARD}" ] || { echo "FAIL: could not extract the self-heal block from ${WRAPPER}"; exit 1; }

# Build a fake PRIMARY_REPO git repo whose origin/main carries a wrapper whose
# body prints MAIN_BODY. The "local" copy prints LOCAL_BODY. Both embed the real
# guard block, so a re-exec into origin/main's copy surfaces MAIN_BODY.
FAKE_PRIMARY="${WORK}/primary"
FAKE_ORIGIN="${WORK}/origin.git"
mkdir -p "${FAKE_PRIMARY}/scripts"
git init -q --bare "${FAKE_ORIGIN}"
( cd "${FAKE_PRIMARY}" && git init -q && git remote add origin "${FAKE_ORIGIN}" \
    && git config user.email t@t && git config user.name t )

make_wrapper() {  # $1=body-marker  -> stdout
  printf '%s\n' '#!/usr/bin/env bash' 'set -uo pipefail' "PRIMARY_REPO=\"${FAKE_PRIMARY}\""
  printf '%s\n' "${GUARD}"
  printf '%s\n' "echo $1"
}

# origin/main version -> MAIN_BODY
make_wrapper MAIN_BODY > "${FAKE_PRIMARY}/scripts/sws-nightly-isolated.sh"
( cd "${FAKE_PRIMARY}" && git add -A && git commit -qm main && git push -q origin HEAD:main )

# local (stale) copy -> LOCAL_BODY, differs from origin/main
LOCAL="${WORK}/local-isolated.sh"
make_wrapper LOCAL_BODY > "${LOCAL}"

run() { env -i PATH="$PATH" HOME="$HOME" "$@" /bin/bash "${LOCAL}" 2>&1; }

# 1. differs -> re-exec into origin/main body
out="$(run)"
echo "$out" | grep -q "MAIN_BODY" && [ "$(echo "$out" | grep -c LOCAL_BODY)" = "0" ]
ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "stale local wrapper re-execs origin/main body" "-> ${out}"

# 2. loop guard
out="$(run SWS_NIGHTLY_REEXECED=1)"
echo "$out" | grep -q "LOCAL_BODY" && ! echo "$out" | grep -q "MAIN_BODY"
ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "SWS_NIGHTLY_REEXECED=1 suppresses re-exec" "-> ${out}"

# 3. escape hatch
out="$(run SWS_NIGHTLY_NO_REEXEC=1)"
echo "$out" | grep -q "LOCAL_BODY" && ! echo "$out" | grep -q "MAIN_BODY"
ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "SWS_NIGHTLY_NO_REEXEC=1 suppresses re-exec" "-> ${out}"

# 4. local == origin/main -> no re-exec (run the identical committed copy)
cp "${FAKE_PRIMARY}/scripts/sws-nightly-isolated.sh" "${WORK}/identical.sh"
out="$(env -i PATH="$PATH" HOME="$HOME" /bin/bash "${WORK}/identical.sh" 2>&1)"
echo "$out" | grep -q "MAIN_BODY" && ! echo "$out" | grep -q "re-exec'ing"
ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "identical copy runs in place (no re-exec)" "-> ${out}"

# 5. fail-open: origin/main unreachable (bogus PRIMARY_REPO) -> local body still runs
BADLOCAL="${WORK}/badprimary.sh"
sed "s#PRIMARY_REPO=\"${FAKE_PRIMARY}\"#PRIMARY_REPO=\"${WORK}/does-not-exist\"#" "${LOCAL}" > "${BADLOCAL}"
out="$(env -i PATH="$PATH" HOME="$HOME" /bin/bash "${BADLOCAL}" 2>&1)"
echo "$out" | grep -q "LOCAL_BODY"
ok "$([ $? -eq 0 ] && echo 1 || echo 0)" "unreachable origin/main falls through to local (fail-open)" "-> ${out}"

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
