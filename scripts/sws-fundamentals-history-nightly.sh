#!/usr/bin/env bash
#
# Dedicated nightly refresh for fundamentalsHistory.json — Yahoo historical
# financials that feed the Earnings Watch tab's YoY-EPS-trajectory predictor
# component.
#
# This is a SEPARATE launchd job from sws-nightly.sh by design: the refresh
# is a ~30-min budget-capped Yahoo job (--max-fetches), so it has no business
# inside the daily SWS scrape. CLAUDE.md documents the cadence;
# scripts/com.starbhai.sws-fundamentals-history.plist is the schedule
# (04:00 IST daily — offset from the 16:30 sws-nightly fire so the
# two jobs don't contend).
#
# Pipeline:
#   1. Pre-flight  — panic flag, network reachable
#   2. git sync    — origin/main (worktree-safe, autostash)
#   3. refresh-fundamentals-history.mjs (budget-capped, 429-abortable)
#   4. commit + push fundamentalsHistory.json (only if it changed)
#   5. gh pr create + gh pr merge --auto --squash
#   6. mail summary
#
# Usage:
#   bash scripts/sws-fundamentals-history-nightly.sh           # full run
#   bash scripts/sws-fundamentals-history-nightly.sh --dry-run # setup smoke, no side effects
#
# Exit codes:
#   0  success / no-op / dry-run
#   3  panic flag set
#   5  git/network failure
#   8  push or PR creation failed

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
cd "${REPO_DIR}" || { echo "[fh-nightly] cannot cd to ${REPO_DIR}"; exit 5; }

LOG="data/sws/fundamentals-history-nightly.log"
LOG_PATH="${REPO_DIR}/${LOG}"
mkdir -p data/sws
exec >> >(tee -a "${LOG}") 2>&1

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }
START_EPOCH="$(date +%s)"

# ---- Slack failure trap (P3.3) ----
#
# Catch-all for any non-zero exit — including signals, uncaught `set -u` /
# `set -o pipefail` triggers, and crashes that happen BEFORE the existing
# send_mail handlers run. Silent no-op when SLACK_WEBHOOK_URL is unset (the
# common case for interactive runs).
#
# Installed EARLY so a pre-flight or git-sync failure still alerts. Cleared
# at every clean exit (success, dry-run, no-op) so those paths don't fire it.
# The mid-script `exit N` paths DO fire this trap by design.
slack_notify_on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ]; then
    bash "${REPO_DIR}/scripts/slack-notify.sh" \
      ":warning: fundamentalsHistory nightly (sws-fundamentals-history-nightly.sh) failed at $(ts) with exit code ${rc} — see ${LOG_PATH}" \
      >/dev/null 2>&1 || true
  fi
}
trap slack_notify_on_exit EXIT

# Portable timeout wrapper — same chain as sws-nightly.sh (gtimeout on macOS
# via Homebrew coreutils, timeout on Linux, no-op fallback on stock macOS).
if command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
elif command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
else
  with_timeout() { shift; "$@"; }
fi

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
[ "${SWS_FH_NIGHTLY_DRY_RUN:-0}" = "1" ] && DRY_RUN=1

AUTO_MERGE="${SWS_NIGHTLY_AUTO_MERGE:-1}"

echo
echo "============================================================"
echo "  fundamentalsHistory nightly started: $(ts) (pid=$$, dry_run=${DRY_RUN})"
echo "============================================================"

# ---- helper: send mail (non-fatal if it fails) ----
send_mail() {
  local subject="$1"; local body="$2"
  if [ -f scripts/sws-mail-summary.mjs ]; then
    printf "%s" "${body}" | node scripts/sws-mail-summary.mjs "${subject}" - 2>&1 | sed 's/^/[mail] /' || true
  fi
}

# Dry run short-circuits here: it confirms the script parses and the helper
# setup runs, then exits before touching the network or git. No side effects.
if [ ${DRY_RUN} -eq 1 ]; then
  echo "[fh-nightly] DRY RUN — setup OK; skipping pre-flight, git sync, refresh, commit, PR"
  echo "[fh-nightly] DRY RUN done in $(($(date +%s) - START_EPOCH))s"
  trap - EXIT  # dry-run success — don't fire Slack failure trap
  exit 0
fi

# ---- 1. Pre-flight ----

if [ -f data/sws/panic-stop.flag ]; then
  echo "[fh-nightly] PANIC flag set — refusing to run"
  exit 3
fi

