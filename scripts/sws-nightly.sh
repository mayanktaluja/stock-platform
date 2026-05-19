#!/usr/bin/env bash
#
# Fully-autonomous SWS refresh. Designed to run from a launchd agent at
# 02:00 IST (pre-market) and 16:30 IST (post-close) every day. No Claude
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
#   8  push or PR creation failed

set -uo pipefail

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
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
}
trap slack_notify_on_exit EXIT

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
  trap - EXIT  # dry-run success — don't fire Slack failure trap
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
#   4. refresh-fundamentals.mjs   → fundamentals.json (NSE; 8h freshness gate
#                                    so BOTH daily fires refresh — keeps it
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

echo "[nightly] running catalysts + fundamentals + earnings refresh chain..."

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

# Fundamentals refresh: self-paced via an 8h freshness check. Two launchd
# fires per day (02:00 IST pre-market + 16:30 IST post-close, ~14.5h and
# ~9.5h apart); an 8h gate lets BOTH fires refresh, so the file never
# drifts past the 48h staleness banner even if a fire is missed. The
# earlier 20h gate let both fires coast — the file only refreshed once it
# had ALREADY drifted >20h, which is how it reached the user-visible "2d
# old" banner. Skips entirely (age=9999) if the file is missing or
# unparseable, which forces a fresh pull.
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
# fundamentalsHistory.json instead of one that's up to 22 hours stale by
# the time the 02:00 IST fire reads it. Before this move, the 02:00 fire
# ran earnings → fundamentalsHistory; the 04:00 standalone job that was
# meant to keep fundamentalsHistory fresh had been silently dead since
# 2026-05-13. Earnings is the only consumer of fundamentalsHistory, so
# this ordering is what makes the bundling sound.
#
# 18h freshness gate mirrors the fundamentals.json pattern (lines 251-275):
# two fires per day means the second fire coasts when the first succeeded.
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

echo "[nightly] running refresh-earnings.mjs (depends on the above)..."
if with_timeout 600 node scripts/refresh-earnings.mjs 2>&1 | sed 's/^/[earnings] /'; then
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

# Step 9b: Risk Lab refresh — generates data/risk-lab/picks-adjusted-latest.json
# by layering the experimental macro/quality overlay on top of the just-written
# picks-latest.json + macroRegime.json. Read-only on production files; only
# writes to data/risk-lab/. Non-fatal — the lab is opt-in via per-user toggle
# and a stale lab file is recoverable on the next 02:00 / 16:30 fire.
echo "[sws-nightly] refresh-risk-lab.mjs (timeout 60s)"
with_timeout 60 node scripts/refresh-risk-lab.mjs 2>&1 | sed 's/^/[risk-lab] /' || \
  echo "[sws-nightly] refresh-risk-lab.mjs FAILED — continuing (non-fatal; lab tab will show stale data)"

# Step 9b2: NSE PIT 7(2) — SEBI insider/promoter transaction disclosures.
# Local-only fetch (cookie-gated, rejects Vercel IPs per nse.js:76-83).
# Writes data/promoter-transactions/rolling-30d.json + a staleness alert
# file. Consumed by Earnings Edge (promoter-sell veto) and surfaced by
# the daily reconcile. Non-fatal — Earnings Edge gracefully degrades when
# the file is absent.
echo "[sws-nightly] refresh-promoter-transactions.mjs (timeout 120s)"
with_timeout 120 node scripts/refresh-promoter-transactions.mjs 2>&1 | sed 's/^/[promoter-pit] /' || \
  echo "[sws-nightly] refresh-promoter-transactions.mjs FAILED — continuing (non-fatal; staleness alert will fire if it persists)"

# Step 9c: Compounder Lab refresh — SAFE sleeve from the 2026-05-19 alpha-
# strategy plan. Reads data/sws/sws-scored-universe.json + deep JSONs, runs
# the Snowflake-quality filter (Past ≥ 5, Health ≥ 4, Dividend ≥ 4, market
# cap ≥ ₹500Cr, no debt/liquidity risk keywords), writes top-20 by upside
# pct to data/compounder/latest.json. Reconciles paper-trade ledger at
# data/paper-trades/compounder.json. Personal-use only on the read side
# (server.js 404s non-allowlisted users). Read-only on production files;
# only writes to data/compounder/ + data/paper-trades/. Non-fatal.
echo "[sws-nightly] refresh-compounder.mjs (timeout 120s)"
with_timeout 120 node scripts/refresh-compounder.mjs 2>&1 | sed 's/^/[compounder] /' || \
  echo "[sws-nightly] refresh-compounder.mjs FAILED — continuing (non-fatal; tab will show prior basket)"

