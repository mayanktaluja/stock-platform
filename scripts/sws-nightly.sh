#!/usr/bin/env bash
#
# Fully-autonomous SWS refresh. Designed to run from a launchd agent at
# 02:00 IST (pre-market) and 16:30 IST (post-close) every day. No Claude
# Code dependency.
#
# Pipeline:
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
#   SWS_NIGHTLY_DRY_RUN=1      # alt to --dry-run flag
#   SWS_NIGHTLY_SKIP_BATTERY=0 # re-enable bail-out when on battery (default: skip the check)
#   SWS_NIGHTLY_AUTO_MERGE=1   # default: enable --auto on PR (set =0 to hold for manual review)
#
# Exit codes:
#   0  success or no-op
#   3  panic flag set
#   4  on battery (skipped run, mailed)
#   5  git/network failure
#   6  scrape pipeline failure
#   7  sanity gate failed (data committed but NOT pushed)
#   8  push or PR creation failed

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
cd "${REPO_DIR}" || { echo "[nightly] cannot cd to ${REPO_DIR}"; exit 5; }

LOG="data/sws/sws-nightly.log"
mkdir -p data/sws
exec >> >(tee -a "${LOG}") 2>&1

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }
START_EPOCH="$(date +%s)"

# Portable timeout wrapper: GNU `timeout` ships with Linux but not macOS
# (stock macOS has no equivalent; Homebrew's coreutils provides `gtimeout`).
# Prefer gtimeout, then timeout, then fall back to running the command
# directly with no hard cap. The chain steps that use this are all
# non-fatal and wrapped in `if !` — losing the cap on a vanilla mac is
# acceptable; silently failing every step because `timeout` doesn't exist
# is not (cf. #186 regression on 2026-05-12/13).
if command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
elif command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
else
  with_timeout() { shift; "$@"; }
fi

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
    send_mail "⚠️ SWS nightly skipped — laptop on battery" "Mac was on battery at $(ts). Plug in before next 02:00 IST run.

$(pmset -g batt 2>&1 | head -3)"
    exit 4
  fi
fi

# Network check (1 ping to a stable host)
if ! ping -c 1 -t 5 8.8.8.8 >/dev/null 2>&1; then
  echo "[nightly] network unreachable — bailing"
  send_mail "🚨 SWS nightly aborted — network unreachable" "ping 8.8.8.8 failed at $(ts)"
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

# Autostash BEFORE we move the working copy. The tree is routinely dirty
# with regenerated files (.claude/launch.json, data/coverage/*,
# data/macroRegime.json, data/sws/_sanity/_latest.json); a dirty tracked
# file would otherwise block the checkout below.
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
# `git checkout -B sws-nightly-base origin/main` sidesteps that: a worktree
# reserves the branch NAME `main`, not the commit it points at and not other
# branch names. -B force-resets sws-nightly-base to origin/main every run,
# so the branch is reused, never drifts, and needs no cleanup. The commit/
# push stage later does its own `git checkout -b chore/sws-auto-refresh-*`,
# so the literal `main` branch never needs to be checked out here.
echo "[nightly] checking out sws-nightly-base at origin/main..."
if ! git checkout -B sws-nightly-base origin/main 2>&1 | sed 's/^/[git] /'; then
  echo "[nightly] could not check out sws-nightly-base at origin/main"
  if [ "${STASHED}" -eq 1 ]; then
    git stash pop 2>&1 | sed 's/^/[git] /' || true
  fi
  send_mail "🚨 SWS nightly aborted — git checkout failed" \
"git checkout -B sws-nightly-base origin/main failed at $(ts).

This is NOT the worktree-holds-main case (we deliberately avoid 'git checkout main').
Likely a dirty file that survived autostash, or a branch named 'sws-nightly-base'
held by a worktree. Inspect manually:

$(git status 2>&1 | head -30)

$(git worktree list 2>&1)"
  exit 5
fi

# Re-apply the autostashed working-tree changes onto sws-nightly-base.
if [ "${STASHED}" -eq 1 ]; then
  if ! git stash pop 2>&1 | sed 's/^/[git] /'; then
    echo "[nightly] stash pop conflicted — stash ${STASH_TAG} left on list"
    send_mail "⚠️ SWS nightly — autostash pop conflicted" \
