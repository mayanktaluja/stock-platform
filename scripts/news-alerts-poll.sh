#!/usr/bin/env bash
#
# Watchlist news poller wrapper — fast-news-alerts Phase 2.
#
# Fired ~every 30 min during IST market hours by launchd
# (com.starbhai.news-alerts). It reads RSS, matches against
# data/alerts/watchlist.json, dedups via the sent-ledger, and sends Telegram.
# It commits NOTHING.
#
# Why a worktree (and why this is NOT the H1 race): the canonical checkout at
# REPO_DIR can be parked on any feature branch (e.g. a parallel Codex session),
# so running the poller's CODE in-place would break the moment that checkout
# isn't on main. We therefore run the code from a short-lived detached worktree
# pinned to origin/main — same proven pattern as refresh-macro-only.sh — but
# we deliberately do NOT call `git worktree prune` (the operation H1 flagged as
# racing the macro cron's worktree). Each run adds its own mktemp worktree and
# removes exactly that one on exit.
#
# The sent-ledger must survive across runs, so it is pinned to the CANONICAL
# repo via ALERTS_LEDGER_DIR (absolute) — NOT the throwaway worktree, where it
# would vanish (adversarial C2).
#
# Own PID-lock dir, distinct from /tmp/sws-macro-only-refresh.lock.d.
#
# Usage (manual): bash scripts/news-alerts-poll.sh [--dry-run]

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK_DIR="/tmp/starbhai-news-alerts.lock.d"
LOG="${REPO_DIR}/data/news-alerts-poll.log"
LEDGER_DIR="${REPO_DIR}/data/alerts"   # canonical, persists across runs (C2)

cleanup_lock() { rm -f "${LOCK_DIR}/pid" 2>/dev/null; rmdir "${LOCK_DIR}" 2>/dev/null; }

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$@$(hostname)" > "${LOCK_DIR}/pid"
    trap cleanup_lock EXIT INT TERM HUP
    return 0
  fi
  if [ -f "${LOCK_DIR}/pid" ]; then
    local pid_line lock_pid lock_host
    pid_line=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    lock_pid="${pid_line%@*}"; lock_host="${pid_line#*@}"
    if [ -n "${lock_pid}" ] && [ "${lock_host}" = "$(hostname)" ] && kill -0 "${lock_pid}" 2>/dev/null; then
      return 1
    fi
    echo "[news-alerts] stale lock from ${pid_line:-<unknown>} — clearing"
    cleanup_lock
    mkdir "${LOCK_DIR}" 2>/dev/null && { echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; }
  fi
  return 1
}

if ! acquire_lock; then
  echo "[news-alerts] another run holds the lock — exiting"
  exit 0
fi

cd "${REPO_DIR}" || { echo "[news-alerts] cannot cd to ${REPO_DIR}"; exit 0; }

# Load .env (TG_* + LLM keys). launchd starts near-empty; without this the
# alert path self-skips silently.
if [ -f .env ]; then set -a; source .env; set +a; fi

mkdir -p "${REPO_DIR}/data" "${LEDGER_DIR}"
exec >> >(tee -a "${LOG}") 2>&1
echo "===== news-alerts poll $(date -u +'%Y-%m-%dT%H:%M:%SZ') (pid=$$) ====="

# Pin code to origin/main via an isolated worktree (branch-independent of the
# user's checkout). No `git worktree prune` — that's the H1 race. Ledger stays
# canonical via ALERTS_LEDGER_DIR.
if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then
  echo "[news-alerts] git fetch failed — exiting (no stale send)"; exit 0
fi
if ! WORKTREE_DIR=$(mktemp -d -t news-alerts) || [ -z "${WORKTREE_DIR}" ]; then
  echo "[news-alerts] mktemp -d failed — exiting"; exit 0
fi
cleanup_all() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "${WORKTREE_DIR}" ]; then
    cd "${REPO_DIR}" 2>/dev/null || true
    git worktree remove --force "${WORKTREE_DIR}" 2>/dev/null || rm -rf "${WORKTREE_DIR}" 2>/dev/null || true
  fi
  cleanup_lock
}
trap cleanup_all EXIT INT TERM HUP

if ! git worktree add --detach "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then
  echo "[news-alerts] git worktree add failed — exiting"; exit 0
fi
# Symlink node_modules (worktree has tracked files only; the poller imports dotenv etc.)
[ -d "${REPO_DIR}/node_modules" ] && ln -snf "${REPO_DIR}/node_modules" "${WORKTREE_DIR}/node_modules"

cd "${WORKTREE_DIR}" || { echo "[news-alerts] cannot cd to worktree"; exit 0; }
ALERTS_LEDGER_DIR="${LEDGER_DIR}" node scripts/refresh-news-alerts.mjs "$@" 2>&1 | sed 's/^/[news] /'

# Always exit 0 — a poll failure is not worth alerting launchd about.
exit 0
