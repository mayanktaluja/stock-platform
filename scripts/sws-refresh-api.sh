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
#   5. Refresh auxiliary caches (NSE events, Groww/Refinitiv P/E TTL cache)
#   6. Parse raw API output → scoring-compatible deep/<TICKER>.json
#   7. Run seed scoring (sws-scoring.mjs)
#   8. Refresh sector themes/outlook, then run final scoring
#   9. Backfill last-quarter beat/miss on upcoming-earnings cards (Yahoo Finance)
#  10. Optionally narrate (if ANTHROPIC_API_KEY set)
#  11. Generate PDF
#  12. Write last-refresh.json
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

# Cross-pipeline co-run guard (shared SWS account/cf_clearance): refuse if a US
# or KR/TW scrape is live. India's own already-running shards are handled below
# (LIVE_SHARDS). Closes the bidirectional gap so no two markets ever scrape at
# once on the one SWS account.
# shellcheck source=scripts/sws-corun-guard.sh
. "${SCRIPT_DIR}/sws-corun-guard.sh"
if ! corun_guard in; then exit 5; fi

exec > >(tee -a "${LOG}") 2>&1

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
run_with_timeout() {
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}" "$@"
  else
    "$@"
  fi
}
START_EPOCH="$(date +%s)"
# RUN_STARTED_ISO is the canonical "when did this pipeline start" timestamp,
# stamped into last-refresh.json's `started_at` field at summary-write time
# (step 10). The sanity gate's `picks_matches_last_refresh` check uses it to
# verify picks-latest.json's scanned_at falls within this run's window —
# catches the 2026-05-18 22:37 IST failure mode where picks-latest.json was
# silently reverted to a previous run's value between scoring and the gate.
RUN_STARTED_ISO="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
RUN_STARTED_IST_HHMM="$(TZ=Asia/Kolkata date +%H%M)"

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
  #
  # SWS_RESUME=1 skips this reset so a prior partial scrape (e.g. interrupted
  # by `launchctl unload`) can continue from its saved next_local_index
  # instead of restarting at 0. Use only when the local progress-api-*.json
  # files reflect the actual state of data/sws/deep-api/.
  if [ "${SWS_RESUME:-0}" = "1" ]; then
    echo "[refresh-api] SWS_RESUME=1 — skipping reset, shards will continue from saved next_local_index"
  else
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
  fi

  # Bounded auto-retry: when a shard exits non-zero (crash, Neon disconnect,
  # any unhandled rejection caught by installFatalHandlers in
  # sws-api-scrape.mjs), restart it up to SHARD_MAX_RETRIES times. Each retry
  # passes SWS_RESUME=1 so the scraper picks up at the saved
  # next_local_index (per-stock progress is persisted by saveProgress() after
  # every stock — no work is lost). Only counts as FAIL once retries are
  # exhausted, preventing a single transient crash from blocking the
  # sanity gate (the failure mode that crashed shard 2 on 2026-05-17).
  SHARD_MAX_RETRIES=${SHARD_MAX_RETRIES:-2}
  SHARD_RETRY_SLEEP_SEC=${SHARD_RETRY_SLEEP_SEC:-30}

  run_shard_with_retry() {
    local SHARD="$1"
    local LOG="data/sws/refresh-api-shard-${SHARD}.log"
    : > "${LOG}"
    local attempt=0
    local rc=0
    while : ; do
      local resume=0
      [ "${attempt}" -gt 0 ] && resume=1
      echo "[refresh-api] shard ${SHARD} attempt $((attempt+1)) (SWS_RESUME=${resume})" >> "${LOG}"
      # Capture rc BEFORE any `if` test — bash resets $? to 0 after a failed
      # `if cmd; then ...; fi` with no else branch, which would silently
      # mask the real exit code in this helper.
      SWS_RESUME="${resume}" node scripts/sws-api-scrape.mjs "${SHARD}" >> "${LOG}" 2>&1
      rc=$?
      if [ "${rc}" -eq 0 ]; then
        return 0
      fi
      attempt=$((attempt + 1))
      if [ "${attempt}" -gt "${SHARD_MAX_RETRIES}" ]; then
        echo "[refresh-api] shard ${SHARD} failed after ${SHARD_MAX_RETRIES} retries (last rc=${rc})" >> "${LOG}"
        return "${rc}"
      fi
      echo "[refresh-api] shard ${SHARD} exited rc=${rc} — retrying (${attempt}/${SHARD_MAX_RETRIES}) with SWS_RESUME=1" >> "${LOG}"
      sleep "${SHARD_RETRY_SLEEP_SEC}"
    done
  }

  for SHARD in 1 2 3; do
    run_shard_with_retry "${SHARD}" &
    PIDS+=("$!")
    echo "[refresh-api] shard ${SHARD} → PID $! (up to ${SHARD_MAX_RETRIES} retries)"
    sleep 15  # gentle stagger
  done

  # ---------- 4. Wait ----------
  for P in "${PIDS[@]}"; do
    if ! wait "${P}"; then
      FAIL=$((FAIL + 1))
      echo "[refresh-api] shard PID ${P} exited non-zero after all retries"
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