if ! ping -c 1 -t 5 8.8.8.8 >/dev/null 2>&1; then
  echo "[fh-nightly] network unreachable — bailing"
  send_mail "🚨 fundamentalsHistory nightly aborted — network unreachable" "ping 8.8.8.8 failed at $(ts)"
  exit 5
fi

# ---- 2. git sync (worktree-safe — mirrors sws-nightly.sh) ----

echo "[fh-nightly] syncing main..."
if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then
  echo "[fh-nightly] git fetch failed"
  send_mail "🚨 fundamentalsHistory nightly aborted — git fetch failed" "git fetch origin main failed at $(ts)."
  exit 5
fi

# Genuine-unpushed-work guard — measure the `main` ref (not HEAD) against
# origin/main, so a leftover auto-refresh branch can't false-positive.
LOCAL_AHEAD="$(git rev-list --count origin/main..main 2>/dev/null || echo 0)"
if [ "${LOCAL_AHEAD}" -gt 0 ]; then
  echo "[fh-nightly] local main ref is ${LOCAL_AHEAD} commit(s) ahead of origin/main — refusing to run"
  send_mail "🚨 fundamentalsHistory nightly aborted — local main has unpushed commits" \
"Local main is ${LOCAL_AHEAD} commit(s) ahead of origin/main at $(ts). Push or reset main manually."
  exit 5
fi

# Autostash any dirty working-tree state before moving the working copy.
STASH_TAG="fh-nightly-autostash-$(date +%s)"
STASHED=0
if [ -n "$(git status --porcelain)" ]; then
  echo "[fh-nightly] working tree dirty — autostashing as ${STASH_TAG}"
  if git stash push --include-untracked -m "${STASH_TAG}" 2>&1 | sed 's/^/[git] /'; then
    STASHED=1
  else
    send_mail "🚨 fundamentalsHistory nightly aborted — autostash failed" "git stash push failed at $(ts)."
    exit 5
  fi
fi

# Worktree-safe checkout: -B a dedicated base branch at origin/main rather
# than `git checkout main` (a worktree may hold the main ref). The branch
# name is distinct from sws-nightly.sh's `sws-nightly-base` so the two jobs
# never contend over a shared ref.
if ! git checkout -B fh-nightly-base origin/main 2>&1 | sed 's/^/[git] /'; then
  echo "[fh-nightly] could not check out fh-nightly-base at origin/main"
  [ "${STASHED}" -eq 1 ] && { git stash pop 2>&1 | sed 's/^/[git] /' || true; }
  send_mail "🚨 fundamentalsHistory nightly aborted — git checkout failed" "git checkout -B fh-nightly-base origin/main failed at $(ts)."
  exit 5
fi

if [ "${STASHED}" -eq 1 ]; then
  if ! git stash pop 2>&1 | sed 's/^/[git] /'; then
    echo "[fh-nightly] stash pop conflicted — stash ${STASH_TAG} left on list"
    send_mail "⚠️ fundamentalsHistory nightly — autostash pop conflicted" \
"Autostash ${STASH_TAG} could not be popped cleanly at $(ts). Pipeline continued — recover with git stash list / git stash apply."
  fi
fi

# ---- 3. Refresh ----
#
# Budget-capped (--max-fetches 1800) so a full-universe catch-up spreads
# across nights instead of blowing Yahoo's ~2000/day soft ceiling. The
# script exits 0 even on a clean 429 abort (partial progress saved
# atomically); exit 1 is fatal. Non-fatal here either way — we still reach
# the commit step with whatever progress landed.
echo "[fh-nightly] running refresh-fundamentals-history.mjs..."
if ! with_timeout 2400 node scripts/refresh-fundamentals-history.mjs --max-fetches 1800 2>&1 | sed 's/^/[fh] /'; then
  echo "[fh-nightly] refresh-fundamentals-history.mjs exited non-zero — non-fatal, committing any partial progress"
fi

# ---- 4. Commit (only if the file changed) ----

DATE=$(date +%Y-%m-%d)
RUN_TIME=$(date +%H%M)
RUN_LABEL="${DATE} ${RUN_TIME:0:2}:${RUN_TIME:2:2}"

if [ -z "$(git status --short fundamentalsHistory.json)" ]; then
  echo "[fh-nightly] fundamentalsHistory.json unchanged — nothing to commit"
  send_mail "ℹ️ fundamentalsHistory nightly — no changes" "Refresh ran clean but fundamentalsHistory.json did not change at $(ts) (universe already fresh)."
  echo "[fh-nightly] DONE in $(($(date +%s) - START_EPOCH))s"
  trap - EXIT  # clean no-op exit — don't fire Slack failure trap
  exit 0