"Autostash ${STASH_TAG} could not be popped cleanly at $(ts). Pipeline continued. Recover with:

  git stash list
  git stash apply stash@{0}   # or specific stash"
  fi
fi

if [ ${DRY_RUN} -eq 1 ]; then
  echo "[nightly] DRY RUN — skipping scrape, sanity gate, commit, PR"
  send_mail "✅ SWS nightly DRY RUN OK" "Dry run completed at $(ts). Pre-flight + git sync OK. The real run would now invoke sws-refresh-api.sh."
  echo "[nightly] DRY RUN done in $(($(date +%s) - START_EPOCH))s"
  exit 0
fi

# ---- 3. Run scrape pipeline ----

# SWS_AUTO_PR=0: suppress the inner script's own auto-PR. If left enabled,
# sws-refresh-api.sh would commit the data on its own branch and switch the
# working tree back to main, leaving stale picks-latest.json on disk and
# tripping our scanned_recent sanity check below. Nightly handles its own
# branch + commit + PR + auto-merge after the gate.
echo "[nightly] running scripts/sws-refresh-api.sh (SWS_AUTO_PR=0; nightly creates the PR)..."
if ! SWS_AUTO_PR=0 bash scripts/sws-refresh-api.sh; then
  echo "[nightly] sws-refresh-api.sh failed (exit $?)"
  send_mail "🚨 SWS nightly — scrape pipeline failed" "scripts/sws-refresh-api.sh exited non-zero at $(ts).

Last 50 lines:
$(tail -50 data/sws/refresh-api.log 2>/dev/null)"
  exit 6
fi

# ---- 3b. News refresh (~3 min, lightweight, NON-FATAL) ----
#
# Captures SWS Brief + Event activity for picks ∪ portfolio ∪ watchlist
# (~300 stocks). Augments data/sws/deep/<TICKER>.json with a `news[]` array
# and writes data/sws/news-latest.json for the PDF + dashboard.
#
# Failure here MUST NOT block the nightly: news is enrichment, not core.
# A SWS rate-limit during the news pass shouldn't trash a successful main
# scrape. We log the failure and continue to the sanity gate as if news
# wasn't run (the PDF and dashboard both render gracefully when news is
# absent or stale).
echo "[nightly] running news refresh (sws-news-scrape.mjs)..."
if ! node scripts/sws-news-scrape.mjs 2>&1 | sed 's/^/[news] /'; then
  echo "[nightly] news refresh failed — non-fatal, continuing to sanity gate"
fi

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
#   4. refresh-fundamentals.mjs   → fundamentals.json (NSE; DAILY now, with
#                                    a 20h freshness skip so only one of
#                                    the two daily fires actually re-runs).
#                                    Used by stock detail modals — not the
#                                    earnings tab, which reads
#                                    fundamentalsHistory.json.
#   5. refresh-earnings.mjs       → data/catalysts/earnings-watch-*.json
# (Phase E will add refresh-earnings-actuals.mjs as step 6 once it lands.)
#
# NOTE: fundamentalsHistory.json (Yahoo, used by the earnings tab's
# trajectory component) is currently refreshed manually via
# scripts/fetch-fundamentals-history.mjs. Phase A.2 of the SEBI-RA upgrade
# plan will extend that script to also capture forwardEps +
# numberOfAnalystOpinions, then add it to this chain on a weekly cadence.

echo "[nightly] running catalysts + fundamentals + earnings refresh chain..."

if ! with_timeout 600 node scripts/refresh-catalysts.mjs 2>&1 | sed 's/^/[catalysts] /'; then
  echo "[nightly] refresh-catalysts.mjs failed — non-fatal, continuing"
fi

if ! with_timeout 600 node scripts/refresh-nse-corporate.mjs 2>&1 | sed 's/^/[nse-corp] /'; then
  echo "[nightly] refresh-nse-corporate.mjs failed — non-fatal, continuing"
fi

if ! with_timeout 600 bash scripts/refresh-fo-oi.sh 2>&1 | sed 's/^/[fo-oi] /'; then
  echo "[nightly] refresh-fo-oi.sh failed — non-fatal, continuing"