# ---------- 5b. Refresh NSE event-calendar cache ----------
#
# Feeds overview.next_earnings_date in every deep/<TICKER>.json the parser
# is about to write — sws-api-parser.mjs:763 reads
# data/sws/nse-event-calendar.json keyed by NSE bare symbol and joins it
# onto each stock at parse time. Without this refresh the parser falls
# through gracefully (sws-api-parser.mjs:838 logs "NSE calendar: not
# loaded") and writes next_earnings_date=null on every deep file.
#
# Non-fatal: a transient NSE 403/timeout would otherwise abort the entire
# scrape. Wrapped + tail-truncated so a flaky NSE run is logged but never
# blocks the SWS push.
#
# Pre-2026-05-15 this fetcher was orphaned — only invoked by hand. The
# cache went 16 days stale and 5,200 of 5,516 deep files carried
# next_earnings_date=null, leaving the Portfolio Analyzer's "Upcoming
# results calendar" section empty for ~94% of holdings. Folding it into
# the API refresh fixes that silently-broken state.

echo "[refresh-api] refreshing NSE event-calendar cache..."
if ! node scripts/sws-fetch-nse-calendar.mjs 2>&1 | tail -5 | sed 's/^/[nse-cal] /'; then
  echo "[refresh-api] NSE calendar fetch failed — non-fatal, parser will write next_earnings_date=null"
fi

# Groww/Refinitiv is canonical for fast-moving India fundamentals. The full
# network pass is intentionally restricted to the 00:30 IST launchd window;
# manual runs outside that window validate and reuse the last good cache. The
# script writes both groww-stock-latest.json and the legacy groww-pe-latest.json
# alias.
GROWW_STEP_IST_HHMM="$(TZ=Asia/Kolkata date +%H%M)"
if [ "${SWS_GROWW_FORCE_REFRESH:-0}" = "1" ] || { [ "${RUN_STARTED_IST_HHMM}" -ge 0 ] && [ "${RUN_STARTED_IST_HHMM}" -lt 200 ]; }; then
  echo "[refresh-api] refreshing Groww/Refinitiv stock cache (00:30 IST full pass; run_hhmm=${RUN_STARTED_IST_HHMM}, step_hhmm=${GROWW_STEP_IST_HHMM})..."
  GROWW_CMD=(node scripts/groww-pe-refresh.mjs --force --max-age-days 1 --stale-grace-days 3)
else
  echo "[refresh-api] validating Groww/Refinitiv stock cache (reuse outside 00:30 IST; run_hhmm=${RUN_STARTED_IST_HHMM}, step_hhmm=${GROWW_STEP_IST_HHMM})..."
  GROWW_CMD=(node scripts/groww-pe-refresh.mjs --validate-only --max-age-days 1 --stale-grace-days 3)
fi
if GROWW_OUT="$("${GROWW_CMD[@]}" 2>&1)"; then
  echo "${GROWW_OUT}" | tail -10 | sed 's/^/[groww-stock] /'
else
  echo "${GROWW_OUT}" | tail -12 | sed 's/^/[groww-stock] /'
  echo "[refresh-api] Groww stock cache unavailable and no stale cache inside grace — aborting so canonical fields do not silently revert"
  exit 6
fi

# ---------- 6. Parse raw API → scoring-compatible JSON ----------

