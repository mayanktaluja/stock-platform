#!/usr/bin/env bash
#
# Telegram public-mirror news poller wrapper — fast-news-alerts Phase 3b.
#
# Fired ~every minute by launchd (com.starbhai.mirror-news). Polls t.me/s/<slug>
# for each enabled channel and routes fresh messages into the delivery group's
# category topics. Plain HTTPS — no MTProto/session (chosen because this host
# can't hold a persistent update connection; see scripts/telegram-listener.mjs
# for the real-time alternative that needs a stable-connection host).
#
# Same branch-independence as the RSS news poller: runs the poller CODE from a
# short-lived origin/main worktree (the canonical checkout may sit on a feature
# branch), ledger pinned to the canonical repo via ALERTS_LEDGER_DIR. No
# `git worktree prune` (H1). Own PID-lock. Always exits 0.
#
# Usage (manual): bash scripts/mirror-news-poll.sh [--dry-run]

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK_DIR="/tmp/starbhai-mirror-news.lock.d"
LOG="${REPO_DIR}/data/mirror-news-poll.log"
LEDGER_DIR="${REPO_DIR}/data/alerts"
# Market Wire buffer — pinned to the CANONICAL repo (absolute). The node code
# runs from a throwaway origin/main worktree that gets `git worktree remove
# --force`d every run; an unpinned/relative path would write into that doomed
# dir and be nuked. Same discipline as ALERTS_LEDGER_DIR.
WIRE_DIR="${REPO_DIR}/data/news-wire/buffer"

cleanup_lock() { rm -f "${LOCK_DIR}/pid" 2>/dev/null; rmdir "${LOCK_DIR}" 2>/dev/null; }
acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; fi
  if [ -f "${LOCK_DIR}/pid" ]; then
    local pl lp lh; pl=$(cat "${LOCK_DIR}/pid" 2>/dev/null||echo ""); lp="${pl%@*}"; lh="${pl#*@}"
    if [ -n "${lp}" ] && [ "${lh}" = "$(hostname)" ] && kill -0 "${lp}" 2>/dev/null; then return 1; fi
    echo "[mirror] stale lock from ${pl:-<unknown>} — clearing"; cleanup_lock
    mkdir "${LOCK_DIR}" 2>/dev/null && { echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; }
  fi
  return 1
}

if ! acquire_lock; then echo "[mirror] another run holds the lock — exiting"; exit 0; fi
cd "${REPO_DIR}" || { echo "[mirror] cannot cd ${REPO_DIR}"; exit 0; }
if [ -f .env ]; then set -a; source .env; set +a; fi
mkdir -p "${REPO_DIR}/data" "${LEDGER_DIR}" "${WIRE_DIR}"
exec >> >(tee -a "${LOG}") 2>&1

if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then echo "[mirror] fetch failed — exit"; exit 0; fi
WORKTREE_DIR=$(mktemp -d -t mirror-news) || { echo "[mirror] mktemp failed"; exit 0; }
cleanup_all() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "${WORKTREE_DIR}" ]; then
    cd "${REPO_DIR}" 2>/dev/null || true
    git worktree remove --force "${WORKTREE_DIR}" 2>/dev/null || rm -rf "${WORKTREE_DIR}" 2>/dev/null || true
  fi
  cleanup_lock
}
trap cleanup_all EXIT INT TERM HUP
if ! git worktree add --detach "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then echo "[mirror] worktree add failed"; exit 0; fi
[ -d "${REPO_DIR}/node_modules" ] && ln -snf "${REPO_DIR}/node_modules" "${WORKTREE_DIR}/node_modules"

cd "${WORKTREE_DIR}" || { echo "[mirror] cannot cd worktree"; exit 0; }
ALERTS_LEDGER_DIR="${LEDGER_DIR}" NEWS_WIRE_DIR="${WIRE_DIR}" node scripts/refresh-mirror-news.mjs --window-min 3 "$@" 2>&1 | sed 's/^/[mirror] /'
exit 0
