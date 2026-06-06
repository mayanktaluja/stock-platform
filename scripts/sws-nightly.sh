#!/usr/bin/env bash
#
# Fully-autonomous SWS refresh. Designed to run from a launchd agent at
# 00:30 IST every day, after SWS's rolling India updates have settled. No Claude
# Code dependency.
#
# Pipeline:
#   0. Mail: "run started" heads-up (sent before pre-flight; pairs with abort mail)
#   1. Pre-flight  — panic flag, AC power, network reachable
#   2. git pull main (so we're not racing a human commit)
#   3. bash scripts/sws-refresh-api.sh (full scrape → parse → score → PDF)
#   4. Sanity gate — refuses to push if data looks wrong (regression guard)
#   5. Branch + commit + push
#   6. gh pr create + gh pr merge --auto --squash (Vercel deploys on green)
#   7. Email summary (success or failure) via sws-mail-summary.mjs
#
# Usage:
#   bash scripts/sws-nightly.sh           # full run
#   bash scripts/sws-nightly.sh --dry-run # smoke test (skip scrape + commit)
#
# Env:
#   SWS_NIGHTLY_DRY_RUN=1        # alt to --dry-run flag
#   SWS_NIGHTLY_SKIP_BATTERY=0   # re-enable bail-out when on battery (default: skip the check)
#   SWS_NIGHTLY_AUTO_MERGE=1     # default: enable --auto on PR (set =0 to hold for manual review)
#   SWS_SKIP_RESOLVE_ACTUALS=1   # skip post-earnings actuals-resolution (default: run)
#
# Exit codes:
#   0  success or no-op
#   3  panic flag set
#   4  on battery (skipped run, mailed)
#   5  git/network failure
#   6  scrape pipeline failure
#   7  sanity gate failed (data committed but NOT pushed)
#   8  commit, push, or PR creation failed

# This script checks out branches while it runs. Bash reads script files
# incrementally, so executing directly from the working tree can jump to the
# wrong byte offset if a checkout rewrites this file mid-run. Exec a stable
# temp copy first; child commands still run from REPO_DIR below.
if [ -z "${SWS_NIGHTLY_STABLE_COPY:-}" ]; then
  STABLE_COPY="${TMPDIR:-/tmp}/sws-nightly.$$.sh"
  if ! cp "${BASH_SOURCE[0]}" "${STABLE_COPY}"; then
    echo "[nightly] cannot create stable script copy at ${STABLE_COPY}" >&2
    exit 5
  fi
  chmod 700 "${STABLE_COPY}" 2>/dev/null || true
  export SWS_NIGHTLY_STABLE_COPY="${STABLE_COPY}"
  exec bash "${STABLE_COPY}" "$@"
fi

set -uo pipefail

REPO_DIR="${SWS_NIGHTLY_REPO_DIR:-/Users/mayanktaluja/code/stock-platform}"
BASE_BRANCH="${SWS_NIGHTLY_BASE_BRANCH:-sws-nightly-base}"
cd "${REPO_DIR}" || { echo "[nightly] cannot cd to ${REPO_DIR}"; exit 5; }

# ---- Load .env into the environment ----
#
# launchd invokes this script with a near-empty environment (PATH / HOME
# only), so any node child reading process.env.GROQ_API_KEY /
# GEMINI_API_KEY / SLACK_WEBHOOK_URL / etc. sees `undefined` unless we
# source the committed .env first. Belt-and-braces with the per-script
# `dotenv.config(...)` calls in refresh-earnings.mjs and
# refresh-macro-regime.mjs — sourcing here covers scripts that haven't
# (yet) wired dotenv themselves. `set -a` auto-exports everything sourced;
# `[ -f .env ]` is the no-op guard for a fresh checkout without a .env.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

LOG="data/sws/sws-nightly.log"
LOG_PATH="${REPO_DIR}/${LOG}"
mkdir -p data/sws
exec >> >(tee -a "${LOG}") 2>&1

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }
START_EPOCH="$(date +%s)"

# ---- Slack failure trap (P3.3) ----
#
# Catch-all for any non-zero exit — including signals (SIGTERM/SIGHUP from
# launchd), uncaught `set -u`/`set -o pipefail` triggers, and crashes that
# happen BEFORE the existing send_mail handlers run. Silent no-op when
# SLACK_WEBHOOK_URL is unset (the common case for interactive runs).
#
# Installed EARLY so a pre-flight or git-sync failure still alerts. Cleared
# at the bottom of the script (just before the success-path `exit 0`) so the
# normal completion doesn't fire it. The mid-script `exit N` paths DO fire
# this trap — that's intentional: Slack gets a terse ping (a few minutes,
# any phone), the existing send_mail call gets the rich detail. They're
# additive, not replacements.
slack_notify_on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ]; then
    bash "${REPO_DIR}/scripts/slack-notify.sh" \
      ":warning: SWS nightly (sws-nightly.sh) failed at $(ts) with exit code ${rc} — see ${LOG_PATH}" \
      >/dev/null 2>&1 || true
  fi
  [ -n "${SWS_NIGHTLY_STABLE_COPY:-}" ] && rm -f "${SWS_NIGHTLY_STABLE_COPY}" 2>/dev/null || true
}
trap slack_notify_on_exit EXIT

# Portable timeout wrapper: GNU `timeout` ships with Linux but not macOS
# (stock macOS has no equivalent; Homebrew's coreutils provides `gtimeout`).
# Prefer gtimeout, then timeout, then use a small bash watchdog so vanilla
# macOS still enforces step deadlines.
if command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
elif command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
else
  with_timeout() {
    local seconds="$1"
    shift
    "$@" &
    local child_pid=$!
    (
      sleep "${seconds}"
      if kill -0 "${child_pid}" >/dev/null 2>&1; then
        echo "[timeout] command exceeded ${seconds}s; terminating pid ${child_pid}: $*" >&2
        kill -TERM "${child_pid}" >/dev/null 2>&1 || true
        sleep 5
        kill -KILL "${child_pid}" >/dev/null 2>&1 || true
      fi
    ) &
    local watchdog_pid=$!
    wait "${child_pid}"
    local rc=$?
    kill "${watchdog_pid}" >/dev/null 2>&1 || true
    wait "${watchdog_pid}" >/dev/null 2>&1 || true
    return "${rc}"
  }
fi

# shellcheck source=scripts/sws-auto-ship.sh
. "${REPO_DIR}/scripts/sws-auto-ship.sh"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
[ "${SWS_NIGHTLY_DRY_RUN:-0}" = "1" ] && DRY_RUN=1

AUTO_MERGE="${SWS_NIGHTLY_AUTO_MERGE:-1}"

echo
echo "============================================================"
echo "  SWS nightly run started: $(ts) (pid=$$, dry_run=${DRY_RUN})"
echo "============================================================"

# ---- helper: send mail (non-fatal if it fails) ----
send_mail() {
  local subject="$1"; local body="$2"
  if [ -f scripts/sws-mail-summary.mjs ]; then
    printf "%s" "${body}" | node scripts/sws-mail-summary.mjs "${subject}" - 2>&1 | sed 's/^/[mail] /' || true
  fi
}

# ---- 0. Mail: run-started heads-up ----
# Fires BEFORE pre-flight so the operator always gets a kickoff notice — even
# when a pre-flight check aborts the run seconds later. Aborts send their own
# 🚨 mail, so a started→aborted pair in the inbox is expected, not a bug.
START_SUBJECT="🚀 SWS nightly started — $(ts)"
[ "${DRY_RUN}" = "1" ] && START_SUBJECT="🚀 SWS nightly started (DRY RUN) — $(ts)"
send_mail "${START_SUBJECT}" "SWS nightly run kicked off at $(ts).

pid:        $$
dry run:    ${DRY_RUN}
auto-merge: ${AUTO_MERGE}
host:       $(hostname)

Pre-flight (panic flag / battery / network / git sync) runs next. A second
mail follows when the run finishes — ✅ on success, 🚨/⚠️ on abort or warning.
Typical full run is ~3h, so expect the completion mail around then."

# ---- 1. Pre-flight ----

if [ -f data/sws/panic-stop.flag ]; then
  echo "[nightly] PANIC flag set — refusing to run"
  send_mail "🚨 SWS nightly aborted — PANIC flag" "$(cat data/sws/panic-stop.flag 2>/dev/null | head -30)

Delete data/sws/panic-stop.flag once reviewed to allow next run."
  exit 3
fi

# Battery check: pmset wake doesn't guarantee AC is connected at run time.
# Default is to PROCEED on battery (skip=1) — the daily ship-to-prod pipeline
# must not silently no-op just because the laptop happens to be unplugged.
# Set SWS_NIGHTLY_SKIP_BATTERY=0 to re-enable the bail-out.
if [ "${SWS_NIGHTLY_SKIP_BATTERY:-1}" != "1" ]; then
  if pmset -g batt | head -2 | grep -q "Battery Power"; then
    echo "[nightly] running on battery — skipping run to avoid mid-job sleep"
    send_mail "⚠️ SWS nightly skipped — laptop on battery" "Mac was on battery at $(ts). Plug in before next 00:30 IST run.

$(pmset -g batt 2>&1 | head -3)"
    exit 4
  fi
fi

# Network check: use HTTPS reachability instead of ICMP. Some networks block
# ping even when the actual refresh dependencies are reachable.
HTTPS_PREFLIGHT_OK=0
for preflight_url in https://github.com https://simplywall.st; do
  if curl -fsSL --connect-timeout 8 --max-time 20 "${preflight_url}" >/dev/null 2>&1; then
    echo "[nightly] HTTPS preflight OK: ${preflight_url}"
    HTTPS_PREFLIGHT_OK=1
    break
  fi
done
if [ "${HTTPS_PREFLIGHT_OK}" -ne 1 ]; then
  echo "[nightly] network unreachable over HTTPS — bailing"
  send_mail "🚨 SWS nightly aborted — HTTPS network unreachable" "HTTPS checks failed at $(ts):

  https://github.com
  https://simplywall.st"
  exit 5
fi

# ---- 2. Sync main ----
#
# Self-healing sync: autostash any local working-tree changes (tracked +
# untracked) before the origin/main checkout, so dashboard-time transient
# files never block the nightly. Only diverged local commits on the main
# ref are treated as fatal — those need a human, resetting would lose work.