echo "[refresh-api] parsing raw API payloads..."
PARSE_OUT="$(node scripts/sws-api-parser.mjs --dest deep 2>&1 || true)"
echo "${PARSE_OUT}" | tail -5 | sed 's/^/[parser] /'

# ---------- 7. Seed score ----------

echo "[refresh-api] running seed scoring..."
SCORING_OUT="$(node scripts/sws-scoring.mjs 2>&1 || true)"
echo "${SCORING_OUT}" | tail -12 | sed 's/^/[scoring] /'

# ---------- 7.5. Refresh sector outlook, then final score ----------
#
# The growing_sector_value section depends on Sector Outlook. Seed scoring
# gives refresh-sector-outlook.mjs a current picks-latest.json, then final
# scoring reads the fresh outlook and writes the section into picks-latest.
# Both sector steps stay non-fatal so the SWS scrape can still ship; the scorer
# withholds growing_sector_value when outlook is stale/missing/macro-mismatched.

echo "[refresh-api] refreshing sector news themes for growing-sector section..."
if ! run_with_timeout 900 node scripts/refresh-sector-news-themes.mjs --max-llm-calls=400 2>&1 | tail -12 | sed 's/^/[sector-themes] /'; then
  echo "[sector-themes] non-zero exit — continuing with prior themes/outlook"
fi
echo "[refresh-api] refreshing sector outlook for growing-sector section..."
if ! run_with_timeout 120 node scripts/refresh-sector-outlook.mjs 2>&1 | tail -12 | sed 's/^/[sector-outlook] /'; then
  echo "[sector-outlook] non-zero exit — continuing with prior outlook"
fi
echo "[refresh-api] running final scoring with sector outlook..."
FINAL_SCORING_OUT="$(node scripts/sws-scoring.mjs 2>&1 || true)"
echo "${FINAL_SCORING_OUT}" | tail -12 | sed 's/^/[scoring-final] /'

# ---------- 8. Backfill last-quarter beat/miss ----------

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

# ---------- 8.5. Stamp section_status (newly added / trending) ----------
# Diffs current picks-latest.json against picks-previous.json (last run's final
# file, post-narrate) and stamps `section_status` on every per-section stock.
# Must run AFTER narrate — narrate rewrites picks-latest in place and would
# otherwise drop the badge fields. See scripts/sws-section-status.mjs for the
# threshold table and AVOID carve-out.

echo "[refresh-api] stamping section status (newly added / trending)..."
STAMP_FAILED=0
if STAMP_OUT="$(node scripts/sws-stamp-section-status.mjs 2>&1)"; then
  :
else
  STAMP_FAILED=1
  echo "[refresh-api] STAMP FAILED — section_status will be missing from picks-latest.json"
fi
echo "${STAMP_OUT}" | tail -8 | sed 's/^/[stamp] /'

# Defence-in-depth: even if the stamper returned exit 0, verify section_status
# actually landed on every stock. Catches future regressions where the script
# runs but writes the wrong thing (e.g. a silently-empty diff). The original
# May-11 incident — see commit history of this file for context — was a
# SyntaxError swallowed by the old `|| true`; this check would have caught it
# even after that was fixed.
STAMPED_COUNT="$(node -e '
  const p = JSON.parse(require("fs").readFileSync("data/sws/picks-latest.json", "utf-8"));
  let n = 0;
  for (const items of Object.values(p.sections || {})) {
    if (!Array.isArray(items)) continue;
    for (const s of items) if (s && s.section_status) n++;
  }
  console.log(n);
' 2>/dev/null || echo "0")"
if [ "${STAMPED_COUNT}" = "0" ]; then
  STAMP_FAILED=1
  echo "[refresh-api] STAMP SMOKE CHECK FAILED — 0 stocks have section_status in picks-latest.json"
else
  echo "[refresh-api] stamp smoke check: ${STAMPED_COUNT} stocks have section_status"
fi

# ---------- 8.6. Track Record snapshot ----------
#
# This is intentionally outside sws-narrate-picks.mjs so Track Record history is
# captured even when ANTHROPIC_API_KEY is absent and narration is skipped.

echo "[refresh-api] snapshotting SWS Track Record..."
if ! node scripts/sws-snapshot-track-record.mjs 2>&1 | tail -8 | sed 's/^/[track] /'; then
  echo "[track] non-zero exit — continuing (Track Record snapshot is non-fatal)"
