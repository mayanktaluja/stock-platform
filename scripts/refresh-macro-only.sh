#!/usr/bin/env bash
#
# Standalone macro-regime refresh — single-writer for data/macroRegime.json.
#
# Fired every 2h by launchd (com.starbhai.macro-only). Decoupled from
# scripts/sws-nightly.sh after the 2026-05-17 incident: macro refresh kept
# bricking when sws-nightly's autostash failed on unrelated tracked files
# (.claude/launch.json conflicts, etc.). This wrapper does ONLY the macro
# refresh: ~30 seconds of work, minimal git surface, no coupling to the
# 30-min SWS scrape pipeline.
#
# Pipeline:
#   1. flock — prevent concurrent runs
#   2. Pre-flight guard — refuse to run if working tree has non-macro changes
#      (avoids accidentally committing user's WIP / a stuck nightly's state)
#   3. git fetch origin main + checkout temp branch at origin/main
#   4. node scripts/refresh-macro-regime.mjs
#   5. If file changed: branch + commit + push + open PR + auto-merge
#   6. Append to data/macroRegime-refresh.log
#
# Exit codes:
#   0  success or no-op (file unchanged, or refresh skipped due to local dirt)
#   2  LLM auth_error — fresh file written but providers degraded
#   5  git/network failure
#   8  push or PR creation failed
#   9  both LLM keys missing (file preserved)
#
# Usage (manual): bash scripts/refresh-macro-only.sh
# Install cron:   launchctl load -w ~/Library/LaunchAgents/com.starbhai.macro-only.plist

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK="/tmp/sws-macro-only-refresh.lock"
LOG_DIR="${REPO_DIR}/data"
LOG="${LOG_DIR}/macroRegime-refresh.log"

# flock prevents two crons racing on git index / the data file. Non-blocking
# (-n): if another run holds the lock, exit silently — the next 2h fire will
# pick up where this one left off.
exec 9>"${LOCK}"
if ! flock -n 9; then
  echo "[macro-only] another run holds the lock at $(date -u +'%Y-%m-%dT%H:%M:%SZ') — exiting"
  exit 0
fi

cd "${REPO_DIR}" || { echo "[macro-only] cannot cd to ${REPO_DIR}"; exit 5; }

# Load .env (LLM keys). Launchd starts with a near-empty environment, so
# without this `process.env.GROQ_API_KEY` would be undefined and the
# refresh would exit 9 without writing.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p "${LOG_DIR}"
exec >> >(tee -a "${LOG}") 2>&1

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
echo ""
echo "===== macro-only refresh starting $(ts) (pid=$$) ====="

# ---- 1. Pre-flight: refuse to commit if working tree has non-macro changes ----
#
# The standalone cron's whole point is "single writer for data/macroRegime.
# json" — never let it accidentally commit unrelated WIP or a stuck pipeline's
# state. If the tree is dirty with anything OTHER than the macro file, we
# refresh the file in place (so the local copy is current) but skip the
# commit. The next clean run (or sws-nightly's recovery) ships the commit.
OTHER_CHANGES=$(git status --porcelain | grep -v "data/macroRegime.json" | grep -cv "^$" || true)
if [ "${OTHER_CHANGES}" -gt 0 ]; then
  echo "[macro-only] working tree has ${OTHER_CHANGES} non-macro change(s) — refreshing file in place, skipping commit"
  node scripts/refresh-macro-regime.mjs 2>&1 | sed 's/^/[macro] /' || true
  echo "[macro-only] done (no commit) at $(ts)"
  exit 0
fi

# ---- 2. Sync to origin/main ----
if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git fetch failed — exit 5"
  exit 5
fi

# Move to a temp branch at origin/main (worktree-safe; does NOT touch
# the literal `main` branch ref, which may be held by a worktree).
if ! git checkout -B macro-only-base origin/main 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git checkout -B macro-only-base failed — exit 5"
  exit 5
fi

# ---- 3. Refresh ----
node scripts/refresh-macro-regime.mjs 2>&1 | sed 's/^/[macro] /'
MACRO_RC=$?

if [ "${MACRO_RC}" -ne 0 ] && [ "${MACRO_RC}" -ne 2 ]; then
  # Exit 0 = fresh write OK, 2 = fresh write with one LLM degraded.
  # Anything else means no fresh file was written.
  echo "[macro-only] refresh failed exit=${MACRO_RC} — no commit"
  exit "${MACRO_RC}"
fi

# ---- 4. Did the file actually change? ----
if [ -z "$(git status --porcelain data/macroRegime.json)" ]; then
  echo "[macro-only] no change in data/macroRegime.json — nothing to commit"
  exit 0
fi

# ---- 5. Commit + push + PR ----
DATE=$(date +'%Y-%m-%d')
TIME=$(date +'%H%M')
BRANCH="chore/macro-auto-refresh-${DATE}-${TIME}"

git branch -D "${BRANCH}" >/dev/null 2>&1 || true
if ! git checkout -b "${BRANCH}" 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git checkout -b ${BRANCH} failed — exit 5"
  exit 5
fi

git add data/macroRegime.json

# Pull the regime + provider out of the file for a useful commit message.
SUMMARY=$(node --input-type=module -e '
import {readFileSync} from "fs";
try {
  const r = JSON.parse(readFileSync("data/macroRegime.json", "utf-8"));
  process.stdout.write(`${r.regimeLabel || r.regime} (sev ${r.severity}, conf ${r.confidence}, ${r.classifierProvider})`);
} catch { process.stdout.write("classifier output"); }
' 2>/dev/null)

if ! git commit -m "chore(macro): auto-refresh ${DATE} ${TIME} — ${SUMMARY}

Standalone macro-only cron (com.starbhai.macro-only, every 2h). Decoupled
from sws-nightly per the 2026-05-17 permanent fix — single-writer rule for
data/macroRegime.json so a heavy-pipeline failure can no longer stale the
production macro banner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git commit failed — exit 5"
  exit 5
fi

if ! git push -u origin "${BRANCH}" 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git push failed — exit 8"
  exit 8
fi

PR_OUTPUT=$(gh pr create \
  --title "chore(macro): auto-refresh ${DATE} ${TIME} — ${SUMMARY}" \
  --body "Standalone macro-only cron. Decoupled from sws-nightly per the 2026-05-17 permanent fix.

Regime: ${SUMMARY}
Generated at: $(ts)

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>&1)
PR_URL=$(echo "${PR_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)

if [ -z "${PR_URL}" ]; then
  echo "[macro-only] gh pr create failed — branch pushed but no PR opened"
  echo "${PR_OUTPUT}" | sed 's/^/[gh] /'
  exit 8
fi

echo "[macro-only] PR opened: ${PR_URL}"

# Auto-merge: gh pr merge --auto requires repo branch protections to allow it.
# Try --auto first; if that fails (e.g., no required checks configured), fall
# back to immediate squash. --squash matches the repo convention.
gh pr merge "${PR_URL}" --squash --auto 2>&1 | sed 's/^/[gh] /' \
  || gh pr merge "${PR_URL}" --squash 2>&1 | sed 's/^/[gh] /' \
  || echo "[macro-only] gh pr merge failed — manual review required"

echo "===== macro-only refresh done $(ts) ====="
exit 0
