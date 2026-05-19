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
#   1. PID-mkdir lock — prevent concurrent runs
#   2. git fetch origin main + `git worktree prune` (sweep stale corpses)
#   3. mktemp -d + `git worktree add --detach origin/main` — isolated, always
#      clean working tree, independent of whatever's in the user's main
#      worktree. This replaces the old pre-flight "refuse if tree is dirty"
#      guard, which was silently skipping every commit because the main
#      worktree always had unrelated dirt (worktree artifacts, test outputs).
#   4. node scripts/refresh-macro-regime.mjs (inside the temp worktree)
#   5. Idempotency gate — skip if the existing committed file is <30min old
#      AND the just-written generatedAt is <30min old (race-safe against
#      the GH Actions backup workflow)
#   6. If file changed: branch + commit + push + open PR + auto-merge
#   7. Trap-cleanup removes the temp worktree on every exit path
#
# Exit codes:
#   0  success or no-op (file unchanged, idempotency skip, etc.)
#   2  LLM auth_error — fresh file written but providers degraded
#   5  git/network failure
#   8  push or PR creation failed
#   9  both LLM keys missing (file preserved)
#
# Usage (manual): bash scripts/refresh-macro-only.sh
# Install cron:   launchctl load -w ~/Library/LaunchAgents/com.starbhai.macro-only.plist

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK_DIR="/tmp/sws-macro-only-refresh.lock.d"
LOG_DIR="${REPO_DIR}/data"
LOG="${LOG_DIR}/macroRegime-refresh.log"

# PID-based mkdir lock — portable replacement for flock. macOS doesn't ship
# flock(1), which was causing the cron to silently exit "another run holds
# the lock" every 2h and leave data/macroRegime.json 19h+ stale (incident
# 2026-05-18). mkdir is atomic on every POSIX filesystem; the PID file +
# kill -0 check distinguishes a live holder from a stale lockdir left by
# a process that died without trap cleanup (SIGKILL, OOM, launchd kill -9).
#
# Hostname is stored alongside the PID because launchd job labels can be
# scheduled on multiple machines if the user ever sets that up — a PID
# from a different host is treated as foreign and stale.
cleanup_lock() {
  rm -f "${LOCK_DIR}/pid" 2>/dev/null
  rmdir "${LOCK_DIR}" 2>/dev/null
}

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$@$(hostname)" > "${LOCK_DIR}/pid"
    trap cleanup_lock EXIT INT TERM HUP
    return 0
  fi
  if [ -f "${LOCK_DIR}/pid" ]; then
    local pid_line lock_pid lock_host
    pid_line=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    lock_pid="${pid_line%@*}"
    lock_host="${pid_line#*@}"
    if [ -n "${lock_pid}" ] && [ "${lock_host}" = "$(hostname)" ] && kill -0 "${lock_pid}" 2>/dev/null; then
      return 1
    fi
    echo "[macro-only] stale lock from ${pid_line:-<unknown>} — clearing"
    cleanup_lock
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
      echo "$$@$(hostname)" > "${LOCK_DIR}/pid"
      trap cleanup_lock EXIT INT TERM HUP
      return 0
    fi
  fi
  return 1
}

if ! acquire_lock; then
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

# ---- 1. Sweep stale worktrees from prior crashed runs ----
# A prior macro-only run may have left a worktree registered if it was
# killed with SIGKILL or the host rebooted between worktree-add and
# worktree-remove. `git worktree prune` deletes the metadata for any
# worktree whose path no longer exists; idempotent and cheap.
git worktree prune 2>&1 | sed 's/^/[git] /' || true

# ---- 2. Sync to origin/main ----
if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git fetch failed — exit 5"
  exit 5
fi

# ---- 3. Spin up an isolated worktree at origin/main ----
# The temp worktree is always clean by construction — the user's main
# working tree can be arbitrarily dirty (worktree artifacts, untracked
# test outputs, half-staged work) without bricking the refresh. This is
# what replaced the old pre-flight dirty-tree guard (incident 2026-05-19:
# the guard silently skipped every commit for ~42h because the main tree
# never went clean).
if ! WORKTREE_DIR=$(mktemp -d -t macro-refresh) || [ -z "${WORKTREE_DIR}" ]; then
  echo "[macro-only] mktemp -d failed — exit 5"
  exit 5
fi

cleanup_worktree() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "${WORKTREE_DIR}" ]; then
    cd "${REPO_DIR}" 2>/dev/null || true
    git worktree remove --force "${WORKTREE_DIR}" 2>/dev/null \
      || rm -rf "${WORKTREE_DIR}" 2>/dev/null \
      || true
  fi
}
cleanup_all() { cleanup_worktree; cleanup_lock; }
trap cleanup_all EXIT INT TERM HUP