fi

# ---------- 8.7. Inline sanity gate (pass 1) ----------
#
# Runs the SAME sanity gate that sws-nightly.sh runs at the end of the
# pipeline, but HERE — between stamp and PDF — BEFORE the ~106-min
# auxiliary chain (news + catalysts + fundamentals + ... + risk-lab)
# opens a window during which something has historically reverted
# picks-latest.json (root cause: 2026-05-18 22:37 IST failure).
#
# --inline mode: same checks, but does NOT write the timestamped
# _sanity/<runId>.json or clobber _latest.json (the outer nightly's
# gate owns those). Drops a marker file _inline_pass.flag on pass;
# sws-nightly.sh reads it to differentiate "scoring failed" (both
# gates fail) from "data reverted post-stamp" (inline passed, outer
# failed) — that divergence IS the tripwire.
#
# We DON'T want to hard-fail the pipeline here yet — let the auxiliary
# refreshes (catalysts/fundamentals/earnings) still ship even if SWS
# has an issue. The outer gate decides whether to push SWS data; the
# inline gate just records "data was fine right after stamp" for
# post-hoc forensics. Hence "|| true" — we capture exit code, log it,
# but never abort the refresh-api here.
#
# Pre-stamp last-refresh.json doesn't exist yet (that's step 10), so
# the inline gate's picks_matches_last_refresh check sees lr=null and
# degrades to a missing-input WARN — that's fine, the value is in the
# OTHER L1 checks (scored_count, news_populated, sections present)
# all of which read picks-latest.json directly. They confirm the file
# scoring just wrote has the expected shape and content.

INLINE_PASS_FLAG="data/sws/_sanity/_inline_pass.flag"
rm -f "${INLINE_PASS_FLAG}" 2>/dev/null
echo "[refresh-api] inline sanity gate (pass 1, post-stamp, pre-PDF)..."
INLINE_GATE_RC=0
node scripts/sws-sanity-gate.mjs --inline 2>&1 | sed 's/^/[gate-inline] /' || INLINE_GATE_RC=$?
if [ ${INLINE_GATE_RC} -eq 0 ]; then
  echo "[refresh-api] inline sanity gate: PASS (flag dropped at ${INLINE_PASS_FLAG})"
else
  echo "[refresh-api] inline sanity gate: FAIL (rc=${INLINE_GATE_RC}) — outer gate in nightly will block the push"
fi

# ---------- 9. PDF ----------

echo "[refresh-api] generating PDF..."
PDF_OUT="$(python3 scripts/generate-sws-picks-pdf.py 2>&1 || true)"
echo "${PDF_OUT}" | tail -3 | sed 's/^/[pdf] /'

# ---------- 10. Summary ----------