echo "[nightly] syncing main..."
if ! git fetch origin main 2>&1 | sed 's/^/[git] /'; then
  echo "[nightly] git fetch failed"
  send_mail "🚨 SWS nightly aborted — git fetch failed" "git fetch origin main failed at $(ts). Likely network or auth issue."
  exit 5
fi

# Genuine-unpushed-work guard. Measure the `main` REF against origin/main —
# NOT HEAD. HEAD is frequently a leftover auto-refresh branch from a prior
# run (the commit/push stage checks out chore/sws-auto-refresh-* and never
# restores main), and that branch's commit is already pushed as a PR head,
# so origin/main..HEAD false-positives. origin/main..main only counts real
# human commits sitting unpushed on the main ref — that needs a human. A
# `main` ref that is BEHIND origin, or merely stale, yields 0 and is fine.
LOCAL_AHEAD="$(git rev-list --count origin/main..main 2>/dev/null || echo 0)"
if [ "${LOCAL_AHEAD}" -gt 0 ]; then
  echo "[nightly] local main ref is ${LOCAL_AHEAD} commit(s) ahead of origin/main — refusing to run"
  send_mail "🚨 SWS nightly aborted — local main has unpushed commits" \
"Local main is ${LOCAL_AHEAD} commit(s) ahead of origin/main at $(ts). Push or reset main manually before the next run.

$(git log --oneline origin/main..main)"
  exit 5
fi

# Phase 2 guard (2026-05-17 permanent fix): refuse to run if there are
# unmerged paths in the index. Prior incidents had `.claude/launch.json`
# left UU after a partial run, which silently bricked `git stash push`
# below with `error: could not write index / file needs merge` → exit 5
# → macro refresh never ran → production banner went orange. Detect
# explicitly and mail with full diagnostics instead of letting the
# autostash blow up with a cryptic error.
if git ls-files -u | head -1 | grep -q .; then
  UNMERGED_PATHS=$(git ls-files -u | awk '{print $4}' | sort -u)
  echo "[nightly] UNMERGED paths in index — refusing to run:"
  echo "${UNMERGED_PATHS}" | sed 's/^/  /'
  send_mail "🚨 SWS nightly aborted — unmerged paths in index" \
"git ls-files -u found unmerged paths at $(ts). The autostash would fail with
'cannot write index' (this is the failure mode that bricked the 2026-05-17
runs, now caught explicitly). Fix manually:

  cd ${REPO_DIR}
  git status

For each unmerged file, pick a side or merge:
  git checkout --theirs <file>     # or --ours, or hand-merge
  git add <file>

Then re-run:
  launchctl start com.starbhai.sws-nightly

Unmerged paths:
${UNMERGED_PATHS}

Full status:
$(git status 2>&1 | head -40)"
  exit 5
fi

# Single-writer guard: the macro-only cron + the GH Actions macro backup are the
# sole writers of the macro-cron-owned paths below. macroRegime.json is rewritten
# every ~2h; macro-headlines/ and macroRegime-history/ are appended on each macro
# refresh and reach origin/main via the macro backup's own PRs. This nightly never
# commits any of them. Discard any local delta BEFORE the autostash so they can't
# enter the stash and conflict on pop against origin/main's newer copy. A pop
# conflict leaves unmerged (UU) index entries that (a) make `git commit` refuse and
# (b) trip the unmerged-paths guard above on the NEXT run — either way bricking the
# pipeline. origin/main is canonical and is re-installed by the checkout below.
#
# 2026-05-22: macro-headlines/ + macroRegime-history/ added to this list after a
# stash-pop conflict on data/macro-headlines/2026-05-20.jsonl left UU entries that
# silently broke the auto-commit (empty branch pushed → "No commits between main"
# at PR create, launchd exit 8). Previously only macroRegime.json was guarded.
MACRO_CRON_PATHS=(
  data/macroRegime.json
  data/macro-headlines
  data/macroRegime-history
)
for macro_path in "${MACRO_CRON_PATHS[@]}"; do
  git checkout -- "${macro_path}" 2>/dev/null || true
done

# Autostash BEFORE we move the working copy. The tree is routinely dirty
# with regenerated files (data/coverage/*, data/sws/_sanity/_latest.json);
# a dirty tracked file would otherwise block the checkout below.
# .claude/launch.json was historically the worst offender — now gitignored
# after PR #248 — so the autostash surface is dramatically smaller.
STASH_TAG="sws-nightly-autostash-$(date +%s)"
STASHED=0
if [ -n "$(git status --porcelain)" ]; then
  echo "[nightly] working tree dirty — autostashing as ${STASH_TAG}"
  git status --short | sed 's/^/[git-status] /'
  if git stash push --include-untracked -m "${STASH_TAG}" 2>&1 | sed 's/^/[git] /'; then
    STASHED=1
  else
    send_mail "🚨 SWS nightly aborted — autostash failed" \
"git stash push --include-untracked failed at $(ts). Inspect manually.

$(git status 2>&1 | head -40)"
    exit 5
  fi
fi

# Move the working copy to origin/main's tip WITHOUT `git checkout main`.
# A worktree under .claude/worktrees/ may hold the `main` branch ref, which
# makes `git checkout main` fail with
#   fatal: 'main' is already used by worktree at ...
# `git checkout -B ${BASE_BRANCH} origin/main` sidesteps that: a worktree
# reserves the branch NAME `main`, not the commit it points at and not other
# branch names. -B force-resets ${BASE_BRANCH} to origin/main every run,
# so the branch is reused, never drifts, and needs no cleanup. The commit/
# push stage later does its own `git checkout -b chore/sws-auto-refresh-*`,
# so the literal `main` branch never needs to be checked out here.
echo "[nightly] checking out ${BASE_BRANCH} at origin/main..."
if ! git checkout -B "${BASE_BRANCH}" origin/main 2>&1 | sed 's/^/[git] /'; then
  echo "[nightly] could not check out ${BASE_BRANCH} at origin/main"
  send_mail "🚨 SWS nightly aborted — git checkout failed" \
"git checkout -B ${BASE_BRANCH} origin/main failed at $(ts).

This is NOT the worktree-holds-main case (we deliberately avoid 'git checkout main').
Likely a dirty file that survived autostash, or a branch named '${BASE_BRANCH}'
held by a worktree. Inspect manually:

$(git status 2>&1 | head -30)

$(git worktree list 2>&1)"
  exit 5
fi

# Keep any autostash quarantined until after the run. Re-applying it here can
# reintroduce user/agent dirt or unmerged paths into the publish index, which is
# exactly how previous runs shipped fresh SWS picks without matching aux data.
if [ "${STASHED}" -eq 1 ]; then
  echo "[nightly] autostash ${STASH_TAG} left on stash list; not re-applying before publish"
fi

# Self-heal: if any macro-cron-owned path is still unmerged despite the
# pre-stash discard above, auto-resolve it to origin/main's version so we never
# leave UU entries behind (which would make `git commit` refuse below and lock out
# the next run via the unmerged-paths guard). ${BASE_BRANCH} points at origin/main.
# The `git add` after the checkout clears the unmerged state; because the restored
# content equals HEAD (origin/main), it contributes nothing to the eventual commit.
for macro_path in "${MACRO_CRON_PATHS[@]}"; do
  if git ls-files -u -- "${macro_path}" | grep -q .; then
    echo "[nightly] ${macro_path} unmerged after pop — auto-resolving to origin/main"
    git checkout "${BASE_BRANCH}" -- "${macro_path}"
    git add "${macro_path}"
  fi
done

if [ ${DRY_RUN} -eq 1 ]; then
  echo "[nightly] DRY RUN — skipping scrape, sanity gate, commit, PR"
  send_mail "✅ SWS nightly DRY RUN OK" "Dry run completed at $(ts). Pre-flight + git sync OK. The real run would now invoke sws-refresh-api.sh."
  echo "[nightly] DRY RUN done in $(($(date +%s) - START_EPOCH))s"
  [ -n "${SWS_NIGHTLY_STABLE_COPY:-}" ] && rm -f "${SWS_NIGHTLY_STABLE_COPY}" 2>/dev/null || true
  trap - EXIT  # dry-run success — don't fire Slack failure trap
  exit 0
fi

