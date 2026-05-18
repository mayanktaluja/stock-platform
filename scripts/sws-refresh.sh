#!/usr/bin/env bash
#
# Single-shot orchestrator for the SWS pipeline. Drives one full pass:
#   pipeline-lock → 3 shards in parallel → score → narrate → PDF → summary.
#
# Each shard process is bounded (~30-60 stocks per session, then exits).
# This script kicks off ONE pass — fire it on a cron / Cowork schedule to
# keep chipping away at the universe over the day.
#
# Usage:
#   ./scripts/sws-refresh.sh                # default mode = full
#   ./scripts/sws-refresh.sh quick          # overview only, all stocks
#   ./scripts/sws-refresh.sh earnings       # overview only, near-earnings
#   ./scripts/sws-refresh.sh full           # all 8 tabs, all stocks
#
# Exit codes:
#   0  success (or another refresh already in progress — exit clean)
#   2  invalid mode
#   3  panic-stop flag set — refusing to run
#   4  panic detected during scrape
#   5  shard process spawn failed
#
# Logs to data/sws/refresh.log and data/sws/refresh-shard-{1,2,3}.log
# Summary at data/sws/last-refresh.json — read by the dashboard.

set -uo pipefail

# Resolve repo root regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

MODE="${1:-${SWS_REFRESH_MODE:-full}}"
case "${MODE}" in
  quick|earnings|full) ;;
  *)
    echo "ERROR: invalid mode '${MODE}'. Expected: quick|earnings|full" >&2
    exit 2
    ;;
esac

LOG="data/sws/refresh.log"
SUMMARY="data/sws/last-refresh.json"
mkdir -p data/sws

# Tee output so the user sees it interactively AND it lands in the log.
exec > >(tee -a "${LOG}") 2>&1

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

echo ""
echo "=== refresh started: $(ts) mode=${MODE} pid=$$ ==="

# ---------- 1. Pre-flight: panic check ----------

if ! node scripts/sws-deep-scrape.mjs check-panic >/dev/null 2>&1; then
  echo "[refresh] panic-stop flag is set → refusing to run"
  echo "[refresh] inspect: cat data/sws/panic-stop.flag"
  echo "[refresh] clear:   rm data/sws/panic-stop.flag"
  exit 3
fi

# ---------- 2. Pipeline lock ----------

LOCK_RESULT="$(node scripts/sws-deep-scrape.mjs claim-pipeline-lock 2>&1 || true)"
echo "[refresh] pipeline lock: ${LOCK_RESULT}"
if echo "${LOCK_RESULT}" | grep -q '"acquired":false'; then
  echo "[refresh] another refresh already in progress → exiting cleanly (cron retry will pick up)"
  exit 0
fi

# Always release the lock on exit, even on signal/error.
release_lock() {
  node scripts/sws-deep-scrape.mjs release-pipeline-lock >/dev/null 2>&1 || true
}
trap release_lock EXIT INT TERM

# ---------- 3. Detect already-running shards ----------
#
# If a shard is mid-session (someone else fired the scraper, or a previous
# cron tick is still running), spawning a new one would fight over the same
# profile dir. Skip the scrape phase entirely and refresh scoring+PDF only.
# Cron will re-fire later and pick up the scrape when shards have exited.

START_EPOCH="$(date +%s)"
# Paired with finished_at in the summary heredoc below. Sanity gate's
# picks_matches_last_refresh check uses [started_at, finished_at] as the
# run window for verifying picks-latest.json belongs to this run — same
# pattern as sws-refresh-api.sh. Kept in sync so both wrappers produce
# consistent summaries.
RUN_STARTED_ISO="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
# Detect live shards by scanning processes — more reliable than lock files,
# which a previous failed spawn could have destroyed. Use `ps` because macOS
# BSD pgrep doesn't include command-line args in its output.
LIVE_SHARDS="$(ps -A -o command= | \
  grep -E 'node[^|]*sws-scrape-playwright\.mjs[ ]+[123]' | \
  grep -v 'grep' | \
  sed -E 's/.*sws-scrape-playwright\.mjs[ ]+([123]).*/\1/' | \
  sort -u | paste -sd, -)"