node --input-type=module - <<EOF
import {writeFileSync, readFileSync, readdirSync, existsSync} from "fs";
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
// News + rewards/risks population stats — read every deep/<T>.json once,
// count stocks with non-empty \`news\` (Brief + Event from
// /dashboard/company) and with non-empty \`overview.rewards\` /
// \`overview.risks\` (from /backend/statements, extracted by
// sws-api-parser.mjs). Surfaces silent breakage of those endpoints: if SWS
// changes shape the deep files quietly revert to empty arrays, and the L1
// canary in sws-sanity-gate.mjs refuses to push. Note: news is top-level
// but rewards/risks live under \`overview\`.
let newsPopulatedCount = 0, newsItemsTotal = 0, deepFilesScanned = 0;
let rewardsPopulatedCount = 0, risksPopulatedCount = 0;
try {
  const dir = "data/sws/deep";
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      deepFilesScanned++;
      try {
        const d = JSON.parse(readFileSync(dir + "/" + f, "utf-8"));
        if (Array.isArray(d.news) && d.news.length > 0) {
          newsPopulatedCount++;
          newsItemsTotal += d.news.length;
        }
        const ov = d.overview || {};
        if (Array.isArray(ov.rewards) && ov.rewards.length > 0) rewardsPopulatedCount++;
        if (Array.isArray(ov.risks) && ov.risks.length > 0) risksPopulatedCount++;
      } catch {}
    }
  }
} catch {}
let growwPeCache = null;
try {
  const fp = "data/sws/groww-pe-latest.json";
  if (existsSync(fp)) {
    const g = JSON.parse(readFileSync(fp, "utf-8"));
    const fetchedMs = Date.parse(g.fetched_at || "");
    const expiresMs = Date.parse(g.expires_at || "");
    const nowMs = Date.now();
    growwPeCache = {
      fetched_at: g.fetched_at || null,
      expires_at: g.expires_at || null,
      status: Number.isFinite(expiresMs) && nowMs < expiresMs ? "fresh" : "stale",
      age_days: Number.isFinite(fetchedMs) ? Math.round(((nowMs - fetchedMs) / 86400000) * 100) / 100 : null,
      coverage: g.coverage || null,
    };
  }
} catch {}
let growwStockCache = null;
try {
  const fp = "data/sws/groww-stock-latest.json";
  if (existsSync(fp)) {
    const g = JSON.parse(readFileSync(fp, "utf-8"));
    const fetchedMs = Date.parse(g.fetched_at || "");
    const expiresMs = Date.parse(g.expires_at || "");
    const nowMs = Date.now();
    growwStockCache = {
      fetched_at: g.fetched_at || null,
      expires_at: g.expires_at || null,
      status: Number.isFinite(expiresMs) && nowMs < expiresMs ? "fresh" : "stale",
      age_days: Number.isFinite(fetchedMs) ? Math.round(((nowMs - fetchedMs) / 86400000) * 100) / 100 : null,
      coverage: g.coverage || null,
    };
  }
} catch {}
const parserConsumed = new Set([
  "graphql:CompanySummary",
  "graphql:getNarrativeValuation",
  "graphql:CompanyNarrativesWithHistogram",
  "graphql:getCompanyDividends",
  "graphql:getCompanyPeers",
  "graphql:NarrativeValuationHistory",
  "rest:price",
  "rest:ownership",
  "rest:industry",
  "rest:dashboard_company",
  "rest:statements",
]);
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
let endpointTiming = {};
try {
  const dir = "data/sws/deep-api";
  const buckets = new Map();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(dir + "/" + f, "utf-8"));
        for (const t of d.telemetry?.endpoint_timings || []) {
          const key = String(t.kind || "") + ":" + String(t.name || "");
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(t);
        }
      } catch {}
    }
  }
  for (const [key, rows] of buckets.entries()) {
    const ms = rows.map((r) => Number(r.ms)).filter(Number.isFinite);
    endpointTiming[key] = {
      count: rows.length,
      failures: rows.filter((r) => r.ok === false).length,
      bytes: rows.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0),
      total_ms: ms.reduce((sum, v) => sum + v, 0),
      p50_ms: percentile(ms, 50),
      p95_ms: percentile(ms, 95),
      parser_consumed: parserConsumed.has(key),
    };
  }
} catch {}
const summary = {
  // started_at is the pipeline wrapper's wall-clock kickoff (captured at
  // refresh-api.sh:44 as RUN_STARTED_ISO). Pair with finished_at for the
  // sanity gate's picks_matches_last_refresh consistency check — no
  // subtraction-from-duration needed (duration is float-rounded to seconds).
  started_at: "${RUN_STARTED_ISO}",
  finished_at: new Date().toISOString(),
  pipeline: "api",
  duration_seconds: ${ELAPSED},
  shards_failed: ${FAIL},
  scrape_skipped: ${SCRAPE_SKIPPED},
  scored_count: scoredCount,
  sections_count: sectionsCount,
  per_shard_progress: progress,
  news_populated_count: newsPopulatedCount,
  news_items_total: newsItemsTotal,
  rewards_populated_count: rewardsPopulatedCount,
  risks_populated_count: risksPopulatedCount,
  groww_stock_cache: growwStockCache,
  groww_pe_cache: growwPeCache,
  endpoint_timing: endpointTiming,
  deep_files_scanned: deepFilesScanned,
  stamping_status: ${STAMP_FAILED:-0} > 0 ? "failed" : "success",
  pipeline_status: ${SCRAPE_SKIPPED}
    ? "skipped_scrape_already_running"
    : (${FAIL} > 0 ? "partial" : "success"),
};
writeFileSync("${SUMMARY}", JSON.stringify(summary, null, 2));
console.log("[refresh-api] summary written: scored=" + scoredCount + " news_stocks=" + newsPopulatedCount + " news_items=" + newsItemsTotal + " rewards_stocks=" + rewardsPopulatedCount + " risks_stocks=" + risksPopulatedCount + " groww_stock=" + (growwStockCache?.coverage?.coverage_pct ?? "?") + "% groww_pe=" + (growwPeCache?.coverage?.coverage_pct ?? "?") + "% shards=" + JSON.stringify(progress));
EOF

