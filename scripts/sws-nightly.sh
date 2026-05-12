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

echo "[nightly] syncing main..."
git fetch origin main 2>&1 | sed 's/^/[git] /'
CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${CUR_BRANCH}" != "main" ]; then
  echo "[nightly] not on main (was: ${CUR_BRANCH}) — switching"
  git checkout main 2>&1 | sed 's/^/[git] /'
fi
if ! git pull --ff-only origin main 2>&1 | sed 's/^/[git] /'; then
  echo "[nightly] git pull --ff-only failed — refusing to run (manual merge needed)"
  send_mail "🚨 SWS nightly aborted — git pull failed" "git pull --ff-only origin main failed at $(ts). Probably uncommitted local work. Investigate manually."
  exit 5
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

# ---- 4. Sanity gate ----
#
# Layered checks (L1 run integrity, L2 coverage, L3 data sanity, L6 picks
# coherence) live in scripts/sws-sanity-gate.mjs. Exit 0 = ship, exit 1 =
# block push. Full machine-readable report at data/sws/_sanity/_latest.json.

echo "[nightly] running sanity gate..."
GATE_OUT=$(node scripts/sws-sanity-gate.mjs 2>&1)
GATE_RC=$?
echo "${GATE_OUT}" | sed 's/^/[gate] /'

# Single-line summary suitable for commit body / PR title.
SANITY_SUMMARY=$(echo "${GATE_OUT}" | grep -E '^\[sanity-gate\] verdict=' | head -1 | sed 's/^\[sanity-gate\] //')

if [ ${GATE_RC} -ne 0 ]; then
  echo "[nightly] sanity gate FAILED — refusing to push"
  send_mail "🚨 SWS nightly — sanity gate failed (${SANITY_SUMMARY:-no summary})" "Scrape completed but sanity gate REJECTED the output at $(ts). Data NOT pushed to prod.

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

# ---- 4c. Earnings + catalysts refresh chain (non-fatal) ----
#
# The Earnings Watch tab depends on these files. Without the chain, the
# tab stays stuck on whatever snapshot last shipped (the original bug:
# tab built_at was 4 days stale by 2026-05-12 even though SWS itself
# refreshed nightly).
#
# Each step is wrapped in `timeout 600` and treated as warning-only —
# a transient NSE/Yahoo failure here MUST NOT block the SWS push that
# already succeeded. Mirrors the news-refresh pattern at line 147.
#
# Order matters:
#   1. refresh-catalysts.mjs      → data/catalysts/events-latest.json
#   2. refresh-nse-corporate.mjs  → nse-announcements-rolling + bulk-block
#   3. refresh-fo-oi.sh           → data/nse-fo/oi-deltas-latest.json
#   4. refresh-fundamentals.mjs   → fundamentals.json (NSE; weekly; for
#                                    stock detail modals — not the earnings
#                                    tab, which reads fundamentalsHistory.json)
#   5. refresh-earnings.mjs       → data/catalysts/earnings-watch-*.json
# (Phase E will add refresh-earnings-actuals.mjs as step 6 once it lands.)
#
# NOTE: fundamentalsHistory.json (Yahoo, used by the earnings tab's
# trajectory component) is currently refreshed manually via
# scripts/fetch-fundamentals-history.mjs. Phase A.2 of the SEBI-RA upgrade
# plan will extend that script to also capture forwardEps +
# numberOfAnalystOpinions, then add it to this chain on a weekly cadence.
echo "[nightly] running catalysts + earnings refresh chain..."

if ! timeout 600 node scripts/refresh-catalysts.mjs 2>&1 | sed 's/^/[catalysts] /'; then
  echo "[nightly] refresh-catalysts.mjs failed — non-fatal, continuing"
fi

if ! timeout 600 node scripts/refresh-nse-corporate.mjs 2>&1 | sed 's/^/[nse-corp] /'; then
  echo "[nightly] refresh-nse-corporate.mjs failed — non-fatal, continuing"
fi

if ! timeout 600 bash scripts/refresh-fo-oi.sh 2>&1 | sed 's/^/[fo-oi] /'; then
  echo "[nightly] refresh-fo-oi.sh failed — non-fatal, continuing"
fi

# Sunday only (date +%u returns 7 for Sunday). Yahoo rate-limits ~500-stock
# pulls; quarterly EPS doesn't change daily so a weekly refresh is enough.
if [ "$(date +%u)" = "7" ]; then
  echo "[nightly] Sunday — running fundamentals refresh (weekly cadence)..."
  if ! timeout 1800 node scripts/refresh-fundamentals.mjs 2>&1 | sed 's/^/[fundamentals] /'; then
    echo "[nightly] refresh-fundamentals.mjs failed — non-fatal, continuing"
  fi
fi

echo "[nightly] running refresh-earnings.mjs (depends on the above)..."
if ! timeout 600 node scripts/refresh-earnings.mjs 2>&1 | sed 's/^/[earnings] /'; then
  echo "[nightly] refresh-earnings.mjs failed — non-fatal; tab stays on prior snapshot"
fi

# ---- 5. Commit + push ----

CHANGED_FILES=$(git status --short \
  data/sws/deep/ \
  data/sws/picks-latest.json \
  data/sws/last-refresh.json \
  data/sws/sws-scored-universe.json \
  data/sws/v3-universe-stats.json \
  data/catalysts/ \
  data/nse-fo/oi-deltas-latest.json \
  fundamentalsHistory.json \
  2>/dev/null | wc -l | tr -d ' ')
if [ "${CHANGED_FILES}" -eq 0 ]; then
  echo "[nightly] no SWS data changes detected — nothing to commit"
  send_mail "ℹ️ SWS nightly — no data changes" "Pipeline ran clean but no files changed. Likely SWS upstream returned identical data, or scrape was skipped."
  exit 0
fi

DATE=$(date +%Y-%m-%d)
RUN_TIME=$(date +%H%M)              # e.g. 0200 for the 02:00 fire, 1630 for the 16:30 fire
RUN_LABEL="${DATE} ${RUN_TIME:0:2}:${RUN_TIME:2:2}"   # "2026-05-07 02:00"
BRANCH="chore/sws-auto-refresh-${DATE}-${RUN_TIME}"   # unique per fire even if same day

# Clean up any prior local branch with same name (e.g., from interrupted run)
git branch -D "${BRANCH}" >/dev/null 2>&1 || true
git checkout -b "${BRANCH}"

git add data/sws/deep/ \
        data/sws/picks-latest.json \
        data/sws/last-refresh.json \
        data/sws/sws-scored-universe.json \
        data/sws/v3-universe-stats.json \
        data/catalysts/ \
        data/nse-fo/oi-deltas-latest.json \
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
