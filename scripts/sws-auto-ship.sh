#!/usr/bin/env bash
# Shared generated-data shipper for SWS refresh jobs.
#
# Source this file from a refresh script, then call:
#   SWS_SHIP_MARKET=us \
#   SWS_SHIP_MIN_SCORED=5000 \
#   SWS_SHIP_PICKS_PATH=data/sws-us/picks-latest.json \
#   SWS_SHIP_LAST_REFRESH_PATH=data/sws-us/last-refresh.json \
#   sws_auto_ship_market data/sws-us/picks-latest.json ...
#
# The helper deliberately stages from a temporary worktree based on origin/main
# so a noisy operator checkout cannot leak unrelated local/generated files into
# the data PR.

# Report a step that was ATTEMPTED AND BROKE, as distinct from a deliberate
# refusal to ship (limit set, scrape skipped, auto-PR disabled …). Those keep
# returning 0; these must return non-zero so the caller can surface them.
#
# Before this, a failed `git push` printed one line and returned 0 — so a
# data-only ship could stall with zero signal: no mail, no non-zero exit, just a
# dangling local branch and a stale dashboard nobody was told about.
#
# send_mail is defined by sws-nightly.sh but NOT by sws-refresh-us.sh, which also
# sources this file — so the mail call must be guarded or it breaks the US path.
# NOTE on ${PIPESTATUS[0]} below: every git call here is piped into sed for log
# prefixing, and a pipeline's status is the LAST command's (sed, always 0) unless
# pipefail is set. Relying on the caller to have set it made failure detection
# silently caller-dependent — precisely the swallow this commit removes. Same
# reasoning as the COMMIT_RC guard in sws-nightly.sh.
_auto_ship_fail() {
  local market="$1" stage="$2" detail="$3"
  echo "[auto-ship] ${market}: ${stage} — FAILED"
  if declare -F send_mail >/dev/null 2>&1; then
    send_mail "🚨 SWS auto-ship (${market}) — ${stage} failed" "${detail}"
  fi
  return 1
}

