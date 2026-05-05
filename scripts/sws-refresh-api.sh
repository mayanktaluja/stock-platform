#!/usr/bin/env bash
#
# API-based SWS refresh pipeline. Uses the GraphQL+REST API client (much
# faster — ~1 hour vs 3+ days for the DOM-scraper) to scan the full universe,
# then runs the same scoring + PDF pipeline.
#
# Pipeline:
#   1. Acquire pipeline lock
#   2. Detect already-running shards
#   3. If none running: spawn 3 parallel API shards
#   4. Wait for shards
#   5. Parse raw API output → scoring-compatible deep/<TICKER>.json
#   6. Run scoring (sws-scoring.mjs)
#   7. Backfill last-quarter beat/miss on upcoming-earnings cards (Yahoo Finance)
#   8. Optionally narrate (if ANTHROPIC_API_KEY set)
#   9. Generate PDF
#  10. Write last-refresh.json
#
# Usage:
#   ./scripts/sws-refresh-api.sh                       # full universe
#
# Exit codes match sws-refresh.sh (the legacy DOM scraper):
#   0  success (or another refresh already in progress — exit clean)
#   3  panic-stop flag set — refusing to run
#   4  panic detected during scrape
#   5  shard process spawn failed
#
# Logs: data/sws/refresh-api.log + data/sws/refresh-api-shard-{1,2,3}.log
# Summary: data/sws/last-refresh.json (read by dashboard)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

LOG="data/sws/refresh-api.log"
SUMMARY="data/sws/last-refresh.json"
mkdir -p data/sws

exec > >(tee -a "${LOG}") 2>&1

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
START_EPOCH="$(date +%s)"

# Mail summary helper. Sends via Resend (scripts/sws-mail-summary.mjs).
# Gated by SWS_MAIL_ENABLED (set =0 to silence). Silent no-op if helper
# script is missing — keeps the wrapper resilient when run from a fresh
# checkout that hasn't seen the mail integration.
SWS_MAIL_FN() {
  local subject="$1"; local body="$2"
  [ "${SWS_MAIL_ENABLED:-1}" = "0" ] && return 0
  [ ! -f scripts/sws-mail-summary.mjs ] && { echo "[mail] helper missing — skipping"; return 0; }
  printf "%s" "${body}" | node scripts/sws-mail-summary.mjs "${subject}" - 2>&1 | sed 's/^/[mail] /'
}

echo "=== refresh-api started: $(ts) pid=$$ ==="

# ---------- 1. Pre-flight: panic flag ----------

if ! node scripts/sws-deep-scrape.mjs check-panic >/dev/null 2>&1; then
  echo "[refresh-api] PANIC flag set — refusing to run"
  SWS_MAIL_FN "🚨 SWS refresh aborted — PANIC flag set" "The daily SWS refresh wrapper refused to start because data/sws/panic-stop.flag is set.

$(cat data/sws/panic-stop.flag 2>/dev/null | head -30)

Manual review required. Inspect Simply Wall Street in your browser to confirm there's no block / suspension, then delete data/sws/panic-stop.flag to allow the next run to proceed."
  exit 3
fi

# ---------- 2. Pipeline lock ----------

LOCK_RESULT="$(node scripts/sws-deep-scrape.mjs claim-pipeline-lock 2>&1 || true)"
if echo "${LOCK_RESULT}" | grep -q '"acquired":true'; then
  echo "[refresh-api] pipeline lock: ${LOCK_RESULT}"
else
  echo "[refresh-api] pipeline lock NOT acquired — another refresh in progress, exiting"
  echo "${LOCK_RESULT}"
  exit 0
fi

trap 'node scripts/sws-deep-scrape.mjs release-pipeline-lock >/dev/null 2>&1 || true' EXIT

# ---------- 3. Detect already-running API shards ----------

LIVE_SHARDS="$(ps -A -o command= | \
  grep -E 'node[^|]*sws-api-scrape\.mjs[ ]+[123]' | \
  grep -v 'grep' | \
  sed -E 's/.*sws-api-scrape\.mjs[ ]+([123]).*/\1/' | \
  sort -u | paste -sd, -)"

PIDS=()
FAIL=0
ELAPSED=0
SCRAPE_SKIPPED=false

if [ -n "${LIVE_SHARDS}" ]; then
  echo "[refresh-api] shards [${LIVE_SHARDS}] already running → skipping scrape, refreshing scoring/PDF only"
  SCRAPE_SKIPPED=true