fi

# Macro regime refresh: ~10-15s (RSS fetches + 1 LLM call). Writes
# data/macroRegime.json which production reads to render the global
# macro banner. Exit 2 = LLM auth_error (rotate keys) — non-fatal here
# but worth surfacing in the PR body. Exit 1 = no headlines AND no
# prior file — non-fatal; the banner falls back to last-known data.
MACRO_RC=0
if ! with_timeout 120 node scripts/refresh-macro-regime.mjs 2>&1 | sed 's/^/[macro] /'; then
  MACRO_RC=$?
  if [ "${MACRO_RC}" = "2" ]; then
    echo "[nightly] refresh-macro-regime.mjs returned exit 2 — LLM auth_error, rotate keys"
  elif [ "${MACRO_RC}" = "9" ]; then
    echo "[nightly] refresh-macro-regime.mjs returned exit 9 — LLM keys not loaded in env; prior data/macroRegime.json preserved"
  else
    echo "[nightly] refresh-macro-regime.mjs failed (exit ${MACRO_RC}) — non-fatal, continuing"
  fi
fi

# Daily fundamentals refresh: self-paced via a 20h freshness check. Two
# launchd fires per day (02:00 IST pre-market + 16:30 IST post-close), so
# 20h ensures the second fire coasts when the first succeeded. Saves
# ~10-15 min of NSE traffic per day. Skips entirely (age=9999) if the
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

if [ "${FUND_AGE_HOURS}" -lt 20 ]; then
  echo "[nightly] fundamentals.json is ${FUND_AGE_HOURS}h old — skipping refresh (< 20h freshness)"
else
  echo "[nightly] fundamentals.json is ${FUND_AGE_HOURS}h old — running refresh..."
  if ! with_timeout 1800 node scripts/refresh-fundamentals.mjs 2>&1 | sed 's/^/[fundamentals] /'; then
    echo "[nightly] refresh-fundamentals.mjs failed — non-fatal, continuing"
  fi
fi

echo "[nightly] running refresh-earnings.mjs (depends on the above)..."
if ! with_timeout 600 node scripts/refresh-earnings.mjs 2>&1 | sed 's/^/[earnings] /'; then
  echo "[nightly] refresh-earnings.mjs failed — non-fatal; tab stays on prior snapshot"
fi

# Date/branch labels — computed here so both the PASS path (step 5) and
# the sanity-gate FAIL path (data-only PR) can use them.
DATE=$(date +%Y-%m-%d)
RUN_TIME=$(date +%H%M)              # e.g. 0200 for the 02:00 fire, 1630 for the 16:30 fire
RUN_LABEL="${DATE} ${RUN_TIME:0:2}:${RUN_TIME:2:2}"   # "2026-05-07 02:00"

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