if ! git worktree add --detach "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then
  echo "[macro-only] git worktree add failed — exit 5"
  exit 5
fi

cd "${WORKTREE_DIR}" || { echo "[macro-only] cannot cd to ${WORKTREE_DIR}"; exit 5; }
echo "[macro-only] isolated worktree at ${WORKTREE_DIR} (detached at origin/main)"

# Symlink node_modules from the main checkout — `git worktree add` gives us
# a fresh tracked-files-only working dir without gitignored content, but
# the refresh script imports `dotenv` and other deps. Re-running `npm ci`
# would cost ~30s every fire; a symlink is instant and the deps are
# identical (both checkouts share the same lockfile).
if [ -d "${REPO_DIR}/node_modules" ]; then
  ln -snf "${REPO_DIR}/node_modules" "${WORKTREE_DIR}/node_modules"
else
  echo "[macro-only] WARN: ${REPO_DIR}/node_modules missing — dependency imports will fail"
fi

# ---- 4. Refresh ----
node scripts/refresh-macro-regime.mjs 2>&1 | sed 's/^/[macro] /'
MACRO_RC=$?

if [ "${MACRO_RC}" -ne 0 ] && [ "${MACRO_RC}" -ne 2 ]; then
  # Exit 0 = fresh write OK, 2 = fresh write with one LLM degraded.
  # Anything else means no fresh file was written.
  echo "[macro-only] refresh failed exit=${MACRO_RC} — no commit"
  exit "${MACRO_RC}"
fi

# ---- 5. Did the file actually change? ----
if [ -z "$(git status --porcelain data/macroRegime.json)" ]; then
  echo "[macro-only] no change in data/macroRegime.json — nothing to commit"
  exit 0
fi

# ---- 6. Idempotency gate ----
# Skip the commit if both signals say "recently refreshed":
#   (a) origin/main's last commit touching data/macroRegime.json is <30min old
#   (b) the just-written file's generatedAt is <30min old
# Either condition by itself isn't sufficient — (a) without (b) could mean
# a stale commit + a genuine fresh refresh; (b) without (a) means we DO
# need to commit. Both together = a concurrent refresher already shipped
# fresh data, so this run is a no-op duplicate. Race-safe vs. the GH
# Actions backup workflow.
LAST_COMMIT_TS=$(git log -1 --format=%ct origin/main -- data/macroRegime.json 2>/dev/null || echo 0)
NOW_TS=$(date +%s)
LAST_COMMIT_AGE_MIN=$(( (NOW_TS - LAST_COMMIT_TS) / 60 ))

GEN_AGE_MIN=$(node --input-type=module -e '
import {readFileSync} from "fs";
try {
  const r = JSON.parse(readFileSync("data/macroRegime.json","utf-8"));
  const gen = new Date(r.generatedAt).getTime();
  process.stdout.write(String(Math.round((Date.now()-gen)/60000)));
} catch { process.stdout.write("999999"); }
' 2>/dev/null || echo 999999)

if [ "${LAST_COMMIT_AGE_MIN}" -lt 30 ] && [ "${GEN_AGE_MIN}" -lt 30 ]; then
  echo "[macro-only] idempotency skip: last commit ${LAST_COMMIT_AGE_MIN}m ago, generatedAt ${GEN_AGE_MIN}m old"
  exit 0
fi
echo "[macro-only] idempotency: last commit ${LAST_COMMIT_AGE_MIN}m ago, generatedAt ${GEN_AGE_MIN}m old — committing"

# ---- 7. Commit + push + PR ----
DATE=$(date +'%Y-%m-%d')
TIME=$(date +'%H%M')
BRANCH="chore/macro-auto-refresh-${DATE}-${TIME}"

# Worktree HEAD is detached; create a fresh branch from it for the push.
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

Standalone macro-only cron (com.starbhai.macro-only, every 2h). Refreshed
inside an isolated git worktree at origin/main so the commit is
independent of whatever state the user's main worktree is in — fixes the
2026-05-19 incident where the pre-flight dirty-tree guard was silently
skipping every commit for ~42h because the main tree always had
unrelated dirt (worktree artifacts, untracked outputs).

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
  --body "Standalone macro-only cron, isolated-worktree path.

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

# Auto-merge: try --auto first (waits on CI if branch protections exist);
# fall back to immediate squash. --squash matches the repo convention.
gh pr merge "${PR_URL}" --squash --auto 2>&1 | sed 's/^/[gh] /' \
  || gh pr merge "${PR_URL}" --squash 2>&1 | sed 's/^/[gh] /' \
  || echo "[macro-only] gh pr merge failed — manual review required"

echo "===== macro-only refresh done $(ts) ====="
exit 0