# Step 9d: Earnings Edge refresh — AGGRESSIVE sleeve from the 2026-05-19
# alpha-strategy plan. Reads earnings-watch-latest.json:recent_results +
# earnings-history/*.json (resolved BEAT events), enriches with deep
# snapshots, runs the deterministic KEC-bug-list filter, opens paper-
# trade ledger entries for survivors and closes existing positions on
# hard-stop / trail-stop / T+30 hold expiry. No LLM dependency. Non-fatal.
echo "[sws-nightly] refresh-earnings-edge.mjs (timeout 120s)"
with_timeout 120 node scripts/refresh-earnings-edge.mjs 2>&1 | sed 's/^/[edge] /' || \
  echo "[sws-nightly] refresh-earnings-edge.mjs FAILED — continuing (non-fatal; tab will show prior ledger)"

# Step 9e: Paper-trade reconciliation — daily mark-to-market + gate state
# for both sleeves (compounder + earnings_edge). Writes to
# data/paper-trades-reports/<sleeve>-{date,latest}.json. Read by the
# Earnings Edge tab + earnings-health-summary to surface "X trades from
# clearing the validation gate" alerts. Non-fatal.
echo "[sws-nightly] paper-trade-reconcile.mjs (timeout 60s)"
with_timeout 60 node scripts/paper-trade-reconcile.mjs 2>&1 | sed 's/^/[paper-trade] /' || \
  echo "[sws-nightly] paper-trade-reconcile.mjs FAILED — continuing (non-fatal)"

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
    # a worktree may hold the main ref. -B sws-nightly-base mirrors the
    # git-sync stage and is worktree-safe. Uncommitted SWS scrape files are
    # left on disk for inspection; the next run's autostash tidies them.
    git checkout -B sws-nightly-base origin/main 2>&1 | sed 's/^/[git] /' \
      || echo "[nightly] couldn't return to sws-nightly-base — next run's git-sync will recover"
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

# data/macroRegime.json deliberately excluded — single-writer rule per
# the 2026-05-17 fix. The standalone com.starbhai.macro-only cron commits it.
CHANGED_FILES=$(git status --short \
  data/sws/deep/ \
  data/sws/picks-latest.json \
  data/sws/last-refresh.json \
  data/sws/sws-scored-universe.json \
  data/sws/v3-universe-stats.json \
  data/sws/nse-event-calendar.json \
  data/nse-index-constituents.json \
  data/catalysts/ \
  data/nse-fo/oi-deltas-latest.json \
  fundamentals.json \
  surveillance.json \
  governance.json \
  fundamentalsHistory.json \
  2>/dev/null | wc -l | tr -d ' ')
if [ "${CHANGED_FILES}" -eq 0 ]; then
  echo "[nightly] no SWS data changes detected — nothing to commit"
  send_mail "ℹ️ SWS nightly — no data changes" "Pipeline ran clean but no files changed. Likely SWS upstream returned identical data, or scrape was skipped."
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
(branch sws-nightly-base). The next run's autostash will tidy it. Inspect manually:

$(git status 2>&1 | head -30)

$(git worktree list 2>&1)"
  exit 8
fi
# NOTE: the working copy is intentionally left on ${BRANCH} at end of run.
# The next run's git-sync (git checkout -B sws-nightly-base origin/main) does
# not care what branch it starts on, so no restore step is needed here.

# data/macroRegime.json deliberately excluded — single-writer rule per
# the 2026-05-17 fix. The standalone com.starbhai.macro-only cron commits it.
git add data/sws/deep/ \
        data/sws/picks-latest.json \
        data/sws/last-refresh.json \
        data/sws/sws-scored-universe.json \
        data/sws/v3-universe-stats.json \
        data/sws/nse-event-calendar.json \
        data/nse-index-constituents.json \
        data/catalysts/ \
        data/nse-fo/oi-deltas-latest.json \
        fundamentals.json \
        surveillance.json \
        governance.json \
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
  `- sections: top30=${sc.top_ranked_30_v3?.length}, best_to_buy_now=${sc.best_to_buy_now?.length}, deep_value=${sc.deep_value?.length}, quality_growth=${sc.quality_growth?.length}, best_fundamentals=${sc.best_fundamentals?.length}, midterm=${sc.midterm?.length}, dividend_aristocrats=${sc.dividend_aristocrats?.length}, smallcap_gems=${sc.smallcap_gems?.length}, upcoming_earnings=${sc.upcoming_earnings?.length}, avoid=${sc.avoid?.length}`,
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
  # No --delete-branch: its local cleanup fails when a worktree holds main (cf. #218); the repo's delete_branch_on_merge does remote cleanup.
  if ! gh pr merge "${PR_URL}" --squash --auto 2>&1 | sed 's/^/[gh] /'; then
    echo "[nightly] --auto failed, attempting immediate squash-merge..."
    gh pr merge "${PR_URL}" --squash 2>&1 | sed 's/^/[gh] /' || {
      echo "[nightly] both auto and immediate merge failed — manual merge required"
      send_mail "⚠️ SWS nightly — PR open but unmerged" "PR ${PR_URL} created but auto-merge failed. Manual review/merge required.

$(tail -30 ${LOG})"
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
trap - EXIT
exit 0