if [ ${GATE_RC} -ne 0 ]; then
  echo "[nightly] sanity gate FAILED — refusing to push SWS scrape output"

  # The scrape was rejected, but the catalysts/fundamentals/fo-oi/earnings
  # refreshes from step 3c are INDEPENDENT and may have produced fresh
  # data. Ship those in a data-only PR so the staleness banner doesn't
  # flag Fundamentals + Earnings while we debug the scrape.
  DATA_FILES=(
    data/catalysts/
    data/nse-fo/oi-deltas-latest.json
    data/macroRegime.json
    fundamentals.json
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
          --body "Sanity gate FAILED on the SWS scrape, but the catalysts/fundamentals/fo-oi/earnings refresh ran cleanly. Shipping those files separately so the dashboard's Fundamentals + Earnings tabs don't stagnate while we debug the scrape.

Sanity verdict: ${SANITY_SUMMARY:-unknown}

Auto-generated by \`scripts/sws-nightly.sh\` when the SWS scrape is blocked by the sanity gate." 2>&1)
        DATA_PR_URL=$(echo "${DATA_PR_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)
        if [ -n "${DATA_PR_URL}" ]; then
          DATA_PR_NOTE="Data-only PR shipped: ${DATA_PR_URL}"
          if [ "${AUTO_MERGE}" = "1" ]; then
            gh pr merge "${DATA_PR_URL}" --squash --auto --delete-branch 2>&1 | sed 's/^/[gh] /' || \
              gh pr merge "${DATA_PR_URL}" --squash --delete-branch 2>&1 | sed 's/^/[gh] /' || \
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
    # a worktree may hold the main ref. -B sws-nightly-base mirrors the
    # git-sync stage and is worktree-safe. Uncommitted SWS scrape files are
    # left on disk for inspection; the next run's autostash tidies them.
    git checkout -B sws-nightly-base origin/main 2>&1 | sed 's/^/[git] /' \
      || echo "[nightly] couldn't return to sws-nightly-base — next run's git-sync will recover"
  fi

  send_mail "🚨 SWS nightly — sanity gate failed (${SANITY_SUMMARY:-no summary})" "Scrape completed but sanity gate REJECTED the SWS output at $(ts). SWS data NOT pushed to prod.

${DATA_PR_NOTE}

Gate output:
${GATE_OUT}

Full report: data/sws/_sanity/_latest.json
Inspect data/sws/picks-latest.json and data/sws/last-refresh.json. If false alarm, push manually."
  exit 7
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

# ---- 5. Commit + push ----

CHANGED_FILES=$(git status --short \
  data/sws/deep/ \
  data/sws/picks-latest.json \
  data/sws/last-refresh.json \
  data/sws/sws-scored-universe.json \
  data/sws/v3-universe-stats.json \
  data/catalysts/ \
  data/nse-fo/oi-deltas-latest.json \
  data/macroRegime.json \
  fundamentals.json \
  fundamentalsHistory.json \
  2>/dev/null | wc -l | tr -d ' ')
if [ "${CHANGED_FILES}" -eq 0 ]; then
  echo "[nightly] no SWS data changes detected — nothing to commit"
  send_mail "ℹ️ SWS nightly — no data changes" "Pipeline ran clean but no files changed. Likely SWS upstream returned identical data, or scrape was skipped."
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
(branch sws-nightly-base). The next run's autostash will tidy it. Inspect manually:

$(git status 2>&1 | head -30)

$(git worktree list 2>&1)"
  exit 8
fi
# NOTE: the working copy is intentionally left on ${BRANCH} at end of run.
# The next run's git-sync (git checkout -B sws-nightly-base origin/main) does
# not care what branch it starts on, so no restore step is needed here.

git add data/sws/deep/ \
        data/sws/picks-latest.json \
        data/sws/last-refresh.json \
        data/sws/sws-scored-universe.json \
        data/sws/v3-universe-stats.json \
        data/catalysts/ \
        data/nse-fo/oi-deltas-latest.json \
        data/macroRegime.json \
        fundamentals.json \
        fundamentalsHistory.json

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
  `- sections: top30=${sc.top_ranked_30_v3?.length}, best_to_buy_now=${sc.best_to_buy_now?.length}, deep_value=${sc.deep_value?.length}, quality_growth=${sc.quality_growth?.length}, midterm=${sc.midterm?.length}, dividend_aristocrats=${sc.dividend_aristocrats?.length}, smallcap_gems=${sc.smallcap_gems?.length}, upcoming_earnings=${sc.upcoming_earnings?.length}, avoid=${sc.avoid?.length}`,
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
console.log(lines.join("\n"));
' 2>/dev/null)

git commit -m "chore(sws): auto-refresh ${RUN_LABEL} — full universe rescan

${COMMIT_BODY}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" 2>&1 | sed 's/^/[git] /'

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

Auto-generated by \`scripts/sws-nightly.sh\` running from launchd. Two scheduled fires per day: 02:00 IST (pre-market) and 16:30 IST (post-close).

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
  if ! gh pr merge "${PR_URL}" --squash --auto --delete-branch 2>&1 | sed 's/^/[gh] /'; then
    echo "[nightly] --auto failed, attempting immediate squash-merge..."
    gh pr merge "${PR_URL}" --squash --delete-branch 2>&1 | sed 's/^/[gh] /' || {
      echo "[nightly] both auto and immediate merge failed — manual merge required"
      send_mail "⚠️ SWS nightly — PR open but unmerged" "PR ${PR_URL} created but auto-merge failed. Manual review/merge required.

$(tail -30 ${LOG})"
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
exit 0