echo "=== refresh-api complete: $(ts) elapsed=${ELAPSED}s ==="

# ---------- 9b. Phase 3 dual-write: pre-finalise drift gate + finalise + post-flip sanity ----------
# Three sequential checks. The FIRST is a HARD gate: a picks-vs-snapshots
# Fair-Value drift (the bug fixed by ~/.claude/plans/so-i-have-attached-
# virtual-sphinx.md — STAR showed FV ₹1,264 on the card vs ₹1,078.5 on
# the modal in 2026-05-18) is a write-time consistency violation between
# the two tables. If detected, we MUST NOT flip is_canonical because that
# would make the drifted run visible to users at the API layer (the
# read-time guard in /api/sws-picks covers the visible-FV symptom but
# the score still bakes in the stale FV). On gate-fail, FAIL=1 so the
# auto-PR step below also skips, prior-canonical keeps serving, and the
# next nightly attempts a clean run. Loud-fail per CLAUDE.md.

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
    git add data/sws/picks-latest.json data/sws/last-refresh.json data/sws/v3-universe-stats.json data/sws/sws-scored-universe.json data/sws/groww-stock-failed.json data/sws/groww-pe-latest.json data/sws/groww-pe-failed.json 2>/dev/null
    # Pack 5,517-file deep/ into a single tarball so Vercel can bundle it
    # without tripping its 15k source-file cap. swsDal's jsonBackend lazy-
    # extracts to /tmp on first read in a cold container. Pack BEFORE the
    # git add so the tarball reflects the freshly-refreshed deep files.
    bash scripts/sws-pack-deep.sh 2>&1 | sed 's/^/[refresh-api] /'
    git add data/sws/deep.tar.gz 2>/dev/null
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

Once merged, prod (\`starbhai-stock-platform.vercel.app\`) will redeploy with the new picks." 2>&1 | tail -1)"
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
];
if (j.stamping_status === "failed") {
  lines.push(
    "",
    "⚠️ STAMPING FAILED — section_status missing from picks-latest.json.",
    "   The 'New' / '↑N' / 'Newly Flagged' badges will not render on cards",
    "   until the next successful run. Check scripts/sws-stamp-section-status.mjs.",
  );
}
lines.push(
  "",
  "Sections:",
  ...Object.entries(j.sections_count || {}).map(([k, v]) => `  ${k}: ${v}`),
  "",
  "Per-shard progress:",
  ...Object.entries(j.per_shard_progress || {}).map(([sid, p]) =>
    `  shard ${sid}: ${p.done_count} done · today ${p.today_count} · last ${p.last_ticker}`),
  "",
  "Prod: https://starbhai-stock-platform.vercel.app/",
);
if (pr.length) lines.push("", `Auto-PR opened: ${pr}`);
else lines.push("", "Auto-PR not opened (skipped or disabled — manual sync needed for prod to see fresh data).");
console.log(lines.join("\n"));
NODE_EOF
)"

MAIL_STATUS_ICON="✅"
[ "${FAIL}" -gt 0 ] && MAIL_STATUS_ICON="⚠️"
[ "${STAMP_FAILED:-0}" -gt 0 ] && MAIL_STATUS_ICON="⚠️"
MAIL_DATE="$(date -u +%Y-%m-%d)"
MAIL_SCORED="$(node -p "JSON.parse(require('fs').readFileSync('data/sws/last-refresh.json','utf-8')).scored_count" 2>/dev/null || echo "?")"

SWS_MAIL_FN "${MAIL_STATUS_ICON} SWS refresh ${MAIL_DATE} — ${MAIL_SCORED} stocks" "${MAIL_SUMMARY}"

exit 0
