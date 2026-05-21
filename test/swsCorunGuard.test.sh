#!/usr/bin/env bash
#
# Smoke test for the shared SWS co-run guard (scripts/sws-corun-guard.sh).
#
# All four markets (India / US / Korea / Taiwan) share ONE Simply Wall St
# account + cf_clearance cookie, so corun_guard() refuses (exit 5) if ANY
# OTHER market's scraper or orchestrator is live. The matching is a
# `ps -A -o command=` substring grep, which used to be too loose: on
# 2026-05-21 a `gh pr create … --body '…sws-refresh-api.sh…'` (the PR body
# merely *quoted* the script name) tripped the India pattern, so a real
# /sws-refresh-us|kr|tw refused with a phantom "India scrape running".
#
# The fix anchors each pattern to an actual invocation (`node …scrape….mjs`
# / `bash …refresh….sh`) AND excludes read-only tooling that mentions the
# names (`gh pr` / `pr create` / `--body` / `sws-status`, plus the guard's
# own grep). This test feeds synthetic `ps` output via the
# SWS_CORUN_PS_OVERRIDE seam and asserts both that real scrapes still trip
# the guard (no false negatives) and that the incidental mentions do not
# (no false positives — the regression we're locking).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/sws-corun-guard.sh
. "${REPO_ROOT}/scripts/sws-corun-guard.sh"

PASS=0
FAIL=0
pass() { echo "  ok: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

# check <desc> <self-market> <want-rc> <fake-ps-output>
# Feeds <fake-ps-output> to the guard as the process table, runs
# `corun_guard <self-market>`, and asserts the return code.
check() {
  local desc="$1" self="$2" want="$3" ps="$4" got
  SWS_CORUN_PS_OVERRIDE="${ps}"
  corun_guard "${self}" >/dev/null 2>&1
  got=$?
  unset SWS_CORUN_PS_OVERRIDE
  if [ "${got}" -eq "${want}" ]; then
    pass "${desc} (rc=${got})"
  else
    fail "${desc} — want rc=${want}, got rc=${got}"
  fi
}

echo "swsCorunGuard.test.sh: testing the shared SWS co-run guard..."

# --- Positive controls: a live scrape/orchestrator MUST make OTHER markets refuse (rc 5) ---
check "india shard live  → US refuses"          us 5 "node scripts/sws-api-scrape.mjs 1"
check "india orchestrator → KR refuses"         kr 5 "bash scripts/sws-refresh-api.sh"
check "US shard live     → India refuses"       in 5 "node scripts/sws-api-scrape-us.mjs 2"
check "US orchestrator   → TW refuses"          tw 5 "bash scripts/sws-refresh-us.sh"
check "KR shard live     → TW refuses"          tw 5 "node scripts/sws-api-scrape-region.mjs --region kr --shard 1"
check "KR orchestrator   → India refuses"       in 5 "bash scripts/sws-refresh-region.sh kr"
check "TW shard live     → KR refuses"          kr 5 "node scripts/sws-api-scrape-region.mjs --region tw --shard 3"

# --- Self-skip + cross-market non-collision: a market never refuses against itself (rc 0) ---
check "india shard live  → India allows itself" in 0 "node scripts/sws-api-scrape.mjs 1"
check "KR shard live     → KR allows itself"    kr 0 "node scripts/sws-api-scrape-region.mjs --region kr --shard 1"
# Self-skip for US doubles as a non-collision lock: the india/kr/tw patterns
# must NOT match `sws-api-scrape-us.mjs` (it's `-us.mjs`, not `.mjs`/`-region.mjs`).
check "US shard live     → US allows itself"    us 0 "node scripts/sws-api-scrape-us.mjs 1"

# --- The headline false-positives (the 2026-05-21 bug) — these MUST allow (rc 0) ---
# 11: bare filename mention in a PR body — the anchor alone defeats it (no `bash`/`node` invocation prefix).
check "gh pr body quotes script  → US allows (anchor)" \
  us 0 "gh pr create --base main --title fix --body tighten the guard in scripts/sws-refresh-api.sh and mirror it"
# 12: PR body literally contains 'bash scripts/sws-refresh-api.sh' — anchor WOULD match, so the exclusion must catch it.
check "gh pr body has 'bash …api.sh' → US allows (exclusion)" \
  us 0 "gh pr create --body run bash scripts/sws-refresh-api.sh nightly"
# 13: same class from a region market.
check "gh pr body has 'bash …api.sh' → KR allows (exclusion)" \
  kr 0 "gh pr create --body see scripts/sws-refresh-region.sh and run bash scripts/sws-refresh-api.sh"

# --- Exclusion-token coverage (each line matches a pattern but is dropped) ---
# 14: the guard's own grep subprocess (or any grep quoting the invocation) is excluded by `grep`.
check "grep subprocess mentioning invocation → US allows" \
  us 0 "grep --color=auto -E bash scripts/sws-refresh-api.sh"
# 15: a read-only sws-status monitor that carries an invocation token is excluded by `sws-status`.
check "sws-status monitor mentioning invocation → US allows" \
  us 0 "node scripts/sws-status-probe.mjs watching bash scripts/sws-refresh-api.sh"

# --- Clean table: no SWS processes at all → allow ---
check "no SWS processes → US allows" us 0 "$(printf 'node server.js\n/usr/sbin/cron\n-zsh')"

# --- Refusal message names the offending command (operator UX) ---
SWS_CORUN_PS_OVERRIDE='node scripts/sws-api-scrape.mjs 1'
msg_out="$(corun_guard us 2>&1 || true)"
unset SWS_CORUN_PS_OVERRIDE
if echo "${msg_out}" | grep -q 'REFUSING (us)' && echo "${msg_out}" | grep -q 'sws-api-scrape\.mjs'; then
  pass "refusal prints REFUSING + the offending command"
else
  fail "refusal message missing expected content: ${msg_out}"
fi

echo ""
if [ "${FAIL}" -eq 0 ]; then
  echo "swsCorunGuard.test.sh: PASS (${PASS} cases)"
  exit 0
else
  echo "swsCorunGuard.test.sh: FAIL (${FAIL} of $((PASS + FAIL)) cases)"
  exit 1
fi