fi

BRANCH="chore/fundamentals-history-${DATE}-${RUN_TIME}"
git branch -D "${BRANCH}" >/dev/null 2>&1 || true
if ! git checkout -b "${BRANCH}" 2>&1 | sed 's/^/[git] /'; then
  echo "[fh-nightly] could not create branch ${BRANCH}"
  send_mail "🚨 fundamentalsHistory nightly — git checkout -b failed" "git checkout -b ${BRANCH} failed at $(ts)."
  exit 8
fi

# Stage ONLY fundamentalsHistory.json — never a stray dirty file.
git add fundamentalsHistory.json

# Headline stats for the commit / PR body.
FH_STATS=$(node --input-type=module -e '
import {readFileSync} from "fs";
try {
  const j = JSON.parse(readFileSync("fundamentalsHistory.json", "utf-8"));
  console.log(`${Object.keys(j.stocks || {}).length} stocks with history · generatedAt ${j.generatedAt || "unknown"}`);
} catch { console.log("counts unavailable (fundamentalsHistory.json unparseable at body-build time)"); }
' 2>/dev/null)
FH_STATS="${FH_STATS:-counts unavailable}"

COMMIT_BODY="Automated nightly refresh via launchd — its own job
(com.starbhai.sws-fundamentals-history), never chained into sws-nightly.sh.

- ${FH_STATS}
- budget-capped at 1800 Yahoo calls/run; overflow deferred to the next run"

git commit -m "chore(fundamentals): nightly fundamentalsHistory refresh ${RUN_LABEL}

${COMMIT_BODY}

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>" 2>&1 | sed 's/^/[git] /'

if ! git push -u origin "${BRANCH}" 2>&1 | sed 's/^/[git] /'; then
  echo "[fh-nightly] git push failed"
  send_mail "🚨 fundamentalsHistory nightly — git push failed" "Commit succeeded but git push origin ${BRANCH} failed at $(ts)."
  exit 8
fi

# ---- 5. PR + auto-merge ----

PR_OUTPUT=$(gh pr create \
  --title "chore(fundamentals): nightly fundamentalsHistory refresh ${RUN_LABEL}" \
  --body "Automated fundamentalsHistory.json refresh from launchd — com.starbhai.sws-fundamentals-history, its own daily job, never chained into sws-nightly.sh.

${COMMIT_BODY}" 2>&1)
PR_RC=$?
PR_URL=$(echo "${PR_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)

if [ ${PR_RC} -ne 0 ] || [ -z "${PR_URL}" ]; then
  echo "[fh-nightly] gh pr create failed: ${PR_OUTPUT}"
  send_mail "🚨 fundamentalsHistory nightly — gh pr create failed" "Branch ${BRANCH} pushed but PR creation failed at $(ts).

${PR_OUTPUT}"
  exit 8
fi

echo "[fh-nightly] PR created: ${PR_URL}"

if [ "${AUTO_MERGE}" = "1" ]; then
  # No --delete-branch: its local cleanup fails when a worktree holds main
  # (cf. sws-nightly.sh #218); the repo's delete_branch_on_merge handles the
  # remote side.
  if ! gh pr merge "${PR_URL}" --squash --auto 2>&1 | sed 's/^/[gh] /'; then
    echo "[fh-nightly] --auto failed, attempting immediate squash-merge..."
    gh pr merge "${PR_URL}" --squash 2>&1 | sed 's/^/[gh] /' || \
      echo "[fh-nightly] both auto and immediate merge failed — manual merge required"
  fi
else
  echo "[fh-nightly] AUTO_MERGE=0 — leaving PR open for manual review"
fi

# ---- 6. Mail summary ----

ELAPSED=$(($(date +%s) - START_EPOCH))
send_mail "✅ fundamentalsHistory refresh OK — ${RUN_LABEL} ($((ELAPSED/60))m)" "fundamentalsHistory.json refreshed at $(ts) in $((ELAPSED/60))m $((ELAPSED%60))s.

PR: ${PR_URL}
Branch: ${BRANCH}

${COMMIT_BODY}

Vercel will redeploy main once CI is green."

echo "[fh-nightly] DONE in ${ELAPSED}s ($(ts))"

# Successful run — clear the Slack failure trap so the final `exit 0` doesn't
# fire it. Mid-script `exit N` paths (panic flag, network, push failure, etc.)
# still trigger the trap by design.
trap - EXIT
exit 0