# ---- 3. Parallel primary data refresh branches ----
#
# Two independent data-source branches start together, then join at one
# barrier before any downstream compute:
#
#   SWS primary branch:
#     sws-refresh-api.sh (SWS scrape shards → SWS-side NSE cache →
#     Groww/Refinitiv cache → parse → score → stamp/PDF), then the
#     lightweight SWS news enrichment.
#
#   NSE catalyst branch:
#     refresh-catalysts.mjs + refresh-nse-corporate.mjs, which feed the
#     Earnings Watch calendar and announcement/deal signals.
#
# SWS remains fatal. NSE catalyst failures remain non-fatal and are surfaced
# through aux_status, matching the old serial behavior. The barrier always
# waits for both branches before any exit, so a failed SWS scrape cannot leave
# a background NSE refresh orphaned or mid-write.
#
# SWS_AUTO_PR=0: suppress the inner script's own auto-PR. If left enabled,
# sws-refresh-api.sh would commit the data on its own branch and switch the
# working tree back to main, leaving stale picks-latest.json on disk and
# tripping our scanned_recent sanity check below. Nightly handles its own
# branch + commit + PR + auto-merge after the gate.
#
# News refresh (lightweight, NON-FATAL):
# Captures SWS Brief + Event activity for picks ∪ portfolio ∪ watchlist
# (~300 stocks). Augments data/sws/deep/<TICKER>.json with a `news[]` array
# and writes data/sws/news-latest.json for the PDF + dashboard.
# US/KR/TW then run the same enrichment path over every displayed leaderboard
# card and repack their regional deep tarballs so production modals receive the
# updated news without a full regional scrape.
#
# Failure here MUST NOT block the nightly: news is enrichment, not core.
# A SWS rate-limit during the news pass shouldn't trash a successful main
# scrape. We log the failure and continue to the sanity gate as if news
# wasn't run (the PDF and dashboard both render gracefully when news is
# absent or stale).
#
# ---- 3c. Catalysts + fundamentals + earnings refresh chain (non-fatal) ----
#
# Moved BEFORE the sanity gate so a scrape sanity failure cannot block
# these refreshes from reaching prod. They are INDEPENDENT of the SWS
# scrape output — the dashboard's Fundamentals + Earnings tabs should
# stay fresh even when the scrape itself is being debugged. The sanity-
# gate FAIL path below ships a separate data-only PR with whichever of
# these files changed.
#
# Each step is wrapped in `with_timeout` (GNU timeout / gtimeout when
# available, falls through to a no-op cap on stock macOS — see helper
# definition near the top) and treated as warning-only. A transient NSE
# failure here MUST NOT block the SWS push that may still succeed below.
# Mirrors the news-refresh pattern at step 3b.
#
# Order matters:
#   1. refresh-catalysts.mjs      → data/catalysts/events-latest.json
#   2. refresh-nse-corporate.mjs  → nse-announcements-rolling + bulk-block
#   3. refresh-fo-oi.sh           → data/nse-fo/oi-deltas-latest.json
#   4. refresh-fundamentals.mjs   → fundamentals.json (NSE; 8h freshness gate
#                                    so the daily fire refreshes — keeps it
#                                    well under the 48h staleness banner).
#                                    Used by stock detail modals — not the
#                                    earnings tab, which reads
#                                    fundamentalsHistory.json.
#   5. refresh-surveillance.mjs   → surveillance.json (NSE ASM/GSM; every run)
#   6. refresh-governance.mjs     → governance.json (NSE shareholding; 144h
#                                    gate — quarterly data. MUST follow step 4:
#                                    reads getAllFundamentals(), exits 1 if
#                                    the fundamentals snapshot is empty).
#   7. refresh-earnings.mjs       → data/catalysts/earnings-watch-*.json
#   8. step 3d (below)            → fundamentalsHistory.json (Yahoo per-quarter
#                                    EPS/revenue, 18h gate). Folded in here
#                                    after the standalone com.starbhai.sws-
#                                    fundamentals-history launchd job was
#                                    found dormant 2026-05-13 (script path
#                                    missing → exit 127 silently; file went
#                                    23 days stale). A budget-capped Yahoo
#                                    fetch in the nightly chain is more
#                                    reliable than a separate launchd job
#                                    that can rot when paths drift.
#   9. resolve-earnings-actuals.mjs → fills actual_verdict / actual_t1_close_inr
#                                    on archived predictions so the cap-lift
#                                    gate + ablation + weight-tuner have ground
#                                    truth. SWS news brief is the primary source
#                                    (zero network); Yahoo earningsHistory is
#                                    the fallback. Wired in 2026-05-18 after
#                                    actuals had not resolved since 2026-05-09
#                                    (382 past-date events stuck). Skippable
#                                    via SWS_SKIP_RESOLVE_ACTUALS=1.

# Step-3c auxiliary refresh status — each non-fatal refresh below records its
# outcome here; the COMMIT_BODY builder (step 5) reads this file and appends
# an "Auxiliary refreshes:" section to the commit + PR body, so a silently
# failed or skipped refresh shows up in the PR rather than only the log.
AUX_STATUS_FILE="data/sws/_aux-refresh-status.tmp"
: > "${AUX_STATUS_FILE}"
aux_status() {
  # aux_status <file> <OK|SKIPPED-fresh|FAILED|...> [age-hours]
  printf 'STEP3C: %s %s %s\n' "$1" "$2" "${3:-}" >> "${AUX_STATUS_FILE}"
}

extract_regional_deep_from_tarball() {
  # extract_regional_deep_from_tarball <us|kr|tw>
  local market="$1"
  local data_dir="data/sws-${market}"
  local deep_dir="${data_dir}/deep"
  local tarball="${data_dir}/deep-${market}.tar.gz"

  if [ -d "${deep_dir}" ] && [ -n "$(ls -A "${deep_dir}" 2>/dev/null)" ]; then
    return 0
  fi
  if [ ! -f "${tarball}" ]; then
    echo "[nightly] regional news ${market}: no ${tarball}; skipping tarball extraction"
    return 1
  fi

  echo "[nightly] regional news ${market}: extracting ${tarball} before enrichment"
  mkdir -p "${data_dir}"
  if tar -xzf "${tarball}" -C "${data_dir}"; then
    return 0
  fi
  echo "[nightly] regional news ${market}: extraction failed — enrichment may skip deep merges"
  return 1
}

pack_regional_deep_tarball() {
  # pack_regional_deep_tarball <us|kr|tw>
  local market="$1"
  local data_dir="data/sws-${market}"
  local deep_dir="${data_dir}/deep"
  local tarball="${data_dir}/deep-${market}.tar.gz"

  if [ ! -d "${deep_dir}" ] || [ -z "$(ls -A "${deep_dir}" 2>/dev/null)" ]; then
    echo "[nightly] regional news ${market}: no loose deep files to pack"
    return 1
  fi

  echo "[nightly] regional news ${market}: packing ${tarball}"
  if tar -czf "${tarball}" -C "${data_dir}" deep; then
    echo "[nightly] regional news ${market}: packed $(ls "${deep_dir}" | wc -l | tr -d ' ') deep files"
    return 0
  fi
  echo "[nightly] regional news ${market}: tarball pack failed — non-fatal"
  return 1
}

run_market_news_refresh() {
  # run_market_news_refresh <in|us|kr|tw>
  local market="$1"
  local label="${market}"

  if [ "${market}" = "in" ]; then
    label="india"
  elif ! extract_regional_deep_from_tarball "${market}"; then
    echo "[nightly] regional news ${market}: continuing without extraction"
  fi

  echo "[nightly] running ${label} news refresh (sws-news-sharded.sh ${market})..."
  if ! bash scripts/sws-news-sharded.sh "${market}" 2>&1 | sed "s/^/[news-${label}] /"; then
    echo "[nightly] ${label} news refresh failed — non-fatal, continuing"
  fi

  if [ "${market}" != "in" ]; then
    pack_regional_deep_tarball "${market}" || true
  fi
}

HEALTH_CRITICAL_FILES=(
  fundamentals.json
  fundamentalsHistory.json
  data/nse-fo/oi-deltas-latest.json
  data/catalysts/earnings-watch-latest.json
)

assert_health_critical_staged() {
  local unstaged
  unstaged=$(git diff --name-only -- "${HEALTH_CRITICAL_FILES[@]}" 2>/dev/null || true)
  if [ -n "${unstaged}" ]; then
    echo "[nightly] health-critical data changed but is not fully staged:"
    echo "${unstaged}" | sed 's/^/[nightly]   /'
    send_mail "🚨 SWS nightly — health-critical data not staged" \
"The nightly generated changes to health-critical files, but at least one
changed file was not staged for the publish commit at $(ts).

This would leave production with stale snapshot-health inputs, so the run
stopped before push/PR.

Unstaged health-critical files:
${unstaged}

Inspect:
  cd ${REPO_DIR}
  git status --short -- ${HEALTH_CRITICAL_FILES[*]}"
    exit 8
  fi
}

restore_non_deployable_generated_worksets() {
  # These are local working sets or refresh caches. Prod either consumes their
  # packed/aggregated snapshot or uses KV-backed state, so leaving thousands of
  # tracked file edits after a successful publish only creates operator noise.
  local restore_paths=(
    data/sws/deep
    data/sws/groww-stock-latest.json
    data/sectorOutlook/classified-news
    data/nse-fo/history
    data/coverage/coverage_gap.json
    data/coverage/coverage_report.md
    data/coverage/ground_truth.json
    data/coverage/groww_missing_candidates.json
    data/risk-lab/llm-disagreement-cache.json
  )
  echo "[nightly] restoring non-deployable generated working sets before commit..."
  git restore -- "${restore_paths[@]}" 2>/dev/null || true
  git clean -fd -- data/sws/deep data/sectorOutlook/classified-news data/nse-fo/history 2>/dev/null || true
}

run_sws_primary_branch() {
  echo "[nightly] running scripts/sws-refresh-api.sh (SWS_AUTO_PR=0; nightly creates the PR)..."
  SWS_AUTO_PR=0 bash scripts/sws-refresh-api.sh
  local sws_rc=$?
  if [ "${sws_rc}" -ne 0 ]; then
    echo "[nightly] sws-refresh-api.sh failed (exit ${sws_rc})"
    return "${sws_rc}"
  fi

  run_market_news_refresh in
  run_market_news_refresh us
  run_market_news_refresh kr
  run_market_news_refresh tw

  return 0
}

run_nse_catalyst_branch() {
  echo "[nightly] running NSE catalyst refresh branch..."

  if with_timeout 600 node scripts/refresh-catalysts.mjs 2>&1 | sed 's/^/[catalysts] /'; then
    aux_status "events-latest.json" "OK"
  else
    echo "[nightly] refresh-catalysts.mjs failed — non-fatal, continuing"
    aux_status "events-latest.json" "FAILED"
  fi

  if with_timeout 600 node scripts/refresh-nse-corporate.mjs 2>&1 | sed 's/^/[nse-corp] /'; then
    aux_status "nse-announcements-rolling.json" "OK"
  else
    echo "[nightly] refresh-nse-corporate.mjs failed — non-fatal, continuing"
    aux_status "nse-announcements-rolling.json" "FAILED"
  fi

  return 0
}

SWS_BRANCH_LOG="data/sws/sws-nightly-sws-branch.log"
NSE_BRANCH_LOG="data/sws/sws-nightly-nse-catalyst-branch.log"
: > "${SWS_BRANCH_LOG}"
: > "${NSE_BRANCH_LOG}"

echo "[nightly] starting SWS/Groww primary branch and NSE catalyst branch in parallel..."
run_sws_primary_branch > >(tee -a "${SWS_BRANCH_LOG}" | sed 's/^/[sws-branch] /') 2>&1 &
SWS_BRANCH_PID=$!
run_nse_catalyst_branch > >(tee -a "${NSE_BRANCH_LOG}" | sed 's/^/[nse-branch] /') 2>&1 &
NSE_BRANCH_PID=$!

SWS_BRANCH_RC=0
NSE_BRANCH_RC=0
if wait "${SWS_BRANCH_PID}"; then
  SWS_BRANCH_RC=0
else
  SWS_BRANCH_RC=$?
