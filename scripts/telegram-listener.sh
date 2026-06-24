#!/usr/bin/env bash
#
# Phase-3 Telegram-channel listener wrapper (persistent process).
#
# Long-lived: execs the GramJS listener, which blocks watching channels. Run
# under launchd with KeepAlive={SuccessfulExit:false} — a clean exit 0 (dormant:
# no TG_SESSION / no channels) does NOT restart, so it can't hot-loop; a crash
# (nonzero) does restart.
#
# Same branch-independence as the news poller: runs the listener CODE from a
# short-lived origin/main worktree (canonical checkout may be on a feature
# branch), ledger pinned to the CANONICAL repo via ALERTS_LEDGER_DIR. No
# `git worktree prune` (H1). Own PID-lock so only one listener runs.
#
# Usage (manual): bash scripts/telegram-listener.sh

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK_DIR="/tmp/starbhai-tg-listener.lock.d"
LOG="${REPO_DIR}/data/tg-listener.log"
LEDGER_DIR="${REPO_DIR}/data/alerts"

cleanup_lock() { rm -f "${LOCK_DIR}/pid" 2>/dev/null; rmdir "${LOCK_DIR}" 2>/dev/null; }
acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; fi
  if [ -f "${LOCK_DIR}/pid" ]; then
    local pl lp lh; pl=$(cat "${LOCK_DIR}/pid" 2>/dev/null||echo ""); lp="${pl%@*}"; lh="${pl#*@}"
    if [ -n "${lp}" ] && [ "${lh}" = "$(hostname)" ] && kill -0 "${lp}" 2>/dev/null; then return 1; fi
    echo "[tg-listener] stale lock from ${pl:-<unknown>} — clearing"; cleanup_lock
    mkdir "${LOCK_DIR}" 2>/dev/null && { echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; }
  fi
  return 1
}

if ! acquire_lock; then echo "[tg-listener] another instance holds the lock — exiting"; exit 0; fi
cd "${REPO_DIR}" || { echo "[tg-listener] cannot cd ${REPO_DIR}"; exit 0; }
if [ -f .env ]; then set -a; source .env; set +a; fi
mkdir -p "${REPO_DIR}/data" "${LEDGER_DIR}"
exec >> >(tee -a "${LOG}") 2>&1
echo "===== tg-listener start $(date -u +'%Y-%m-%dT%H:%M:%SZ') (pid=$$) ====="

if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then echo "[tg-listener] fetch failed — exit 1 (will retry)"; exit 1; fi
WORKTREE_DIR=$(mktemp -d -t tg-listener) || { echo "[tg-listener] mktemp failed"; exit 1; }
cleanup_all() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "${WORKTREE_DIR}" ]; then
    cd "${REPO_DIR}" 2>/dev/null || true
    git worktree remove --force "${WORKTREE_DIR}" 2>/dev/null || rm -rf "${WORKTREE_DIR}" 2>/dev/null || true
  fi
  cleanup_lock
}
trap cleanup_all EXIT INT TERM HUP
if ! git worktree add --detach "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then echo "[tg-listener] worktree add failed — exit 1"; exit 1; fi
[ -d "${REPO_DIR}/node_modules" ] && ln -snf "${REPO_DIR}/node_modules" "${WORKTREE_DIR}/node_modules"

cd "${WORKTREE_DIR}" || { echo "[tg-listener] cannot cd worktree"; exit 1; }
# Blocks while the listener runs. Propagate its exit code so launchd's
# SuccessfulExit:false policy can decide whether to restart.
ALERTS_LEDGER_DIR="${LEDGER_DIR}" node scripts/telegram-listener.mjs
RC=$?
echo "===== tg-listener exit rc=${RC} $(date -u +'%Y-%m-%dT%H:%M:%SZ') ====="
exit "${RC}"