else
  echo "[refresh-api] spawning 3 API shards in parallel"

  # Reset next_local_index so each fresh invocation does a full-universe pass.
  # Without this, once shards reach end-of-slice the loop exits scraped:0 and
  # the wrapper still runs score+PDF on stale data (silent no-op cron). Only
  # the cursor is rewound — done_count / today_count / today_date / started_at
  # are preserved. Safe — we hold the pipeline lock, and LIVE_SHARDS is empty.
  node --input-type=module - <<'EOF'
import {readFileSync, writeFileSync, existsSync} from "fs";
for (const sid of [1, 2, 3]) {
  const fp = `data/sws/progress-api-${sid}.json`;
  if (!existsSync(fp)) continue;
  const p = JSON.parse(readFileSync(fp, "utf-8"));
  const before = p.next_local_index;
  p.next_local_index = 0;
  writeFileSync(fp, JSON.stringify(p, null, 2) + "\n");
  console.log(`[refresh-api] reset shard ${sid}: next_local_index ${before} → 0`);
}
EOF

  for SHARD in 1 2 3; do
    : > "data/sws/refresh-api-shard-${SHARD}.log"
    node scripts/sws-api-scrape.mjs "${SHARD}" \
      >> "data/sws/refresh-api-shard-${SHARD}.log" 2>&1 &
    PIDS+=("$!")
    echo "[refresh-api] shard ${SHARD} → PID $!"
    sleep 15  # gentle stagger
  done

  # ---------- 4. Wait ----------
  for P in "${PIDS[@]}"; do
    if ! wait "${P}"; then
      FAIL=$((FAIL + 1))
      echo "[refresh-api] shard PID ${P} exited non-zero"
    fi
  done
  ELAPSED=$(( $(date +%s) - START_EPOCH ))
  echo "[refresh-api] shards done in ${ELAPSED}s (${FAIL} failed)"
fi

# ---------- 5. Re-check panic mid-run ----------

if ! node scripts/sws-deep-scrape.mjs check-panic >/dev/null 2>&1; then
  echo "[refresh-api] panic detected during scrape → skipping parse/score/narrate/PDF"
  SWS_MAIL_FN "🚨 SWS refresh — panic mid-scrape" "Refresh started cleanly but a panic flag was raised during the scrape phase. Parse/score/narrate/PDF were skipped to avoid writing partial data.

elapsed before panic: ${ELAPSED}s
shards failed: ${FAIL}

$(cat data/sws/panic-stop.flag 2>/dev/null | head -30)

Inspect data/sws/refresh-api-shard-{1,2,3}.log for the trigger event, then delete data/sws/panic-stop.flag once you've reviewed."
  exit 4
fi

# ---------- 6. Parse raw API → scoring-compatible JSON ----------

echo "[refresh-api] parsing raw API payloads..."
PARSE_OUT="$(node scripts/sws-api-parser.mjs --dest deep 2>&1 || true)"
echo "${PARSE_OUT}" | tail -5 | sed 's/^/[parser] /'

# ---------- 7. Score ----------

echo "[refresh-api] running scoring..."
SCORING_OUT="$(node scripts/sws-scoring.mjs 2>&1 || true)"
echo "${SCORING_OUT}" | tail -12 | sed 's/^/[scoring] /'

# ---------- 7. Backfill last-quarter beat/miss ----------

echo "[refresh-api] backfilling earnings beat/miss..."
BEAT_OUT="$(node scripts/sws-fetch-earnings-beat.mjs 2>&1 || true)"
echo "${BEAT_OUT}" | tail -3 | sed 's/^/[earnings-beat] /'

# ---------- 8. Narrate (if API key) ----------

HAVE_KEY=0
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then HAVE_KEY=1; fi
if [ ${HAVE_KEY} -eq 0 ] && [ -f .env ] && grep -q '^ANTHROPIC_API_KEY=' .env; then
  HAVE_KEY=1
fi

if [ ${HAVE_KEY} -eq 1 ]; then
  echo "[refresh-api] running narrate..."
  if ! node scripts/sws-narrate-picks.mjs 2>&1 | tail -8 | sed 's/^/[narrate] /'; then
    echo "[narrate] non-zero exit — continuing"
  fi
else
  echo "[refresh-api] no ANTHROPIC_API_KEY → skipping narrate (deterministic one-liners)"
fi

# ---------- 9. PDF ----------

