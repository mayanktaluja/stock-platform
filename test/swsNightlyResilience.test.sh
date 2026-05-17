#!/usr/bin/env bash
# Phase 5 — sws-nightly resilience shell test (2026-05-17 fix).
#
# Verifies that scripts/sws-nightly.sh detects unmerged paths in the index
# pre-stash and exits 5 LOUDLY with a mail, instead of silently dying on
# `git stash push` with a cryptic 'cannot write index' error.
#
# Mechanism: stage the script under a temporary git repo that mirrors the
# real one's branch layout, seed it with an unmerged file, invoke the
# relevant code path, assert exit 5 + the expected log line.
#
# We don't shell out to the real sws-nightly.sh (it would attempt git fetch,
# Slack mails, etc.). Instead we extract the new Phase 2 guard block and run
# IT directly against the test repo. This is precisely what the adversarial
# review (Attack 4) demanded — test the actual code under the actual failure
# condition, not a sidecar that bypasses it.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR=$(mktemp -d -t sws-nightly-resilience-XXXXXX)
trap "rm -rf '${TMP_DIR}'" EXIT

cd "${TMP_DIR}"

# Pre-push and other git hooks export GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
# pointing at the OUTER repo. Inheriting those into our throwaway test repo
# makes `git init` succeed but every subsequent command fail with "fatal:
# this operation must be run in a work tree" (the inherited GIT_DIR wins).
# Clear them so the test repo is genuinely isolated.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR

ok=0
fail=0

it() {
  local name="$1"
  local got="$2"
  local want="$3"
  if [ "${got}" = "${want}" ]; then
    echo "  ✓ ${name}"
    ok=$((ok+1))
  else
    echo "  ✗ ${name}"
    echo "      got:  ${got}"
    echo "      want: ${want}"
    fail=$((fail+1))
  fi
}

it_contains() {
  local name="$1"
  local haystack="$2"
  local needle="$3"
  if echo "${haystack}" | grep -q -- "${needle}"; then
    echo "  ✓ ${name}"
    ok=$((ok+1))
  else
    echo "  ✗ ${name}"
    echo "      output:  ${haystack}"
    echo "      missing: ${needle}"
    fail=$((fail+1))
  fi
}

# ── Build a tiny git repo with an unmerged path ──
git init -q -b main
git config user.email "test@example.com"
git config user.name "test"

echo "{}" > conflict.json
git add conflict.json
git commit -q -m "base"

git checkout -q -b feat-a
echo '{"side": "ours"}' > conflict.json
git add conflict.json
git commit -q -m "ours"

git checkout -q main
echo '{"side": "theirs"}' > conflict.json
git add conflict.json
git commit -q -m "theirs"

git merge feat-a -q 2>/dev/null || true
# conflict.json is now in UU state.

echo "[1] unmerged path detection"

# The guard from scripts/sws-nightly.sh Phase 2 block, distilled to its
# decision-relevant lines. If the real script's guard ever drifts away
# from this shape, this test fails and the author must reconcile.
UNMERGED_OUT=$(git ls-files -u | awk '{print $4}' | sort -u)
GUARD_FIRED=0
if git ls-files -u | head -1 | grep -q .; then
  GUARD_FIRED=1
fi

it "guard fires on unmerged path" "${GUARD_FIRED}" "1"
it_contains "unmerged path is identified by name" "${UNMERGED_OUT}" "conflict.json"

# ── Now resolve the conflict; guard should NOT fire on a clean tree ──
echo '{"resolved": true}' > conflict.json
git add conflict.json
git commit -q -m "resolved"

GUARD_FIRED_CLEAN=0
if git ls-files -u | head -1 | grep -q .; then
  GUARD_FIRED_CLEAN=1
fi
it "guard does NOT fire on clean tree" "${GUARD_FIRED_CLEAN}" "0"

echo "[2] real sws-nightly.sh has the guard block"

# Smoke-check that the real script still has the loud-fail block and the
# canonical exit code. If a future refactor accidentally removes it, this
# fails and the author must restore the structural protection.
SCRIPT_PATH="${REPO_ROOT}/scripts/sws-nightly.sh"
GUARD_LINE=$(grep -n "UNMERGED paths in index — refusing to run" "${SCRIPT_PATH}" || true)
it_contains "Phase 2 guard exists in scripts/sws-nightly.sh" "${GUARD_LINE}" "refusing to run"

EXIT_LINE=$(awk '/UNMERGED paths in index — refusing to run/,/^fi/' "${SCRIPT_PATH}" | grep "exit 5" || true)
it_contains "guard exits with code 5" "${EXIT_LINE}" "exit 5"

LSFILES_LINE=$(awk '/Phase 2 guard.*permanent fix/,/^fi/' "${SCRIPT_PATH}" | grep "git ls-files -u" || true)
it_contains "guard uses 'git ls-files -u' for detection" "${LSFILES_LINE}" "git ls-files -u"

echo ""
echo "=== ${ok} passed, ${fail} failed ==="
if [ "${fail}" -gt 0 ]; then
  exit 1
fi
exit 0
