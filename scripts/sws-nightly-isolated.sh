#!/usr/bin/env bash
#
# Launchd entrypoint for the SWS nightly. It keeps the data publisher out of
# the primary development checkout by running scripts/sws-nightly.sh from a
# dedicated, resettable worktree.

set -uo pipefail

PRIMARY_REPO="${SWS_NIGHTLY_PRIMARY_REPO:-/Users/mayanktaluja/code/stock-platform}"
WORKTREE_DIR="${SWS_NIGHTLY_WORKTREE_DIR:-/Users/mayanktaluja/.Codex/worktrees/stock-platform-sws-nightly}"
BASE_BRANCH="${SWS_NIGHTLY_BASE_BRANCH:-sws-nightly-isolated-base}"

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }

source_env_if_present() {
  local file="$1"
  if [ -f "${file}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${file}" 2>/dev/null || true
    set +a
  fi
}

source_env_if_present "${PRIMARY_REPO}/.env"
source_env_if_present "${PRIMARY_REPO}/.env.local"

send_mail() {
  local subject="$1"; local body="$2"
  if [ -f "${PRIMARY_REPO}/scripts/sws-mail-summary.mjs" ]; then
    printf "%s" "${body}" | node "${PRIMARY_REPO}/scripts/sws-mail-summary.mjs" "${subject}" - 2>&1 | sed 's/^/[mail] /' || true
  fi
}

exclude_worktree_path() {
  local pattern="$1"
  local exclude_file
  exclude_file="$(git -C "${WORKTREE_DIR}" rev-parse --git-path info/exclude 2>/dev/null || true)"
  if [ -n "${exclude_file}" ]; then
    mkdir -p "$(dirname "${exclude_file}")"
    grep -qxF "${pattern}" "${exclude_file}" 2>/dev/null || printf "\n%s\n" "${pattern}" >> "${exclude_file}"
  fi
}

link_local_artifact() {
  local rel="$1"
  local src="${PRIMARY_REPO}/${rel}"
  local dest="${WORKTREE_DIR}/${rel}"
  if [ -e "${src}" ]; then
    rm -rf -- "${dest}" || fail_critical "local artifact clear failed" "Could not clear ${dest} before linking ${src} at $(ts)." 5
    mkdir -p "$(dirname "${dest}")"
    ln -s "${src}" "${dest}" || fail_critical "local artifact link failed" "Could not link ${src} into ${dest} at $(ts)." 5
  else
    rm -rf -- "${dest}" 2>/dev/null || true
  fi
}

fail_critical() {
  local subject="$1"; local body="$2"; local rc="${3:-5}"
  echo "[isolated-nightly] ${subject}"
  send_mail "🚨 SWS nightly — ${subject}" "${body}"
  exit "${rc}"
}

if [ ! -d "${PRIMARY_REPO}/.git" ] && [ ! -f "${PRIMARY_REPO}/.git" ]; then
  fail_critical "primary repo missing" "Primary repo not found at ${PRIMARY_REPO} at $(ts)." 5
fi

if [ -z "${RESEND_API_KEY:-}" ] && [ ! -f "${PRIMARY_REPO}/.env" ] && [ ! -f "${PRIMARY_REPO}/.env.local" ]; then
  # Best-effort: this may not send without RESEND_API_KEY, but it still leaves
  # an explicit launchd/log signal instead of silently losing critical alerts.
  fail_critical "mail config missing" "No RESEND_API_KEY in launchd env and neither .env nor .env.local exists in ${PRIMARY_REPO}. Critical nightly alerts may not send." 5
fi

echo "[isolated-nightly] primary=${PRIMARY_REPO}"
echo "[isolated-nightly] worktree=${WORKTREE_DIR}"
echo "[isolated-nightly] base_branch=${BASE_BRANCH}"

# Single-instance guard. The launchd cron and a manual /sws-refresh both enter
# here and DESTRUCTIVELY reset the shared WORKTREE_DIR (git reset --hard +
# clean). Two concurrent runs would stomp each other's tree mid-flight. Take an
# atomic PID lock; if a live instance already holds it, skip (exit 0) rather
# than corrupt the in-flight publish. A stale lock (holder dead) is reclaimed.
LOCK_DIR="${SWS_NIGHTLY_LOCK_DIR:-/tmp/starbhai-sws-nightly.lock.d}"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  lock_holder="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")"
  if [ -n "${lock_holder}" ] && kill -0 "${lock_holder}" 2>/dev/null; then
    echo "[isolated-nightly] another SWS nightly (pid ${lock_holder}) is already running — skipping to avoid a shared-worktree collision. Check /sws-status; re-run when it finishes."
    exit 0
  fi
  echo "[isolated-nightly] reclaiming stale lock (holder '${lock_holder:-none}' not alive)"
  rm -rf "${LOCK_DIR}" 2>/dev/null || true
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "[isolated-nightly] could not acquire ${LOCK_DIR}; another run raced us — skipping."
    exit 0
  fi
