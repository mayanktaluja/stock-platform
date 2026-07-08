#!/usr/bin/env bash
#
# Market Wire builder wrapper (fast-news Phase / market-wire Phase 5).
#
# Fired ~every 5 min by launchd (com.starbhai.news-wire). Reads the on-disk
# Telegram buffer that the mirror poller writes, clusters + LLM-triages + ranks
# it, and publishes the ranked feed to Vercel KV (news:wire:latest) for the
# Market Intelligence tab.
#
# Same branch-independence + isolation discipline as the mirror poller: runs the
# builder CODE from a short-lived origin/main worktree (the canonical checkout may
# sit on a feature branch), with the buffer dir, the local mirror, and the LLM
# cache ALL pinned to the CANONICAL repo (absolute) — the worktree is
# `git worktree remove --force`d every run, so anything written relative to it is
# lost. KV is the production source of truth; the mirror + cache are local state.
#
# Own PID-lock (distinct from the poller's). Always exits 0.
#
# Usage (manual): bash scripts/news-wire-build.sh [--skip-llm] [--dry-run]

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
LOCK_DIR="/tmp/starbhai-news-wire.lock.d"
LOG="${REPO_DIR}/data/news-wire-build.log"
WIRE_DIR="${REPO_DIR}/data/news-wire/buffer"
OUT="${REPO_DIR}/data/news-wire/wire-latest.json"
CACHE="${REPO_DIR}/data/news-wire/impact-cache.json"

# Active window gate: the channels are global and peak overnight IST (US/Fed/
# Trump session), so run 07:00 IST → 02:00 IST and skip the dead 02:00–07:00
# window. launchd StartInterval can't express this, so gate here.
IST_HOUR=$(TZ=Asia/Kolkata date +%H)
IST_HOUR=$((10#${IST_HOUR}))
if [ "${IST_HOUR}" -ge 2 ] && [ "${IST_HOUR}" -lt 7 ]; then
  exit 0
fi

cleanup_lock() { rm -f "${LOCK_DIR}/pid" 2>/dev/null; rmdir "${LOCK_DIR}" 2>/dev/null; }
acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; fi
  if [ -f "${LOCK_DIR}/pid" ]; then
    local pl lp lh; pl=$(cat "${LOCK_DIR}/pid" 2>/dev/null||echo ""); lp="${pl%@*}"; lh="${pl#*@}"
    if [ -n "${lp}" ] && [ "${lh}" = "$(hostname)" ] && kill -0 "${lp}" 2>/dev/null; then return 1; fi
    echo "[wire] stale lock from ${pl:-<unknown>} — clearing"; cleanup_lock
    mkdir "${LOCK_DIR}" 2>/dev/null && { echo "$$@$(hostname)" > "${LOCK_DIR}/pid"; trap cleanup_lock EXIT INT TERM HUP; return 0; }
  fi
  return 1
}

if ! acquire_lock; then echo "[wire] another run holds the lock — exiting"; exit 0; fi
cd "${REPO_DIR}" || { echo "[wire] cannot cd ${REPO_DIR}"; exit 0; }
if [ -f .env ]; then set -a; source .env; set +a; fi
mkdir -p "${REPO_DIR}/data" "${WIRE_DIR}"
exec >> >(tee -a "${LOG}") 2>&1

if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then echo "[wire] fetch failed — exit"; exit 0; fi
WORKTREE_DIR=$(mktemp -d -t news-wire) || { echo "[wire] mktemp failed"; exit 0; }
cleanup_all() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "${WORKTREE_DIR}" ]; then
    cd "${REPO_DIR}" 2>/dev/null || true
    git worktree remove --force "${WORKTREE_DIR}" 2>/dev/null || rm -rf "${WORKTREE_DIR}" 2>/dev/null || true
  fi
  cleanup_lock
}
trap cleanup_all EXIT INT TERM HUP
if ! git worktree add --detach "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then echo "[wire] worktree add failed"; exit 0; fi
[ -d "${REPO_DIR}/node_modules" ] && ln -snf "${REPO_DIR}/node_modules" "${WORKTREE_DIR}/node_modules"

cd "${WORKTREE_DIR}" || { echo "[wire] cannot cd worktree"; exit 0; }
NEWS_WIRE_DIR="${WIRE_DIR}" node scripts/refresh-news-wire.mjs --out "${OUT}" --cache "${CACHE}" "$@" 2>&1 | sed 's/^/[wire] /'
exit 0
