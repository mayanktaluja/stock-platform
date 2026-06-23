#!/usr/bin/env bash
#
# Watchlist news poller wrapper — fast-news-alerts Phase 2.
#
# Fired ~every 30 min during IST market hours by launchd
# (com.starbhai.news-alerts). UNLIKE the macro cron this does NOT use a git
# worktree and does NOT commit anything: it only reads RSS, matches against
# data/alerts/watchlist.json, writes the per-machine sent-ledger, and sends
# Telegram. So it runs directly in the canonical repo, read-only wrt git
# (adversarial H1 — a worktree+prune here would race the macro cron's worktree).
#
# Own PID-lock dir, distinct from /tmp/sws-macro-only-refresh.lock.d, so the two
# crons never block each other.
#
# Usage (manual): bash scripts/news-alerts-poll.sh [--dry-run]

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK_DIR="/tmp/starbhai-news-alerts.lock.d"
LOG="${REPO_DIR}/data/news-alerts-poll.log"

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

mkdir -p "${REPO_DIR}/data"
exec >> >(tee -a "${LOG}") 2>&1
echo "===== news-alerts poll $(date -u +'%Y-%m-%dT%H:%M:%SZ') (pid=$$) ====="

node scripts/refresh-news-alerts.mjs "$@" 2>&1 | sed 's/^/[news] /'
# Always exit 0 — a poll failure is not worth alerting launchd about.
exit 0