fi
if wait "${NSE_BRANCH_PID}"; then
  NSE_BRANCH_RC=0
else
  NSE_BRANCH_RC=$?
fi

echo "[nightly] parallel refresh barrier complete: sws_rc=${SWS_BRANCH_RC}, nse_rc=${NSE_BRANCH_RC}"

SWS_PRIMARY_FAILED=0
SWS_PRIMARY_FAILURE_BODY=""
if [ "${SWS_BRANCH_RC}" -ne 0 ]; then
  SWS_PRIMARY_FAILED=1
  SWS_PRIMARY_FAILURE_BODY="scripts/sws-refresh-api.sh exited non-zero at $(ts).

The NSE catalyst branch was allowed to finish before the auxiliary refresh
chain continues. The SWS scrape output will not ship, but independent
fundamentals/catalyst/macro-calendar data may still auto-ship as data-only."
  echo "[nightly] SWS primary branch failed — continuing auxiliary refresh chain before data-only ship"
fi

echo "[nightly] running remaining catalysts + fundamentals + earnings refresh chain..."

if with_timeout 120 node scripts/refresh-dividends.mjs 2>&1 | sed 's/^/[dividends] /'; then
  aux_status "dividends-upcoming.json" "OK"
else
  echo "[nightly] refresh-dividends.mjs failed — non-fatal, continuing"
  aux_status "dividends-upcoming.json" "FAILED"
fi

# NSE index constituents (Nifty 100 / Midcap 150 / Smallcap 250 / 500).
# Powers the universe-filter dropdown on the SWS Picks tab. Runs locally
# only (Vercel datacenter IPs would 403). Non-fatal: the server falls
# back to the hardcoded NIFTY500_SYMBOLS set if the JSON is stale/missing.
if with_timeout 300 node scripts/refresh-nse-index-constituents.mjs 2>&1 | sed 's/^/[nse-idx] /'; then
  aux_status "nse-index-constituents.json" "OK"
else
  echo "[nightly] refresh-nse-index-constituents.mjs failed — non-fatal, continuing"
  aux_status "nse-index-constituents.json" "FAILED"
fi

if with_timeout 600 bash scripts/refresh-fo-oi.sh 2>&1 | sed 's/^/[fo-oi] /'; then
  aux_status "oi-deltas-latest.json" "OK"
else
  echo "[nightly] refresh-fo-oi.sh failed — non-fatal, continuing"
  aux_status "oi-deltas-latest.json" "FAILED"
fi