PIDS=()
FAIL=0
ELAPSED=0
SCRAPE_SKIPPED=false

if [ -n "${LIVE_SHARDS}" ]; then
  echo "[refresh] shards [${LIVE_SHARDS}] already running → skipping scrape, refreshing scoring/PDF only"
  SCRAPE_SKIPPED=true
else
  echo "[refresh] spawning 3 shards in parallel (mode=${MODE})"
  for SHARD in 1 2 3; do
    : > "data/sws/refresh-shard-${SHARD}.log"
    node scripts/sws-scrape-playwright.mjs "${SHARD}" --mode "${MODE}" \
      >> "data/sws/refresh-shard-${SHARD}.log" 2>&1 &
    PIDS+=("$!")
    echo "[refresh] shard ${SHARD} → PID $!"
    sleep 20  # gentle stagger — avoids burst signature
  done

  # ---------- 4. Wait for all shards ----------
  for P in "${PIDS[@]}"; do
    if ! wait "${P}"; then
      FAIL=$((FAIL + 1))
      echo "[refresh] shard PID ${P} exited non-zero"
    fi
  done
  ELAPSED=$(( $(date +%s) - START_EPOCH ))
  echo "[refresh] shards done in ${ELAPSED}s (${FAIL} failed)"
fi

# ---------- 5. Re-check panic mid-run ----------

if ! node scripts/sws-deep-scrape.mjs check-panic >/dev/null 2>&1; then
  echo "[refresh] panic detected during scrape → skipping score/narrate/PDF"
  exit 4
fi

# ---------- 6. Layer 2: score ----------

echo "[refresh] running scoring..."
SCORING_OUT="$(node scripts/sws-scoring.mjs 2>&1 || true)"
echo "${SCORING_OUT}" | tail -12 | sed 's/^/[scoring] /'

# ---------- 7. Layer 3a: narrate (graceful if no API key) ----------

HAVE_KEY=0
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then HAVE_KEY=1; fi
if [ ${HAVE_KEY} -eq 0 ] && [ -f .env ] && grep -q '^ANTHROPIC_API_KEY=' .env; then
  HAVE_KEY=1
fi

if [ ${HAVE_KEY} -eq 1 ]; then
  echo "[refresh] running narrate (Sonnet 4.6, top ~50 picks)..."
  if ! node scripts/sws-narrate-picks.mjs 2>&1 | tail -8 | sed 's/^/[narrate] /'; then
    echo "[narrate] non-zero exit — continuing (cards will use deterministic one-liners)"
  fi
else
  echo "[refresh] no ANTHROPIC_API_KEY → skipping narrate (cards use deterministic one-liners)"
fi

# ---------- 8. Layer 3b: PDF ----------

echo "[refresh] generating PDF..."
PDF_OUT="$(python3 scripts/generate-sws-picks-pdf.py 2>&1 || true)"
echo "${PDF_OUT}" | tail -3 | sed 's/^/[pdf] /'

# ---------- 9. Write summary for dashboard ----------

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
  const fp = "data/sws/progress-" + sid + ".json";
  if (existsSync(fp)) {
    const p = JSON.parse(readFileSync(fp, "utf-8"));
    progress[sid] = {
      done_count: p.done_count,
      next_local_index: p.next_local_index,
      slice_size: p._slice_size || null,
      complete: p.complete,
      today_count: p.today_count,
    };
  }
}
const summary = {
  started_at: "${RUN_STARTED_ISO}",
  finished_at: new Date().toISOString(),
  mode: "${MODE}",
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
console.log("[refresh] summary written: scored=" + scoredCount + " shards=" + JSON.stringify(progress));
EOF

echo "=== refresh complete: $(ts) elapsed=${ELAPSED}s ==="
exit 0
