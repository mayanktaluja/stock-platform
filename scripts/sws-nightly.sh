#!/usr/bin/env bash
#
# Fully-autonomous nightly SWS refresh. Designed to run from a launchd agent
# at 02:00 IST daily. No Claude Code dependency.
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
#   SWS_NIGHTLY_SKIP_BATTERY=1 # don't bail when on battery
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

REPO_DIR="/Users/mayanktaluja/Desktop/claude/stock-platform"
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

# Battery check: pmset wake doesn't guarantee AC is connected at run time
if [ "${SWS_NIGHTLY_SKIP_BATTERY:-0}" != "1" ]; then
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

echo "[nightly] running scripts/sws-refresh-api.sh..."
if ! bash scripts/sws-refresh-api.sh; then
  echo "[nightly] sws-refresh-api.sh failed (exit $?)"
  send_mail "🚨 SWS nightly — scrape pipeline failed" "scripts/sws-refresh-api.sh exited non-zero at $(ts).

Last 50 lines:
$(tail -50 data/sws/refresh-api.log 2>/dev/null)"
  exit 6
fi

# ---- 4. Sanity gate ----

echo "[nightly] running sanity gate..."
GATE_OUT=$(node --input-type=module -e '
import {readFileSync} from "fs";
const lr = JSON.parse(readFileSync("data/sws/last-refresh.json","utf-8"));
const picks = JSON.parse(readFileSync("data/sws/picks-latest.json","utf-8"));
const sc = picks.sections || {};
const checks = {
  scored_count_ok:       (lr.scored_count ?? picks.scored_count ?? 0) >= 5000,
  top_ranked_30_ok:      (sc.top_ranked_30_v3?.length ?? 0) === 30,
  best_to_buy_now_ok:    (sc.best_to_buy_now?.length ?? 0) >= 20,
  upcoming_earnings_ok:  (sc.upcoming_earnings?.length ?? 0) >= 50,
  no_failed_shards:      (lr.shards_failed ?? 0) === 0,
  scanned_recent:        (Date.now() - new Date(picks.scanned_at).getTime()) < 1000*60*60*6,
};
const pass = Object.values(checks).every(v => v);
console.log(JSON.stringify({pass, checks, summary: {scored: lr.scored_count, top30: sc.top_ranked_30_v3?.length, btbn: sc.best_to_buy_now?.length, earnings: sc.upcoming_earnings?.length}}, null, 2));
process.exit(pass ? 0 : 1);
' 2>&1)
GATE_RC=$?
echo "${GATE_OUT}" | sed 's/^/[gate] /'

if [ ${GATE_RC} -ne 0 ]; then
  echo "[nightly] sanity gate FAILED — refusing to push"
  send_mail "🚨 SWS nightly — sanity gate failed" "Scrape completed but sanity gate REJECTED the output at $(ts). Data NOT pushed to prod.

Gate output:
${GATE_OUT}

Inspect data/sws/picks-latest.json and data/sws/last-refresh.json. If false alarm, push manually."
  exit 7
fi

# ---- 5. Commit + push ----

CHANGED_FILES=$(git status --short data/sws/deep/ data/sws/picks-latest.json data/sws/last-refresh.json data/sws/sws-scored-universe.json data/sws/v3-universe-stats.json 2>/dev/null | wc -l | tr -d ' ')
if [ "${CHANGED_FILES}" -eq 0 ]; then
  echo "[nightly] no SWS data changes detected — nothing to commit"
  send_mail "ℹ️ SWS nightly — no data changes" "Pipeline ran clean but no files changed. Likely SWS upstream returned identical data, or scrape was skipped."
  exit 0
fi

DATE=$(date +%Y-%m-%d)
BRANCH="chore/sws-auto-refresh-${DATE}"

# Clean up any prior local branch with same name (e.g., from interrupted run)
git branch -D "${BRANCH}" >/dev/null 2>&1 || true
git checkout -b "${BRANCH}"

git add data/sws/deep/ \
        data/sws/picks-latest.json \
        data/sws/last-refresh.json \
        data/sws/sws-scored-universe.json \
        data/sws/v3-universe-stats.json

# Build commit body from sanity-gate summary
COMMIT_BODY=$(node --input-type=module -e '
import {readFileSync} from "fs";
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
console.log(lines.join("\n"));
' 2>/dev/null)

git commit -m "chore(sws): auto-refresh ${DATE} — full universe rescan

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

PR_BODY="Automated nightly SWS refresh.

${COMMIT_BODY}

Auto-generated by \`scripts/sws-nightly.sh\` running from launchd at 02:00 IST.

🤖 No human in the loop — sanity gate enforces minimum data quality before push."

PR_URL=$(gh pr create \
  --title "chore(sws): auto-refresh ${DATE} — full universe rescan" \
  --body "${PR_BODY}" 2>&1) || {
  echo "[nightly] gh pr create failed: ${PR_URL}"
  send_mail "🚨 SWS nightly — gh pr create failed" "Branch was pushed (${BRANCH}) but PR creation failed at $(ts).

Output:
${PR_URL}

You can manually open the PR at https://github.com/mayanktaluja/stock-platform/compare/${BRANCH}"
  exit 8
}

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
send_mail "✅ SWS nightly OK — ${DATE} ($((ELAPSED/60))m)" "Nightly SWS refresh completed at $(ts) in $((ELAPSED/60))m ${e:-$((ELAPSED%60))}s.

PR: ${PR_URL}
Branch: ${BRANCH} (deleted on merge)

${COMMIT_BODY}

Vercel will redeploy main once CI green. Production data should be fresh before market open (09:15 IST)."

echo "[nightly] DONE in ${ELAPSED}s ($(ts))"
exit 0