echo "[refresh-api] generating PDF..."
PDF_OUT="$(python3 scripts/generate-sws-picks-pdf.py 2>&1 || true)"
echo "${PDF_OUT}" | tail -3 | sed 's/^/[pdf] /'

# ---------- 10. Summary ----------

node --input-type=module - <<EOF
import {writeFileSync, readFileSync, existsSync} from "fs";
let scoredCount = 0, sectionsCount = {};
if (existsSync("data/sws/picks-latest.json")) {
  const p = JSON.parse(readFileSync("data/sws/picks-latest.json", "utf-8"));
  scoredCount = p.scored_count || 0;
  for (const [k, v] of Object.entries(p.sections || {})) {
    if (Array.isArray(v) && v.length) sectionsCount[k] = v.length;
  }
}
let progress = {};
for (const sid of [1, 2, 3]) {
  const fp = "data/sws/progress-api-" + sid + ".json";
  if (existsSync(fp)) {
    const p = JSON.parse(readFileSync(fp, "utf-8"));
    progress[sid] = {
      done_count: p.done_count,
      next_local_index: p.next_local_index,
      today_count: p.today_count,
      last_ticker: p.last_ticker,
    };
  }
}
const summary = {
  finished_at: new Date().toISOString(),
  pipeline: "api",
  duration_seconds: ${ELAPSED},
  shards_failed: ${FAIL},
  scrape_skipped: ${SCRAPE_SKIPPED},
  scored_count: scoredCount,
  sections_count: sectionsCount,
  per_shard_progress: progress,
  pipeline_status: ${SCRAPE_SKIPPED}
    ? "skipped_scrape_already_running"
    : (${FAIL} > 0 ? "partial" : "success"),
};
writeFileSync("${SUMMARY}", JSON.stringify(summary, null, 2));
console.log("[refresh-api] summary written: scored=" + scoredCount + " shards=" + JSON.stringify(progress));
EOF

echo "=== refresh-api complete: $(ts) elapsed=${ELAPSED}s ==="

# Release the pipeline lock now — data work is done and the auto-PR step
# below invokes `git push`, whose pre-push hook runs `npm test`, which
# includes a test that calls claimPipelineLock(). If we still hold the
# lock when that test runs (and it's < 30min old, i.e. STALE_TOKEN_MS in
# sws-deep-scrape.mjs), the test fails with "first claim acquires" and
# blocks the push. The trap on EXIT still serves as a safety net.
node scripts/sws-deep-scrape.mjs release-pipeline-lock >/dev/null 2>&1 || true

# ---------- 10. Auto-propagate to prod (data PR) ----------
# Without this, refreshed files only live on local disk; prod (stateless
# Vercel) keeps serving the previous deploy's snapshot. Discovered
# 2026-04-30: SWS Picks tab showed 1d-old data after a successful refresh
# because nobody had committed/pushed the regenerated JSON.
#
# Gated behaviour:
#   SWS_AUTO_PR=0     → skip everything (manual mode, default in early days)
#   SWS_AUTO_PR=1     → auto-create branch + commit + push + open PR (default ON)
#   SWS_AUTO_MERGE=1  → also enable GitHub auto-merge on the PR (squash)
#
# Skipped when: pipeline failed, scrape was skipped (already running), gh
# CLI is missing, or there's nothing staged after `git add`.