fi
echo "$$" > "${LOCK_DIR}/pid"
trap 'rm -rf "${LOCK_DIR}" 2>/dev/null || true' EXIT

if ! git -C "${PRIMARY_REPO}" fetch origin main 2>&1 | sed 's/^/[git] /'; then
  fail_critical "worktree setup fetch failed" "git fetch origin main failed from ${PRIMARY_REPO} at $(ts)." 5
fi

if [ -d "${WORKTREE_DIR}/.git" ] || [ -f "${WORKTREE_DIR}/.git" ]; then
  echo "[isolated-nightly] resetting existing worktree"
  # This worktree is owned by launchd. A prior run can leave generated data
  # dirty if publish fails after commit/push, but those files must not block the
  # next scheduled reset.
  if ! git -C "${WORKTREE_DIR}" reset --hard 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree pre-reset failed" "Could not discard stale generated changes in ${WORKTREE_DIR} at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" clean -fd -- . 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree pre-clean failed" "Could not clean stale generated files in ${WORKTREE_DIR} at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" checkout -f -B "${BASE_BRANCH}" origin/main 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree reset failed" "Could not checkout -B ${BASE_BRANCH} origin/main in ${WORKTREE_DIR} at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" reset --hard origin/main 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree hard reset failed" "Could not reset ${WORKTREE_DIR} to origin/main at $(ts)." 5
  fi
  if ! git -C "${WORKTREE_DIR}" clean -fd -- . 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree clean failed" "Could not clean ${WORKTREE_DIR} at $(ts)." 5
  fi
elif [ -e "${WORKTREE_DIR}" ]; then
  fail_critical "worktree path is not a git checkout" "${WORKTREE_DIR} exists but is not a git worktree. Refusing to delete it automatically." 5
else
  echo "[isolated-nightly] creating worktree"
  mkdir -p "$(dirname "${WORKTREE_DIR}")"
  if ! git -C "${PRIMARY_REPO}" worktree add -B "${BASE_BRANCH}" "${WORKTREE_DIR}" origin/main 2>&1 | sed 's/^/[git] /'; then
    fail_critical "worktree create failed" "Could not create ${WORKTREE_DIR} from origin/main at $(ts)." 5
  fi
fi

exclude_worktree_path "node_modules"
exclude_worktree_path ".sws-profile-*"
exclude_worktree_path "data/sws/api-queries.json"

for env_file in .env .env.local; do
  src="${PRIMARY_REPO}/${env_file}"
  dest="${WORKTREE_DIR}/${env_file}"
  if [ -f "${src}" ]; then
    ln -sfn "${src}" "${dest}" || fail_critical "env link failed" "Could not link ${src} into ${dest} at $(ts)." 5
  else
    rm -f "${dest}" 2>/dev/null || true
  fi
done

link_local_artifact "node_modules"
link_local_artifact "data/sws/api-queries.json"
link_local_artifact ".sws-profile-1"
link_local_artifact ".sws-profile-2"
link_local_artifact ".sws-profile-3"

if [ -z "${RESEND_API_KEY:-}" ] && [ ! -f "${WORKTREE_DIR}/.env" ] && [ ! -f "${WORKTREE_DIR}/.env.local" ]; then
  fail_critical "mail config unavailable in isolated worktree" "The isolated worktree has no .env/.env.local symlink and launchd env has no RESEND_API_KEY. Critical alerts may not send." 5
fi

echo "[isolated-nightly] launching sws-nightly.sh from isolated worktree"
SWS_NIGHTLY_REPO_DIR="${WORKTREE_DIR}" \
SWS_NIGHTLY_BASE_BRANCH="${BASE_BRANCH}" \
  bash "${WORKTREE_DIR}/scripts/sws-nightly.sh" "$@"