sws_auto_ship_market() {
  local market="${SWS_SHIP_MARKET:-}"
  if [ -z "${market}" ]; then
    echo "[auto-ship] SWS_SHIP_MARKET is required; skipping"
    return 0
  fi

  local market_upper
  market_upper="$(printf '%s' "${market}" | tr '[:lower:]-' '[:upper:]_')"
  local auto_pr_var="SWS_${market_upper}_AUTO_PR"
  local auto_merge_var="SWS_${market_upper}_AUTO_MERGE"
  local auto_pr="${!auto_pr_var:-${SWS_AUTO_PR:-1}}"
  local auto_merge="${!auto_merge_var:-${SWS_AUTO_MERGE:-1}}"

  if [ "${auto_pr}" = "0" ]; then
    echo "[auto-ship] ${market}: SWS_AUTO_PR/${auto_pr_var}=0 — skipping"
    return 0
  fi
  if [ -n "${SWS_SCRAPE_LIMIT:-}" ]; then
    echo "[auto-ship] ${market}: SWS_SCRAPE_LIMIT=${SWS_SCRAPE_LIMIT} seed/capped run — skipping"
    return 0
  fi
  if [ "${SWS_SHIP_SCRAPE_SKIPPED:-false}" = "true" ]; then
    echo "[auto-ship] ${market}: scrape was skipped because shards were already live — skipping"
    return 0
  fi
  if [ "${SWS_SHIP_FAILED_SHARDS:-0}" != "0" ]; then
    echo "[auto-ship] ${market}: ${SWS_SHIP_FAILED_SHARDS} shard(s) failed — skipping"
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "[auto-ship] ${market}: gh CLI unavailable — skipping"
    return 0
  fi

  local allow_without_picks="${SWS_SHIP_ALLOW_WITHOUT_PICKS:-0}"
  if [ "${allow_without_picks}" != "1" ]; then
    SWS_SHIP_MARKET="${market}" \
    SWS_SHIP_MIN_SCORED="${SWS_SHIP_MIN_SCORED:-1}" \
    SWS_SHIP_PICKS_PATH="${SWS_SHIP_PICKS_PATH:-}" \
    SWS_SHIP_LAST_REFRESH_PATH="${SWS_SHIP_LAST_REFRESH_PATH:-}" \
      node --input-type=module - <<'EOF'
import { existsSync, readFileSync } from "node:fs";

const market = process.env.SWS_SHIP_MARKET;
const minScored = Number(process.env.SWS_SHIP_MIN_SCORED || 1);
const picksPath = process.env.SWS_SHIP_PICKS_PATH;
const lastRefreshPath = process.env.SWS_SHIP_LAST_REFRESH_PATH;

function fail(message) {
  console.error(`[auto-ship] ${market}: ${message}`);
  process.exit(1);
}

if (!picksPath || !lastRefreshPath) fail("picks and last-refresh paths are required");
if (!existsSync(picksPath)) fail(`${picksPath} is missing`);
if (!existsSync(lastRefreshPath)) fail(`${lastRefreshPath} is missing`);

let picks;
let lastRefresh;
try {
  picks = JSON.parse(readFileSync(picksPath, "utf-8"));
  lastRefresh = JSON.parse(readFileSync(lastRefreshPath, "utf-8"));
} catch (error) {
  fail(`could not parse picks/last-refresh JSON: ${error.message}`);
}

const scored = Number(picks.scored_count ?? lastRefresh.scored_count ?? 0);
if (!Number.isFinite(scored) || scored < minScored) {
  fail(`scored_count ${scored} is below minimum ${minScored}`);
}
if (!lastRefresh.finished_at) fail(`${lastRefreshPath} has no finished_at`);
EOF
    local validation_rc=$?
    if [ "${validation_rc}" -ne 0 ]; then
      echo "[auto-ship] ${market}: validation failed — skipping"
      return 0
    fi
  fi

  if [ "$#" -eq 0 ]; then
    echo "[auto-ship] ${market}: no artifact paths supplied — skipping"
    return 0
  fi

  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "[auto-ship] ${market}: not inside a git repository — skipping"
    return 0
  }

  local stamp run_label branch subject body pr_title pr_body tmpdir pr_output pr_url
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  run_label="${SWS_SHIP_RUN_LABEL:-$(date -u '+%Y-%m-%d %H:%M UTC')}"
  branch="${SWS_SHIP_BRANCH:-chore/data-refresh-${market}-${stamp}}"
  subject="${SWS_SHIP_COMMIT_SUBJECT:-chore(data): refresh ${market} data ${run_label}}"
  pr_title="${SWS_SHIP_PR_TITLE:-${subject}}"
  body="${SWS_SHIP_COMMIT_BODY:-Automated generated-data refresh for ${market}.}"
  pr_body="${SWS_SHIP_PR_BODY:-${body}