if [ "${SWS_AUTO_PR:-1}" != "0" ] \
   && command -v gh >/dev/null 2>&1 \
   && [ "${FAIL}" -eq 0 ] \
   && [ "${SCRAPE_SKIPPED}" != "true" ]; then
  AUTO_BRANCH="data/sws-auto-$(date -u +%Y-%m-%d-%H%M)"
  AUTO_DATE="$(date -u +%Y-%m-%d)"
  ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  echo "[refresh-api] auto-PR: branching ${AUTO_BRANCH} from ${ORIGINAL_BRANCH}"

  if git checkout -b "${AUTO_BRANCH}" >/dev/null 2>&1; then
    git add data/sws/picks-latest.json data/sws/last-refresh.json data/sws/v3-universe-stats.json data/sws/sws-scored-universe.json 2>/dev/null
    git add data/sws/deep/ 2>/dev/null
    [ -d reports/sws-picks ] && git add reports/sws-picks/*.pdf 2>/dev/null

    if git diff --cached --quiet; then
      echo "[refresh-api] auto-PR: no data changes to commit — skipping"
      git checkout "${ORIGINAL_BRANCH}" >/dev/null 2>&1
      git branch -D "${AUTO_BRANCH}" >/dev/null 2>&1
    else
      git commit -m "chore(sws): auto-refresh ${AUTO_DATE} — full universe rescan

Auto-generated by scripts/sws-refresh-api.sh.
duration: ${ELAPSED}s, shards_failed: ${FAIL}, status: $([ ${FAIL} -gt 0 ] && echo partial || echo success).

Without this commit, prod's stateless Vercel functions would continue
serving the previous deploy's snapshot of picks-latest.json + deep/*." >/dev/null 2>&1

      if git push -u origin "${AUTO_BRANCH}" 2>&1 | tail -3 | sed 's/^/[refresh-api] /'; then
        PR_URL="$(gh pr create --base main \
          --title "chore(sws): auto-refresh ${AUTO_DATE}" \
          --body "Auto-generated by \`scripts/sws-refresh-api.sh\` — ships freshly-scraped SWS data to prod.

* duration: ${ELAPSED}s
* shards_failed: ${FAIL}
* see \`data/sws/last-refresh.json\` for full pipeline summary

Once merged, prod (\`stock-platform-gamma.vercel.app\`) will redeploy with the new picks." 2>&1 | tail -1)"
        echo "[refresh-api] auto-PR opened: ${PR_URL}"

        if [ "${SWS_AUTO_MERGE:-0}" = "1" ]; then
          gh pr merge "${PR_URL}" --squash --auto --delete-branch 2>&1 | tail -1 | sed 's/^/[refresh-api] /' \
            || echo "[refresh-api] auto-merge unavailable — PR awaits manual merge (enable in repo settings → Allow auto-merge)"
        else
          echo "[refresh-api] auto-merge disabled (set SWS_AUTO_MERGE=1 to enable). PR awaits manual merge."
        fi
      fi

      git checkout "${ORIGINAL_BRANCH}" >/dev/null 2>&1
    fi
  else
    echo "[refresh-api] auto-PR: branch checkout failed (working tree dirty?) — skipping"
  fi
fi

# ---------- 11. Send completion email ----------
# Composed from last-refresh.json so the body matches what the dashboard sees.
# Non-fatal — never blocks the success exit.

MAIL_SUMMARY="$(PR_URL_ENV="${PR_URL:-}" node --input-type=module - <<'NODE_EOF' 2>/dev/null || echo "(summary unavailable)"
import {readFileSync, existsSync} from "fs";
const path = "data/sws/last-refresh.json";
if (!existsSync(path)) { console.log("(no last-refresh.json yet)"); process.exit(0); }
const j = JSON.parse(readFileSync(path, "utf-8"));
const dur = j.duration_seconds || 0;
const h = Math.floor(dur / 3600), m = Math.floor((dur % 3600) / 60);
const pr = process.env.PR_URL_ENV || "";
const lines = [
  `Pipeline status: ${j.pipeline_status}`,
  `Duration: ${h}h ${m}m (${dur}s)`,
  `Scored: ${j.scored_count} stocks · Shards failed: ${j.shards_failed}`,
  `Finished: ${j.finished_at}`,
  "",
  "Sections:",
  ...Object.entries(j.sections_count || {}).map(([k, v]) => `  ${k}: ${v}`),
  "",
  "Per-shard progress:",
  ...Object.entries(j.per_shard_progress || {}).map(([sid, p]) =>
    `  shard ${sid}: ${p.done_count} done · today ${p.today_count} · last ${p.last_ticker}`),
  "",
  "Prod: https://stock-platform-gamma.vercel.app/",
];
if (pr.length) lines.push("", `Auto-PR opened: ${pr}`);
else lines.push("", "Auto-PR not opened (skipped or disabled — manual sync needed for prod to see fresh data).");
console.log(lines.join("\n"));
NODE_EOF
)"

MAIL_STATUS_ICON="✅"
[ "${FAIL}" -gt 0 ] && MAIL_STATUS_ICON="⚠️"
MAIL_DATE="$(date -u +%Y-%m-%d)"
MAIL_SCORED="$(node -p "JSON.parse(require('fs').readFileSync('data/sws/last-refresh.json','utf-8')).scored_count" 2>/dev/null || echo "?")"

SWS_MAIL_FN "${MAIL_STATUS_ICON} SWS refresh ${MAIL_DATE} — ${MAIL_SCORED} stocks" "${MAIL_SUMMARY}"

exit 0