# ---- 3c-bis. SWS universe rebuild (public sitemap crawl) — 11-day cadence ----
#
# Rebuilds data/sws/universe.json (the master ticker list the scrape iterates
# over) from SWS's PUBLIC sitemap — no login, no subscription risk (see the
# script header at scripts/sws-universe-from-sitemap.mjs). Picks up new
# listings / drops delistings and stamps data/sws/universe-meta.json, which
# /api/health/snapshots reads for the user-facing "SWS universe (Nd old)"
# staleness banner.
#
# WHY a separate cadence: this is NOT the daily scored-data refresh (that's
# sws-refresh-api.sh → picks-latest.json, run earlier this same nightly).
# Universe MEMBERSHIP changes rarely, so a daily ~580 MB sitemap crawl would
# be pure waste. The 264h (11-day) gate sits comfortably under the 336h (14d)
# staleness threshold in server.js, leaving a ~3-day margin so the banner
# never trips between rebuilds. Skips entirely (age=9999) if the sidecar is
# missing/unparseable, which forces a rebuild.
#
# NO --reset-progress on purpose: the live API pipeline resets its own
# progress-api-*.json for a full-universe pass each run (sws-refresh-api.sh),
# and the script's --reset-progress only touches the dormant legacy DOM-scrape
# progress-{1,2,3}.json. Under the full-pass model, reordering/growth of
# universe.json is safe — every ticker is still covered exactly once by its
# index%3 shard. The rebuilt universe takes effect on the NEXT nightly scrape.
UNIVERSE_AGE_HOURS=$(node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
if (!existsSync("data/sws/universe-meta.json")) { console.log(9999); process.exit(0); }
try {
  const j = JSON.parse(readFileSync("data/sws/universe-meta.json", "utf-8"));
  if (!j.generatedAt) { console.log(9999); process.exit(0); }
  const ms = Date.now() - new Date(j.generatedAt).getTime();
  console.log(Math.floor(ms / 3600000));
} catch { console.log(9999); }
' 2>/dev/null)
UNIVERSE_AGE_HOURS="${UNIVERSE_AGE_HOURS:-9999}"

if [ "${UNIVERSE_AGE_HOURS}" -lt 264 ]; then
  echo "[nightly] universe-meta.json is ${UNIVERSE_AGE_HOURS}h old — skipping rebuild (< 264h / 11d freshness)"
  aux_status "universe-meta.json" "SKIPPED-fresh" "${UNIVERSE_AGE_HOURS}"
else
  echo "[nightly] universe-meta.json is ${UNIVERSE_AGE_HOURS}h old — rebuilding universe from sitemap..."
  if with_timeout 600 node scripts/sws-universe-from-sitemap.mjs --merge 2>&1 | sed 's/^/[universe] /'; then
    aux_status "universe-meta.json" "OK"
  else
    echo "[nightly] sws-universe-from-sitemap.mjs failed — non-fatal; universe stays on prior snapshot"
    aux_status "universe-meta.json" "FAILED" "${UNIVERSE_AGE_HOURS}"
  fi
fi

# Macro regime refresh: handled by the STANDALONE cron com.starbhai.macro-only
# (scripts/refresh-macro-only.sh, every 2h). Decoupled from this nightly per
# the 2026-05-17 permanent fix — single-writer rule for data/macroRegime.json.
# Here we ONLY check freshness as a diagnostic; we do NOT write or commit the
# file (that would race the standalone cron).
MACRO_AGE_HOURS=$(node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
if (!existsSync("data/macroRegime.json")) { console.log(9999); process.exit(0); }
try {
  const j = JSON.parse(readFileSync("data/macroRegime.json", "utf-8"));
  if (!j.generatedAt) { console.log(9999); process.exit(0); }
  const ms = Date.now() - new Date(j.generatedAt).getTime();
  console.log(Math.floor(ms / 3600000));
} catch { console.log(9999); }
' 2>/dev/null)
if [ "${MACRO_AGE_HOURS:-9999}" -ge 18 ]; then
  echo "[nightly] data/macroRegime.json is ${MACRO_AGE_HOURS}h old — standalone macro-only cron may be unhealthy"
  aux_status "macroRegime.json" "STALE-${MACRO_AGE_HOURS}h"
else
  echo "[nightly] data/macroRegime.json is ${MACRO_AGE_HOURS}h old — fresh"
  aux_status "macroRegime.json" "OK-${MACRO_AGE_HOURS}h"
fi

# Macro calendar is global context and is safe for every market refresh to
# update. The script preserves the prior good file and avoids _updated bumps
# when official-source coverage is thin, so this is warning-only.
if with_timeout 300 node scripts/refresh-macro-calendar.mjs 2>&1 | sed 's/^/[macro-calendar] /'; then
  aux_status "macroCalendar.json" "OK"
else
  echo "[nightly] refresh-macro-calendar.mjs failed — non-fatal; prior calendar stays in place"
  aux_status "macroCalendar.json" "FAILED"
fi

# Fundamentals refresh: self-paced via an 8h freshness check. The daily 00:30
# fire refreshes the file, while same-day manual reruns can coast. This keeps
# fundamentals.json well below the 48h staleness banner. The earlier 20h gate
# let the file refresh only once it had ALREADY drifted >20h, which is how it
# reached the user-visible "2d old" banner. Skips entirely (age=9999) if the
# file is missing or unparseable, which forces a fresh pull.
FUND_AGE_HOURS=$(node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
if (!existsSync("fundamentals.json")) { console.log(9999); process.exit(0); }
try {
  const j = JSON.parse(readFileSync("fundamentals.json", "utf-8"));
  if (!j.generatedAt) { console.log(9999); process.exit(0); }
  const ms = Date.now() - new Date(j.generatedAt).getTime();
  console.log(Math.floor(ms / 3600000));
} catch { console.log(9999); }
' 2>/dev/null)
FUND_AGE_HOURS="${FUND_AGE_HOURS:-9999}"

if [ "${FUND_AGE_HOURS}" -lt 8 ]; then
  echo "[nightly] fundamentals.json is ${FUND_AGE_HOURS}h old — skipping refresh (< 8h freshness)"
  aux_status "fundamentals.json" "SKIPPED-fresh" "${FUND_AGE_HOURS}"
else
  echo "[nightly] fundamentals.json is ${FUND_AGE_HOURS}h old — running refresh..."
  if with_timeout 1800 node scripts/refresh-fundamentals.mjs 2>&1 | sed 's/^/[fundamentals] /'; then
    aux_status "fundamentals.json" "OK"
  else
    echo "[nightly] refresh-fundamentals.mjs failed — non-fatal, continuing"
    aux_status "fundamentals.json" "FAILED" "${FUND_AGE_HOURS}"
  fi
fi

# Surveillance (NSE ASM/GSM) — tiny (2 NSE calls), refreshed every run.
# Previously only the Vercel cron refreshed this, and that silently no-ops
# (NSE blocks Vercel datacenter IPs) — so surveillance.json went stale in
# prod. The local nightly is now the reliable refresh path.
if with_timeout 300 node scripts/refresh-surveillance.mjs 2>&1 | sed 's/^/[surveillance] /'; then
  aux_status "surveillance.json" "OK"
else
  echo "[nightly] refresh-surveillance.mjs failed — non-fatal, continuing"
  aux_status "surveillance.json" "FAILED"
fi

# Governance (NSE shareholding) — quarterly-cadence data, so a ~weekly
# (144h) freshness gate avoids pure-waste daily refreshes (cf. the
# /api/cron/refresh-governance comment in server.js). MUST run after the
# fundamentals block: refresh-governance.mjs reads getAllFundamentals()
# and exits 1 if that snapshot is empty. Same Vercel-IP no-op problem as
# surveillance — the local nightly is the reliable refresh path.
GOV_AGE_HOURS=$(node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
if (!existsSync("governance.json")) { console.log(9999); process.exit(0); }
try {
  const j = JSON.parse(readFileSync("governance.json", "utf-8"));
  if (!j.fetchedAt) { console.log(9999); process.exit(0); }
  const ms = Date.now() - new Date(j.fetchedAt).getTime();
  console.log(Math.floor(ms / 3600000));
} catch { console.log(9999); }
' 2>/dev/null)
GOV_AGE_HOURS="${GOV_AGE_HOURS:-9999}"

if [ "${GOV_AGE_HOURS}" -lt 144 ]; then
  echo "[nightly] governance.json is ${GOV_AGE_HOURS}h old — skipping refresh (< 144h freshness)"
  aux_status "governance.json" "SKIPPED-fresh" "${GOV_AGE_HOURS}"
else
  echo "[nightly] governance.json is ${GOV_AGE_HOURS}h old — running refresh..."
  if with_timeout 600 node scripts/refresh-governance.mjs 2>&1 | sed 's/^/[governance] /'; then
    aux_status "governance.json" "OK"
  else
    echo "[nightly] refresh-governance.mjs failed — non-fatal, continuing"
    aux_status "governance.json" "FAILED" "${GOV_AGE_HOURS}"
  fi
fi

# ---- 3d. fundamentalsHistory refresh (Yahoo per-quarter EPS/revenue) ----
#
# Required by services/earnings/signalAggregator.js:362-364 for the YoY
# trajectory that feeds Earnings Watch BEAT/INLINE/MISS predictions. SWS
# deep-scrape data contains annual history only (fiscal.yearly_history at
# scripts/sws-api-parser.mjs:375) — there is no quarterlyTimeSeries
# fragment in SWS's GraphQL schema, so Yahoo remains the only source for
# per-quarter dilutedEPS + totalRevenue.
#
# Folded in here after the standalone launchd job (com.starbhai.sws-
# fundamentals-history) was found dormant 2026-05-13 with a 23-day-stale
# file (the script path on disk had been moved/missing, every fire exited
# 127 silently). Folding into the unified pipeline removes a class of
# silent-failure modes — same pattern that produced the empty
# governance.json above.
#
# ORDERING: runs BEFORE refresh-earnings.mjs so the predictor's YoY-EPS
# trajectory component (component 8 in earningsPredictor.js) sees a fresh
# fundamentalsHistory.json instead of a stale standalone-job snapshot. Before
# this move, the scheduled SWS run executed earnings before the separate
# fundamentalsHistory job could refresh; that 04:00 standalone job had also
# been silently dead since 2026-05-13. Earnings is the only consumer of
# fundamentalsHistory, so this ordering is what makes the bundling sound.
#
# 18h freshness gate mirrors the fundamentals.json pattern: the daily 00:30
# fire refreshes, while same-day manual reruns can coast.
# Yahoo fetch is ~30 min wall-clock for the 744-symbol enriched universe,
# so the 2400s timeout leaves headroom for slow batches.
FH_AGE_HOURS=$(node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
if (!existsSync("fundamentalsHistory.json")) { console.log(9999); process.exit(0); }
try {
  const j = JSON.parse(readFileSync("fundamentalsHistory.json", "utf-8"));
  if (!j.generatedAt) { console.log(9999); process.exit(0); }
  const ms = Date.now() - new Date(j.generatedAt).getTime();
  console.log(Math.floor(ms / 3600000));
} catch { console.log(9999); }
' 2>/dev/null)
FH_AGE_HOURS="${FH_AGE_HOURS:-9999}"

if [ "${FH_AGE_HOURS}" -lt 18 ]; then
  echo "[nightly] fundamentalsHistory.json is ${FH_AGE_HOURS}h old — skipping refresh (< 18h freshness)"
else
  echo "[nightly] fundamentalsHistory.json is ${FH_AGE_HOURS}h old — running refresh..."
  # Prefer the incremental refresher if present (only re-fetches stocks
  # missing the latest quarter), fall back to the full fetcher otherwise.
  if [ -f scripts/refresh-fundamentals-history.mjs ]; then
    FH_SCRIPT="scripts/refresh-fundamentals-history.mjs"
  else
    FH_SCRIPT="scripts/fetch-fundamentals-history.mjs"
  fi
  # NOTE: must be `with_timeout`, NOT bare `timeout` — stock macOS has no
  # `timeout` binary (only `gtimeout` when Homebrew's coreutils is installed).
  # The wrapper at line 95-101 bridges all three platforms; calling `timeout`
  # directly here silently failed every macOS nightly run with
  # "line N: timeout: command not found" and `refresh-fundamentals-history.mjs`
  # was skipped — which meant the earnings predictor's YoY-EPS trajectory
  # component (`earningsPredictor.js` component 8) read a stale snapshot.
  if ! with_timeout 2400 node "${FH_SCRIPT}" 2>&1 | sed 's/^/[fund-history] /'; then
    echo "[nightly] ${FH_SCRIPT} failed — non-fatal; Earnings Watch trajectories stay on prior snapshot"
  fi
fi

echo "[nightly] running refresh-earnings.mjs --window 60 --past-window-days 14 (depends on the above)..."
if with_timeout 600 node scripts/refresh-earnings.mjs --window 60 --past-window-days 14 2>&1 | sed 's/^/[earnings] /'; then
  aux_status "earnings-watch-latest.json" "OK"
else
  echo "[nightly] refresh-earnings.mjs failed — non-fatal; tab stays on prior snapshot"
  aux_status "earnings-watch-latest.json" "FAILED"
fi

# Step 9: resolve actual_verdict / actual_t1_close_inr on archived predictions
# so cap-lift gate + ablation + weight-tuner have ground truth. SWS news brief
# is primary source (zero network), Yahoo earningsHistory the fallback.
if [ "${SWS_SKIP_RESOLVE_ACTUALS:-0}" = "1" ]; then
  echo "[sws-nightly] SKIP resolve-earnings-actuals (SWS_SKIP_RESOLVE_ACTUALS=1)"
else
  echo "[sws-nightly] resolve-earnings-actuals.mjs (timeout 300s)"
  with_timeout 300 node scripts/resolve-earnings-actuals.mjs || \
    echo "[sws-nightly] resolve-earnings-actuals.mjs FAILED — continuing (non-fatal)"
fi

# Step 9a2: Multibagger 5x strategy refresh — pure disk-to-disk join over
# picks-latest + macroRegime + catalyst feeds. Writes
# data/strategy/multibagger-scores-latest.json + catalyst-slate-latest.json
# + multibagger-health-latest.json. Budget ~90s, non-fatal.
if [ "${SWS_SKIP_MULTIBAGGER:-0}" = "1" ]; then
  echo "[sws-nightly] SKIP refresh-5x-strategy (SWS_SKIP_MULTIBAGGER=1)"
else
  echo "[sws-nightly] refresh-5x-strategy.mjs (timeout 120s)"
  with_timeout 120 node scripts/refresh-5x-strategy.mjs 2>&1 | sed 's/^/[5x] /' || \
    echo "[sws-nightly] refresh-5x-strategy.mjs FAILED — continuing (non-fatal; tab will show stale data)"
fi

# Step 9b: Risk Lab refresh — generates data/risk-lab/picks-adjusted-latest.json
# by layering the experimental macro/quality overlay on top of the just-written
# picks-latest.json + macroRegime.json. Read-only on production files; only
# writes to data/risk-lab/. Non-fatal — the lab is opt-in via per-user toggle
# and a stale lab file is recoverable on the next 00:30 fire.
echo "[sws-nightly] refresh-risk-lab.mjs (timeout 60s)"
with_timeout 60 node scripts/refresh-risk-lab.mjs 2>&1 | sed 's/^/[risk-lab] /' || \
  echo "[sws-nightly] refresh-risk-lab.mjs FAILED — continuing (non-fatal; lab tab will show stale data)"

echo "[sws-nightly] refresh macro-thesis-latest.json (timeout 30s)"
with_timeout 30 node --input-type=module -e '
import { writeMacroThesis } from "./services/macroThesis/thesisOrchestrator.js";
const { outputPath, thesis } = writeMacroThesis();
console.log(`[macro-thesis] wrote ${outputPath} regime=${thesis.regime?.regime || "<missing>"} branches=${thesis.branches?.length || 0}`);
' 2>&1 | sed 's/^/[macro-thesis] /' || \
  echo "[sws-nightly] macro thesis refresh FAILED — continuing (non-fatal; route will show prior thesis)"

# Step 9d2: Sector Outlook is refreshed inside scripts/sws-refresh-api.sh
# between seed scoring and final scoring. Do not run it again here: a later
# post-score refresh would make data/sectorOutlook/outlook-latest.json newer
# than the growing_sector_value section that was just written.
echo "[sws-nightly] sector outlook already refreshed inside sws-refresh-api.sh before final scoring"

echo "[nightly] checking health-critical snapshot freshness..."
HEALTH_GATE_OUT=$(node scripts/check-snapshot-health.mjs --strict --critical-only 2>&1)
HEALTH_GATE_RC=$?
echo "${HEALTH_GATE_OUT}" | sed 's/^/[health-gate] /'
if [ "${HEALTH_GATE_RC}" -ne 0 ]; then
  send_mail "🚨 SWS nightly — snapshot health gate failed" \
"The nightly refresh completed its auxiliary chain, but health-critical
snapshot inputs are still stale or missing at $(ts). The run stopped before
sanity, commit, push, PR, and auto-merge so production does not get fresh
SWS picks with stale fundamentals/F&O/earnings inputs.

Health gate output:
${HEALTH_GATE_OUT}

Inspect:
  cd ${REPO_DIR}
  node scripts/check-snapshot-health.mjs --strict --critical-only
  git status --short -- ${HEALTH_CRITICAL_FILES[*]}"
  exit 8
fi

# Date/branch labels — computed here so both the PASS path (step 5) and
# the sanity-gate FAIL path (data-only PR) can use them.
DATE=$(date +%Y-%m-%d)
RUN_TIME=$(date +%H%M)              # e.g. 0030 for the scheduled 00:30 fire
RUN_LABEL="${DATE} ${RUN_TIME:0:2}:${RUN_TIME:2:2}"   # "2026-05-07 00:30"

nightly_data_only_paths=(
  data/catalysts/
  data/nse-fo/oi-deltas-latest.json
  data/macroCalendar.json
  data/nse-index-constituents.json
  fundamentals.json
  surveillance.json
  governance.json
  fundamentalsHistory.json
)

ship_nightly_data_only() {
  local reason="$1"
  local data_changed
  data_changed=$(git status --short "${nightly_data_only_paths[@]}" 2>/dev/null | wc -l | tr -d ' ')
  DATA_PR_NOTE="(no non-SWS data changes detected — nothing to ship separately)"
  if [ "${data_changed}" -gt 0 ]; then
    echo "[nightly] ${reason}: ${data_changed} non-SWS data file(s) changed — auto-shipping data-only PR..."
    SWS_SHIP_MARKET=india-data-only \
    SWS_SHIP_ALLOW_WITHOUT_PICKS=1 \
    SWS_SHIP_RUN_LABEL="${RUN_LABEL} IST" \
    SWS_SHIP_COMMIT_SUBJECT="chore(data): refresh india data ${RUN_LABEL} IST" \
    SWS_SHIP_PR_TITLE="chore(data): refresh india data ${RUN_LABEL} IST" \
    SWS_SHIP_COMMIT_BODY="${reason}. Shipping only independent non-SWS generated data so stale dashboard banners do not linger while the India scrape is investigated." \
    SWS_SHIP_PR_BODY="${reason}.

This data-only PR intentionally excludes SWS scrape artifacts. It contains only independent generated data from the nightly auxiliary chain, including catalysts, fundamentals, index metadata, F&O OI deltas, Earnings Watch inputs, and macroCalendar.json.

Auto-generated by scripts/sws-nightly.sh." \
    sws_auto_ship_market "${nightly_data_only_paths[@]}"
    DATA_PR_NOTE="Data-only auto-ship attempted for ${data_changed} file(s). Check gh output above for the PR/merge result."
  fi
}

if [ "${SWS_PRIMARY_FAILED}" -eq 1 ]; then
  ship_nightly_data_only "SWS scrape pipeline failed before sanity gate"
  send_mail "🚨 SWS nightly — scrape pipeline failed" "${SWS_PRIMARY_FAILURE_BODY}

${DATA_PR_NOTE}

Last 50 lines:
$(tail -50 data/sws/refresh-api.log 2>/dev/null)"
  exit 6
fi

# ---- 4. Sanity gate ----
#
# Layered checks (L1 run integrity, L2 coverage, L3 data sanity, L6 picks
# coherence) live in scripts/sws-sanity-gate.mjs. Exit 0 = ship SWS scrape,
# exit 1 = block the SWS push but still ship the non-SWS data refreshes
# from step 3c in a separate data-only PR. Full machine-readable report at
# data/sws/_sanity/_latest.json.

echo "[nightly] running sanity gate..."
GATE_OUT=$(node scripts/sws-sanity-gate.mjs 2>&1)
GATE_RC=$?
echo "${GATE_OUT}" | sed 's/^/[gate] /'

# Single-line summary suitable for commit body / PR title.
SANITY_SUMMARY=$(echo "${GATE_OUT}" | grep -E '^\[sanity-gate\] verdict=' | head -1 | sed 's/^\[sanity-gate\] //')

# ---- Mid-run revert tripwire ----
#
# sws-refresh-api.sh runs the SAME sanity gate inline between stamp and
# PDF (--inline mode), BEFORE the ~106-min auxiliary chain. On pass, it
# drops data/sws/_sanity/_inline_pass.flag with a timestamp + verdict.
# If the outer gate (above) FAILED but that flag exists from THIS run,
# the failure must have been caused by something mutating SWS files
# during the aux chain (the 2026-05-18 22:37 IST class of failure where
# picks-latest.json was silently reverted between scoring and the gate).
#
# Discriminator: scoring-failed (both gates fail, no flag) vs data-
# reverted (inline passed, outer fails, flag present). Surface the
# diagnosis in both the log and the email body — without it, the
# operator has no way to tell apart these two very different failure
# modes.
INLINE_PASS_FLAG="data/sws/_sanity/_inline_pass.flag"
TRIPWIRE_DIAGNOSIS=""
if [ -f "${INLINE_PASS_FLAG}" ] && [ -s "${INLINE_PASS_FLAG}" ]; then
  INLINE_PASS_LINE=$(head -1 "${INLINE_PASS_FLAG}" 2>/dev/null || echo "(unreadable)")
  if [ ${GATE_RC} -ne 0 ]; then
    TRIPWIRE_DIAGNOSIS="MID-RUN REVERT DETECTED: inline sanity gate passed at ${INLINE_PASS_LINE} (post-stamp, pre-PDF) but the outer gate failed. Something mutated picks-latest.json or last-refresh.json during the ~106-min auxiliary chain (news/catalysts/fundamentals/etc.). Inspect git reflog, recent IDE actions, and any concurrent shells."
    echo "[nightly] TRIPWIRE: ${TRIPWIRE_DIAGNOSIS}"
  else
    echo "[nightly] inline+outer sanity gates BOTH passed — clean run"
  fi
elif [ ${GATE_RC} -ne 0 ]; then
  TRIPWIRE_DIAGNOSIS="SCORING-PHASE FAILURE: inline sanity gate did NOT pass (no _inline_pass.flag from this run) — the issue originates in refresh-api.sh's scoring/stamp/parse stages, not in the auxiliary chain. Check refresh-api.log for the inline gate's output."
  echo "[nightly] TRIPWIRE: ${TRIPWIRE_DIAGNOSIS}"
fi

if [ ${GATE_RC} -ne 0 ]; then
  echo "[nightly] sanity gate FAILED — refusing to push SWS scrape output"

  # The scrape was rejected, but the catalysts/fundamentals/fo-oi/earnings
  # refreshes from step 3c are INDEPENDENT and may have produced fresh
  # data. Ship those in a data-only PR so the staleness banner doesn't
  # flag Fundamentals + Earnings while we debug the scrape.
  # data/macroRegime.json deliberately excluded — single-writer rule per
  # the 2026-05-17 fix. The standalone com.starbhai.macro-only cron is
  # the ONLY committer of that file.
  DATA_FILES=(
    data/catalysts/
    data/nse-fo/oi-deltas-latest.json
    data/macroCalendar.json
    data/nse-index-constituents.json
    fundamentals.json
    surveillance.json
    governance.json
    fundamentalsHistory.json
  )
  DATA_CHANGED=$(git status --short "${DATA_FILES[@]}" 2>/dev/null | wc -l | tr -d ' ')
  DATA_PR_NOTE="(no non-SWS data changes detected — nothing to ship separately)"

  if [ "${DATA_CHANGED}" -gt 0 ]; then
    echo "[nightly] sanity FAIL but ${DATA_CHANGED} non-SWS data file(s) changed — opening data-only PR..."
    DATA_BRANCH="chore/sws-data-only-${DATE}-${RUN_TIME}"
    git branch -D "${DATA_BRANCH}" >/dev/null 2>&1 || true
    git checkout -b "${DATA_BRANCH}" 2>&1 | sed 's/^/[git] /' \
      || { echo "[nightly] WARNING: git checkout -b ${DATA_BRANCH} failed — data-only PR may be malformed"; \
           send_mail "⚠️ SWS nightly — data-only branch checkout failed" \
"git checkout -b ${DATA_BRANCH} failed at $(ts). The non-SWS data refresh could not be
shipped as a separate PR cleanly. SWS sanity gate had already failed this run."; }
    git add "${DATA_FILES[@]}"
    assert_health_critical_staged

    if git commit -m "chore(data): non-SWS refresh ${RUN_LABEL} — sanity blocked SWS scrape

Catalysts, fundamentals, fo-oi and earnings data refreshed cleanly. The
SWS scrape was blocked by the sanity gate this run, so picks-latest.json
and data/sws/deep/* are NOT in this PR — see the alert mail and re-run
sws-refresh once the upstream issue is resolved.

Sanity verdict: ${SANITY_SUMMARY:-unknown}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" 2>&1 | sed 's/^/[git] /'; then

      if git push -u origin "${DATA_BRANCH}" 2>&1 | sed 's/^/[git] /'; then
        DATA_PR_OUTPUT=$(gh pr create \
          --title "chore(data): non-SWS refresh ${RUN_LABEL} — SWS sanity blocked" \
          --body "Sanity gate FAILED on the SWS scrape, but the catalysts/fundamentals/fo-oi/earnings/macro-calendar refresh ran cleanly. Shipping those files separately so the dashboard's Fundamentals + Earnings tabs don't stagnate while we debug the scrape.

Sanity verdict: ${SANITY_SUMMARY:-unknown}

Auto-generated by \`scripts/sws-nightly.sh\` when the SWS scrape is blocked by the sanity gate." 2>&1)
        DATA_PR_URL=$(echo "${DATA_PR_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)
        if [ -n "${DATA_PR_URL}" ]; then
          DATA_PR_NOTE="Data-only PR shipped: ${DATA_PR_URL}"
          if [ "${AUTO_MERGE}" = "1" ]; then
            # No --delete-branch — see the AUTO_MERGE block in step 6 (#218).
            gh pr merge "${DATA_PR_URL}" --squash --auto 2>&1 | sed 's/^/[gh] /' || \
              gh pr merge "${DATA_PR_URL}" --squash 2>&1 | sed 's/^/[gh] /' || \
              echo "[nightly] data-only PR auto-merge failed — manual review required"
          fi
        else
          DATA_PR_NOTE="Data-only commit pushed (${DATA_BRANCH}) but gh pr create failed: ${DATA_PR_OUTPUT}"
        fi
      else
        DATA_PR_NOTE="Data-only commit succeeded but git push to origin/${DATA_BRANCH} failed"
      fi
    else
      DATA_PR_NOTE="Data-only commit produced no changes (likely all files identical to main)"
    fi

    # Return the working copy to a clean base. Do NOT `git checkout main` —
    # a worktree may hold the main ref. -B ${BASE_BRANCH} mirrors the
    # git-sync stage and is worktree-safe. Uncommitted SWS scrape files are
    # left on disk for inspection; the next run's autostash tidies them.
    git checkout -B "${BASE_BRANCH}" origin/main 2>&1 | sed 's/^/[git] /' \
      || echo "[nightly] couldn't return to ${BASE_BRANCH} — next run's git-sync will recover"
  fi

  # Augment email body with timestamps and the tripwire diagnosis (Layer E
  # of the 2026-05-19 RCA plan). Without this, the operator sees just
  # `age_hours: 16.73, threshold: 20` and has to manually check whether
  # this was a real staleness or a mid-run revert.
  PICKS_SCANNED_AT=$(node -p "JSON.parse(require('fs').readFileSync('data/sws/picks-latest.json','utf-8')).scanned_at" 2>/dev/null || echo "(unreadable)")
  LR_STARTED_AT=$(node -p "JSON.parse(require('fs').readFileSync('data/sws/last-refresh.json','utf-8')).started_at || '(field absent — pre-upgrade)'" 2>/dev/null || echo "(unreadable)")
  LR_FINISHED_AT=$(node -p "JSON.parse(require('fs').readFileSync('data/sws/last-refresh.json','utf-8')).finished_at" 2>/dev/null || echo "(unreadable)")

  send_mail "🚨 SWS nightly — sanity gate failed (${SANITY_SUMMARY:-no summary})" "Scrape completed but sanity gate REJECTED the SWS output at $(ts). SWS data NOT pushed to prod.

${DATA_PR_NOTE}

Diagnosis:
${TRIPWIRE_DIAGNOSIS:-(no tripwire signal — likely a real data issue caught by the gate)}

Timestamps:
  picks-latest.json scanned_at: ${PICKS_SCANNED_AT}
  last-refresh.json started_at: ${LR_STARTED_AT}
  last-refresh.json finished_at: ${LR_FINISHED_AT}
  sanity-gate ran at:           $(ts)

Gate output:
${GATE_OUT}

Full report: data/sws/_sanity/_latest.json
Inline-pass flag: ${INLINE_PASS_FLAG} (present=mid-run-revert candidate; absent=scoring-phase failure)
Inspect data/sws/picks-latest.json and data/sws/last-refresh.json. If false alarm, push manually."
  exit 7
fi

# The inner sws-refresh-api.sh normally packs data/sws/deep.tar.gz inside its
# own auto-PR block. Nightly suppresses that block with SWS_AUTO_PR=0 because
# this outer script owns the branch/PR, so pack here after the sanity gate and
# after the non-fatal news enrichment has mutated deep/*.json. Prod cannot ship
# loose deep files (see .vercelignore); a stale tarball means stale modals even
# when picks-latest.json is fresh.
echo "[nightly] packing India deep tarball for Vercel..."
if ! bash scripts/sws-pack-deep.sh 2>&1 | sed 's/^/[pack-deep] /'; then
  echo "[nightly] data/sws/deep.tar.gz pack failed — refusing to ship stale modal data"
  send_mail "🚨 SWS nightly — deep tarball pack failed" \
"SWS scrape and sanity gate passed at $(ts), but scripts/sws-pack-deep.sh failed.

Prod serves India stock-detail modals from data/sws/deep.tar.gz, not loose
data/sws/deep/*.json. Shipping without a fresh tarball would deploy fresh
leaderboard cards with stale modal prices/returns.

Inspect data/sws/sws-nightly.log and run:

  bash scripts/sws-pack-deep.sh"
  exit 8
fi

echo "[nightly] running packed deep price freshness gate..."
PRICE_TARBALL_GATE_OUT=$(node scripts/sws-price-freshness-gate.mjs --source tarball --human 2>&1)
PRICE_TARBALL_GATE_RC=$?
printf '%s\n' "${PRICE_TARBALL_GATE_OUT}" | sed 's/^/[price-gate] /'
if [ "${PRICE_TARBALL_GATE_RC}" -ne 0 ]; then
  echo "[nightly] packed deep price freshness gate failed — refusing to ship stale modal data"
  send_mail "🚨 SWS nightly — price freshness gate failed" \
"SWS scrape and sanity gate passed at $(ts), and data/sws/deep.tar.gz was rebuilt, but the deployable tarball still failed the price freshness gate.

Prod serves India stock-detail modals from data/sws/deep.tar.gz, so shipping now could deploy stale Total Returns or modal prices even when loose deep files are fresh.

Gate output:

${PRICE_TARBALL_GATE_OUT}"
  exit 8
fi

# ---- 4b. Coverage drift check ----
#
# Re-derives the NSE+BSE active equity ground truth and reports any drift
# in our SWS universe coverage. Non-blocking: a transient NSE/BSE master
# fetch failure or a real gap that opens up (new IPO, NSE rebalance) gets
# surfaced via mail + PR body but does NOT fail the nightly. Coverage is
# self-healing — Step 4 of the coverage plan re-merges via PR when the
# operator decides.
echo "[nightly] running coverage-gap-analysis (non-blocking)..."
COVERAGE_OUT=$(node scripts/coverage-gap-analysis.mjs --refresh-sme 2>&1) || true

# Pull the headline numbers from the freshly-written JSON. If the script
# couldn't run (e.g. NSE blocked us, BSE master missing) leave the line
# empty rather than tripping on a missing file.
COVERAGE_LINE=$(node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
const p = "data/coverage/coverage_gap.json";
if (!existsSync(p)) { console.log(""); process.exit(0); }
try {
  const g = JSON.parse(readFileSync(p, "utf-8"));
  const drift = (g.unmatched > 50 && g.actionableCount > 0) ? " ⚠️ drift" : "";
  console.log(`coverage: ${g.matched}/${g.groundTruthCount} (${g.coveragePct}%), gap=${g.unmatched}, sws-extras=${g.swsExtrasCount}${drift}`);
} catch (e) { console.log(""); }
' 2>/dev/null)
echo "[nightly] ${COVERAGE_LINE:-coverage: <unavailable>}"

restore_non_deployable_generated_worksets

# ---- 5. Commit + push ----

# data/macroRegime.json deliberately excluded — single-writer rule per
# the 2026-05-17 fix. The standalone com.starbhai.macro-only cron commits it.
CHANGED_FILES=$(git status --short \
  data/sws/deep.tar.gz \
  data/sws/picks-latest.json \
  data/sws/last-refresh.json \
  data/sws/sws-scored-universe.json \
  data/sws/v4-universe-stats.json \
  data/sws/v3-universe-stats.json \
  data/sws/universe.json \
  data/sws/universe-meta.json \
  data/sws/_sanity/_latest.json \
  data/sws/groww-stock-failed.json \
  data/sws/groww-pe-latest.json \
  data/sws/groww-pe-failed.json \
  data/sws/nse-event-calendar.json \
  data/sws/chronos-forecast-latest.json \
  data/sws/chronos-forecast-health.json \
  data/sws-us/deep-us.tar.gz \
  data/sws-kr/deep-kr.tar.gz \
  data/sws-tw/deep-tw.tar.gz \
  data/sectorOutlook/outlook-latest.json \
  data/coverage/bse_equity_active.json \
  data/risk-lab/picks-adjusted-latest.json \
  data/risk-lab/quality-flags-latest.json \
  data/risk-lab/macro-thesis-latest.json \
  data/strategy/multibagger-scores-latest.json \
  data/strategy/catalyst-slate-latest.json \
  data/strategy/multibagger-health-latest.json \
  data/strategy/multibagger-portfolio.json \
  data/nse-index-constituents.json \
  data/catalysts/ \
  data/nse-fo/oi-deltas-latest.json \
  data/macroCalendar.json \
  fundamentals.json \
  surveillance.json \
  governance.json \
  fundamentalsHistory.json \
  2>/dev/null | wc -l | tr -d ' ')
if [ "${CHANGED_FILES}" -eq 0 ]; then
  echo "[nightly] no SWS data changes detected — nothing to commit"
  send_mail "ℹ️ SWS nightly — no data changes" "Pipeline ran clean but no files changed. Likely SWS upstream returned identical data, or scrape was skipped."
  [ -n "${SWS_NIGHTLY_STABLE_COPY:-}" ] && rm -f "${SWS_NIGHTLY_STABLE_COPY}" 2>/dev/null || true
  trap - EXIT  # clean no-op exit — don't fire Slack failure trap
  exit 0
fi

# DATE / RUN_TIME / RUN_LABEL were computed earlier (before the sanity gate)
# so the data-only PR path could use them too. Only BRANCH is new here.
BRANCH="chore/sws-auto-refresh-${DATE}-${RUN_TIME}"   # unique per fire even if same day

# Clean up any prior local branch with same name (e.g., from interrupted run)
git branch -D "${BRANCH}" >/dev/null 2>&1 || true
# Loud-fail: a swallowed checkout here would commit SWS output onto the wrong
# branch. ${BRANCH} is chore/sws-auto-refresh-${DATE}-${RUN_TIME}, force-deleted
# just above, so a worktree collision is near-impossible — but mail + exit if so.
if ! git checkout -b "${BRANCH}" 2>&1 | sed 's/^/[git] /'; then
  echo "[nightly] could not create branch ${BRANCH}"
  send_mail "🚨 SWS nightly — git checkout -b failed" \
"git checkout -b ${BRANCH} failed at $(ts). SWS scrape output is uncommitted on disk
(branch ${BASE_BRANCH}). The next run's autostash will tidy it. Inspect manually:

$(git status 2>&1 | head -30)

$(git worktree list 2>&1)"
  exit 8
fi
# NOTE: the working copy is intentionally left on ${BRANCH} at end of run.
# The next run's git-sync (git checkout -B ${BASE_BRANCH} origin/main) does
# not care what branch it starts on, so no restore step is needed here.

# data/macroRegime.json deliberately excluded — single-writer rule per
# the 2026-05-17 fix. The standalone com.starbhai.macro-only cron commits it.
git add data/sws/deep.tar.gz \
        data/sws/picks-latest.json \
        data/sws/last-refresh.json \
        data/sws/sws-scored-universe.json \
        data/sws/v4-universe-stats.json \
        data/sws/v3-universe-stats.json \
        data/sws/_sanity/_latest.json \
        data/sws/groww-stock-failed.json \
        data/sws/groww-pe-latest.json \
        data/sws/groww-pe-failed.json \
        data/sws/universe.json \
        data/sws/universe-meta.json \
        data/sws/nse-event-calendar.json \
        data/sws/chronos-forecast-latest.json \
        data/sws/chronos-forecast-health.json \
        data/sws-us/deep-us.tar.gz \
        data/sws-kr/deep-kr.tar.gz \
        data/sws-tw/deep-tw.tar.gz \
        data/sectorOutlook/outlook-latest.json \
        data/coverage/bse_equity_active.json \
        data/risk-lab/picks-adjusted-latest.json \
        data/risk-lab/quality-flags-latest.json \
        data/risk-lab/macro-thesis-latest.json \
        data/strategy/multibagger-scores-latest.json \
        data/strategy/catalyst-slate-latest.json \
        data/strategy/multibagger-health-latest.json \
        data/strategy/multibagger-portfolio.json \
        data/nse-index-constituents.json \
        data/catalysts/ \
        data/nse-fo/oi-deltas-latest.json \
        data/macroCalendar.json \
        fundamentals.json \
        surveillance.json \
        governance.json \
        fundamentalsHistory.json
assert_health_critical_staged

# Inner pipeline regenerates the daily picks PDF — ship it in this same PR
# (previously the inner script's auto-PR added it; now we own that step).
[ -d reports/sws-picks ] && git add reports/sws-picks/*.pdf 2>/dev/null

# Build commit body from sanity-gate summary
COMMIT_BODY=$(COVERAGE_LINE="${COVERAGE_LINE}" SANITY_SUMMARY="${SANITY_SUMMARY}" node --input-type=module -e '
import {readFileSync, existsSync} from "fs";
const lr = JSON.parse(readFileSync("data/sws/last-refresh.json","utf-8"));
const picks = JSON.parse(readFileSync("data/sws/picks-latest.json","utf-8"));
const sc = picks.sections || {};
const lines = [
  `Automated nightly refresh via launchd. Sanity gate passed.`,
  ``,
  `- scored: ${lr.scored_count}, failed shards: ${lr.shards_failed}`,
  `- duration: ${lr.duration_seconds}s`,
  `- sections: top30=${sc.top_ranked_30_v3?.length}, best_to_buy_now=${sc.best_to_buy_now?.length}, deep_value=${sc.deep_value?.length}, growing_sector_value=${sc.growing_sector_value?.length}, quality_growth=${sc.quality_growth?.length}, best_fundamentals=${sc.best_fundamentals?.length}, midterm=${sc.midterm?.length}, dividend_aristocrats=${sc.dividend_aristocrats?.length}, smallcap_gems=${sc.smallcap_gems?.length}, upcoming_earnings=${sc.upcoming_earnings?.length}, avoid=${sc.avoid?.length}`,
];
if (process.env.SANITY_SUMMARY) lines.push(`- sanity: ${process.env.SANITY_SUMMARY}`);
if (process.env.COVERAGE_LINE) lines.push(`- ${process.env.COVERAGE_LINE}`);
// Surface any WARN findings inline so reviewers see them in the PR body.
try {
  const sp = "data/sws/_sanity/_latest.json";
  if (existsSync(sp)) {
    const r = JSON.parse(readFileSync(sp, "utf-8"));
    if (r.warn_count > 0) {
      lines.push(``, `Sanity warnings (${r.warn_count}):`);
      for (const [layer, info] of Object.entries(r.layers || {})) {
        for (const c of info.checks || []) {
          if (!c.ok && c.severity === "WARN") {
            lines.push(`- ${layer}/${c.name}`);
          }
        }
      }
    }
  }
} catch {}
// Auxiliary (step-3c) refresh outcomes — surfaces a silently failed or
// skipped non-SWS refresh in the PR body instead of only the launchd log.
try {
  const ax = "data/sws/_aux-refresh-status.tmp";
  if (existsSync(ax)) {
    const rows = readFileSync(ax, "utf-8").split("\n")
      .filter((l) => l.startsWith("STEP3C: "))
      .map((l) => l.slice(8).trim().split(/\s+/));
    if (rows.length > 0) {
      lines.push(``, `Auxiliary refreshes:`);
      for (const [file, status, age] of rows) {
        lines.push(`- ${file}: ${status}${age ? ` (${age}h old)` : ""}`);
      }
    }
  }
} catch {}
console.log(lines.join("\n"));
' 2>/dev/null)

git commit -m "chore(sws): auto-refresh ${RUN_LABEL} — full universe rescan

${COMMIT_BODY}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" 2>&1 | sed 's/^/[git] /'
COMMIT_RC=${PIPESTATUS[0]}

# Guard (2026-05-22 permanent fix): the commit is piped to sed and the script runs
# without `set -e`, so a failed `git commit` used to be silently ignored — the run
# then pushed a commitless branch and died at `gh pr create` with "No commits
# between main and <branch>" (exit 8), masking the real cause (unmerged macro-cron
# files in the index). Fail loud HERE instead of pushing an empty branch.
# ${PIPESTATUS[0]} is git's own rc — robust whether or not pipefail is set.
if [ "${COMMIT_RC}" -ne 0 ]; then
  echo "[nightly] git commit failed (rc=${COMMIT_RC}) — refusing to push an empty branch"
  send_mail "🚨 SWS nightly — git commit failed" "git commit returned ${COMMIT_RC} at $(ts).
NOT pushing ${BRANCH}: a commitless branch would fail PR creation with
'No commits between main and ${BRANCH}'. Most likely unmerged paths in the index
that the macro-cron self-heal did not cover. Inspect:

  cd ${REPO_DIR}
  git status
  git ls-files -u

Last 30 lines of nightly log:
$(tail -30 ${LOG})"
  exit 8
fi

if ! git push -u origin "${BRANCH}" 2>&1 | sed 's/^/[git] /'; then
  echo "[nightly] git push failed"
  send_mail "🚨 SWS nightly — git push failed" "Commit succeeded but git push origin ${BRANCH} failed at $(ts). Manual investigation needed.

Last 30 lines of nightly log:
$(tail -30 ${LOG})"
  exit 8
fi

# ---- 6. Open PR + auto-merge ----

PR_BODY="Automated SWS refresh — fired at ${RUN_LABEL} IST.

${COMMIT_BODY}

Auto-generated by \`scripts/sws-nightly.sh\` running from launchd. Scheduled fire: 00:30 IST daily.

🤖 No human in the loop — sanity gate enforces minimum data quality before push."

# gh pr create writes warnings ("Warning: 3 uncommitted changes") to stderr.
# Capture stdout+stderr for diagnostics, but extract ONLY the pull-request URL
# line for the ref passed to gh pr merge — otherwise the warning text gets
# concatenated with the URL and the subsequent merge fails with
# "invalid qualified head ref format".
PR_OUTPUT=$(gh pr create \
  --title "chore(sws): auto-refresh ${RUN_LABEL} — full universe rescan" \
  --body "${PR_BODY}" 2>&1)
PR_RC=$?
PR_URL=$(echo "${PR_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)

if [ ${PR_RC} -ne 0 ] || [ -z "${PR_URL}" ]; then
  echo "[nightly] gh pr create failed: ${PR_OUTPUT}"
  send_mail "🚨 SWS nightly — gh pr create failed" "Branch was pushed (${BRANCH}) but PR creation failed at $(ts).

Output:
${PR_OUTPUT}

You can manually open the PR at https://github.com/mayanktaluja/stock-platform/compare/${BRANCH}"
  exit 8
fi

echo "[nightly] PR created: ${PR_URL}"

if [ "${AUTO_MERGE}" = "1" ]; then
  echo "[nightly] enabling auto-merge..."
  # --auto queues merge after required status checks pass (Smoke + unit tests).
  # Falls back to immediate --squash if --auto isn't enabled on the repo.
  # No --delete-branch: its local cleanup fails when a worktree holds main (cf. #218); the repo's delete_branch_on_merge does remote cleanup.
  if ! gh pr merge "${PR_URL}" --squash --auto 2>&1 | sed 's/^/[gh] /'; then
    echo "[nightly] --auto failed, attempting immediate squash-merge..."
    gh pr merge "${PR_URL}" --squash 2>&1 | sed 's/^/[gh] /' || {
      echo "[nightly] both auto and immediate merge failed — manual merge required"
      send_mail "⚠️ SWS nightly — PR open but unmerged" "PR ${PR_URL} created but auto-merge failed. Manual review/merge required.

$(tail -30 ${LOG})"
      [ -n "${SWS_NIGHTLY_STABLE_COPY:-}" ] && rm -f "${SWS_NIGHTLY_STABLE_COPY}" 2>/dev/null || true
      trap - EXIT  # warning, but commit/push succeeded — don't fire Slack failure trap
      exit 0
    }
  fi
else
  echo "[nightly] AUTO_MERGE=0 — leaving PR open for manual review"
fi

# ---- 7. Mail success summary ----

ELAPSED=$(($(date +%s) - START_EPOCH))

# Subject reflects sanity verdict so the operator can see at a glance whether
# any layered checks raised a warning (push happened, but worth a look).
MAIL_SUBJECT_PREFIX="✅ SWS auto-refresh OK"
if echo "${SANITY_SUMMARY:-}" | grep -q 'verdict=WARN'; then
  MAIL_SUBJECT_PREFIX="⚠️ SWS auto-refresh OK with warnings"
fi

send_mail "${MAIL_SUBJECT_PREFIX} — ${RUN_LABEL} IST ($((ELAPSED/60))m)" "SWS refresh completed at $(ts) in $((ELAPSED/60))m $((ELAPSED%60))s.

Fire: ${RUN_LABEL} IST
PR: ${PR_URL}
Branch: ${BRANCH} (deleted on merge)

${COMMIT_BODY}

---
Sanity gate output:
${GATE_OUT}

Full sanity report: data/sws/_sanity/_latest.json
---

Vercel will redeploy main once CI green. Production data should be fresh shortly."

echo "[nightly] DONE in ${ELAPSED}s ($(ts))"

# Successful run — clear the Slack failure trap so the final `exit 0` doesn't
# fire it. Mid-script `exit N` paths (panic flag, battery, sanity gate, push
# failure, etc.) still trigger the trap by design.
[ -n "${SWS_NIGHTLY_STABLE_COPY:-}" ] && rm -f "${SWS_NIGHTLY_STABLE_COPY}" 2>/dev/null || true
trap - EXIT
exit 0