Auto-generated by a SWS refresh script. The ship worktree is based on origin/main and contains only the explicit generated artifact allow-list for this market.}"

  echo "[auto-ship] ${market}: fetching origin/main..."
  git -C "${repo_root}" fetch origin main 2>&1 | sed 's/^/[git] /'
  local fetch_rc=${PIPESTATUS[0]}
  if [ "${fetch_rc}" -ne 0 ]; then
    _auto_ship_fail "${market}" "git fetch origin main" "Could not fetch origin/main, so the ship worktree could not be based on it. No data was shipped."
    return $?
  fi

  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/sws-auto-ship-${market}.XXXXXX")"
  cleanup_auto_ship_worktree() {
    git -C "${repo_root}" worktree remove --force "${tmpdir}" >/dev/null 2>&1 || true
    rm -rf "${tmpdir}" >/dev/null 2>&1 || true
  }

  git -C "${repo_root}" branch -D "${branch}" >/dev/null 2>&1 || true
  git -C "${repo_root}" worktree add -B "${branch}" "${tmpdir}" origin/main 2>&1 | sed 's/^/[git] /'
  local add_rc=${PIPESTATUS[0]}
  if [ "${add_rc}" -ne 0 ]; then
    _auto_ship_fail "${market}" "git worktree add" "Could not create the ship worktree for ${branch}; no data was shipped."
    local wt_rc=$?
    rm -rf "${tmpdir}" >/dev/null 2>&1 || true
    return "${wt_rc}"
  fi

  # The ship worktree lives in the system tmp dir, where Node can't resolve the
  # repo's node_modules by walking parents — so the pre-push `npm test` hook dies
  # with ERR_MODULE_NOT_FOUND and blocks the push, and the freshly-scraped data
  # never ships (it just piles up as a dangling local chore/data-refresh-* branch).
  # Symlink the main checkout's node_modules in so the hook's deps resolve. It is
  # gitignored, so it never stages; cleanup removes it with the worktree.
  if [ -d "${repo_root}/node_modules" ]; then
    ln -sfn "${repo_root}/node_modules" "${tmpdir}/node_modules" 2>/dev/null || true
  fi

  local path src dst copied=0
  local copied_paths=()
  for path in "$@"; do
    src="${repo_root}/${path%/}"
    dst="${tmpdir}/${path%/}"
    if [ ! -e "${src}" ]; then
      echo "[auto-ship] ${market}: missing artifact ${path} — not staged"
      continue
    fi
    mkdir -p "$(dirname "${dst}")"
    if [ -d "${src}" ]; then
      mkdir -p "${dst}"
      rsync -a --delete "${src}/" "${dst}/"
    else
      cp "${src}" "${dst}"
    fi
    copied_paths+=("${path}")
    copied=$((copied + 1))
  done

  if [ "${copied}" -eq 0 ]; then
    echo "[auto-ship] ${market}: no supplied artifacts exist — skipping"
    cleanup_auto_ship_worktree
    return 0
  fi

  git -C "${tmpdir}" add -- "${copied_paths[@]}"
  if git -C "${tmpdir}" diff --cached --quiet --exit-code; then
    echo "[auto-ship] ${market}: no staged changes versus origin/main — skipping"
    cleanup_auto_ship_worktree
    return 0
  fi

  git -C "${tmpdir}" commit -m "${subject}

${body}" 2>&1 | sed 's/^/[git] /'
  local commit_rc=${PIPESTATUS[0]}
  if [ "${commit_rc}" -ne 0 ]; then
    cleanup_auto_ship_worktree
    _auto_ship_fail "${market}" "git commit" "git commit failed for ${branch}; nothing was pushed."
    return $?
  fi

  git -C "${tmpdir}" push -u origin "${branch}" 2>&1 | sed 's/^/[git] /'
  local push_rc=${PIPESTATUS[0]}
  if [ "${push_rc}" -ne 0 ]; then
    echo "[auto-ship] ${market}: push failed — leaving local branch ${branch}"
    cleanup_auto_ship_worktree
    _auto_ship_fail "${market}" "git push" "Commit succeeded but 'git push -u origin ${branch}' failed.

The data was generated and committed, but it did NOT reach prod — dashboards will
keep showing stale values until this is resolved. The commit still exists on the
local branch ${branch}, so it can be re-pushed once the cause is fixed rather
than requiring a full re-scrape.

Most likely causes: the pre-push hook rejected the push (see the [git] lines
above), no network, or expired credentials."
    return $?
  fi

  pr_output="$(cd "${tmpdir}" && gh pr create --base main --head "${branch}" --title "${pr_title}" --body "${pr_body}" 2>&1)"
  pr_url="$(printf '%s\n' "${pr_output}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)"
  if [ -z "${pr_url}" ]; then
    cleanup_auto_ship_worktree
    _auto_ship_fail "${market}" "gh pr create" "Branch ${branch} was pushed but PR creation failed, so nothing will auto-merge to prod.

gh output:
${pr_output}"
    return $?
  fi

  echo "[auto-ship] ${market}: PR created ${pr_url}"
  if [ "${auto_merge}" = "0" ]; then
    echo "[auto-ship] ${market}: SWS_AUTO_MERGE/${auto_merge_var}=0 — PR left open"
    cleanup_auto_ship_worktree
    return 0
  fi

  if ! gh pr merge "${pr_url}" --squash --auto 2>&1 | sed 's/^/[gh] /'; then
    echo "[auto-ship] ${market}: --auto merge failed, trying immediate squash merge..."
    gh pr merge "${pr_url}" --squash 2>&1 | sed 's/^/[gh] /' || \
      echo "[auto-ship] ${market}: merge failed — manual review required"
  fi

  cleanup_auto_ship_worktree
  return 0
}
