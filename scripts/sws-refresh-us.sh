#!/usr/bin/env bash
# US SWS refresh orchestrator — the US fork of sws-refresh-api.sh. Manual
# trigger, but successful full runs auto-ship data via PR + auto-merge so prod
# does not keep serving a stale Vercel snapshot.
#
# Chain:  co-run guard → spawn 3 US shards (retry) → parse → score →
#         news enrichment → pack tarball → quality summary →
#         (optional narrate) → (optional PDF) → write last-refresh.json →
#         quality gate → auto-ship
#
# Env:
#   SWS_SCRAPE_LIMIT=N   cap each shard to N stocks (use for the seed validate)
#   SWS_RESUME=1         continue shards from saved next_local_index (no reset)
#   SHARD_MAX_RETRIES=N  per-shard crash retries (default 2)
#   SWS_US_AUTO_PR=0     skip branch + commit + push + PR (default: on)
#   SWS_US_AUTO_MERGE=0  leave the PR open instead of enabling auto-merge
#
# Exit codes: 0 ok · 3 US panic flag set · 4 panic mid-scrape · 5 India scrape
# co-running (refused) · non-zero from a phase is logged but non-fatal.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

START_EPOCH=$(date +%s)
DATA_DIR="data/sws-us"
PANIC_FLAG="${DATA_DIR}/panic-stop.flag"
QUALITY_SUMMARY_TMP="$(mktemp "${TMPDIR:-/tmp}/sws-us-quality-summary.XXXXXX.json")"
QUALITY_GATE_FAILED=0
mkdir -p "${DATA_DIR}"
cleanup_quality_summary_tmp() {
  rm -f "${QUALITY_SUMMARY_TMP}" >/dev/null 2>&1 || true
}
trap cleanup_quality_summary_tmp EXIT

# ---------- 1. Co-run guard (shared SWS account: India / KR / TW) ----------
# All four markets share ONE SWS account + cf_clearance cookie, so a concurrent
# run doubles ban exposure and contends on the Chrome profile lock. Refuse if any
# India OR region (KR/TW) scrape is live. The shared guard skips the US patterns,
# so this run never matches itself.
# shellcheck source=scripts/sws-corun-guard.sh
. ./scripts/sws-corun-guard.sh
# shellcheck source=scripts/sws-auto-ship.sh
. ./scripts/sws-auto-ship.sh
if ! corun_guard us; then
  echo "[refresh-us] aborting — see above."
  exit 5
fi

# ---------- 2. Pre-flight: US panic flag ----------
if [ -f "${PANIC_FLAG}" ]; then
  echo "[refresh-us] PANIC flag set — refusing to run. Review SWS in a browser, then delete ${PANIC_FLAG}:"
  head -30 "${PANIC_FLAG}" 2>/dev/null | sed 's/^/    /'
  exit 3
fi

# ---------- 3. Detect already-running US shards ----------
LIVE_SHARDS="$(ps -A -o command= | grep -E 'sws-api-scrape-us\.mjs[ ]+[123]' | grep -v grep | sed -E 's/.*sws-api-scrape-us\.mjs[ ]+([123]).*/\1/' | sort -u | paste -sd, - || true)"
PIDS=()
FAIL=0
SCRAPE_SKIPPED=false

LIMIT_ARG=""
if [ -n "${SWS_SCRAPE_LIMIT:-}" ]; then
  LIMIT_ARG="--limit ${SWS_SCRAPE_LIMIT}"
  echo "[refresh-us] SWS_SCRAPE_LIMIT=${SWS_SCRAPE_LIMIT} — each shard caps at ${SWS_SCRAPE_LIMIT} stocks (seed mode)"
fi

if [ -n "${LIVE_SHARDS}" ]; then
  echo "[refresh-us] US shards [${LIVE_SHARDS}] already running → skipping scrape, scoring/PDF only"
  SCRAPE_SKIPPED=true
else
  echo "[refresh-us] spawning 3 US API shards in parallel"
  # Reset cursor so each fresh run does a full pass (unless resuming).
  if [ "${SWS_RESUME:-0}" = "1" ]; then
    echo "[refresh-us] SWS_RESUME=1 — continuing from saved next_local_index"
  else
    node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync, existsSync } from "fs";
for (const sid of [1, 2, 3]) {
  const fp = `data/sws-us/progress-api-${sid}.json`;
  if (!existsSync(fp)) continue;
  const p = JSON.parse(readFileSync(fp, "utf-8"));
  const before = p.next_local_index;
  p.next_local_index = 0;
  writeFileSync(fp, JSON.stringify(p, null, 2) + "\n");
  console.log(`[refresh-us] reset shard ${sid}: next_local_index ${before} → 0`);
}
EOF
  fi

  SHARD_MAX_RETRIES=${SHARD_MAX_RETRIES:-2}
  SHARD_RETRY_SLEEP_SEC=${SHARD_RETRY_SLEEP_SEC:-30}

  run_shard_with_retry() {
    local SHARD="$1"
    local LOG="${DATA_DIR}/refresh-us-shard-${SHARD}.log"
    : > "${LOG}"
    local attempt=0 rc=0
    while : ; do
      local resume=0
      [ "${attempt}" -gt 0 ] && resume=1
      echo "[refresh-us] shard ${SHARD} attempt $((attempt+1)) (SWS_RESUME=${resume})" >> "${LOG}"
      SWS_RESUME="${resume}" node scripts/sws-api-scrape-us.mjs "${SHARD}" ${LIMIT_ARG} >> "${LOG}" 2>&1
      rc=$?
      [ "${rc}" -eq 0 ] && return 0
      attempt=$((attempt + 1))
      if [ "${attempt}" -gt "${SHARD_MAX_RETRIES}" ]; then
        echo "[refresh-us] shard ${SHARD} failed after ${SHARD_MAX_RETRIES} retries (last rc=${rc})" >> "${LOG}"
        return "${rc}"
      fi
      echo "[refresh-us] shard ${SHARD} exited rc=${rc} — retry ${attempt}/${SHARD_MAX_RETRIES} (SWS_RESUME=1)" >> "${LOG}"
      sleep "${SHARD_RETRY_SLEEP_SEC}"
    done
  }

  for SHARD in 1 2 3; do
    run_shard_with_retry "${SHARD}" &
    PIDS+=("$!")
    echo "[refresh-us] shard ${SHARD} → PID $! (up to ${SHARD_MAX_RETRIES:-2} retries)"
    sleep 15  # gentle stagger
  done
  for P in "${PIDS[@]}"; do
    wait "${P}" || { FAIL=$((FAIL + 1)); echo "[refresh-us] shard PID ${P} exited non-zero after retries"; }
  done
  echo "[refresh-us] shards done in $(( $(date +%s) - START_EPOCH ))s (${FAIL} failed)"
fi

# ---------- 4. Re-check panic mid-run ----------
if [ -f "${PANIC_FLAG}" ]; then
  echo "[refresh-us] panic raised during scrape → skipping parse/score to avoid partial data."
  head -30 "${PANIC_FLAG}" 2>/dev/null | sed 's/^/    /'
  exit 4
fi

# ---------- 5. Parse raw API → scoring-compatible JSON ----------
echo "[refresh-us] parsing raw API payloads..."
node scripts/sws-api-parser-us.mjs --dest deep 2>&1 | tail -5 | sed 's/^/[parser-us] /'

# ---------- 6. Score → picks-latest.json ----------
echo "[refresh-us] running scoring..."
node scripts/sws-scoring-us.mjs 2>&1 | tail -14 | sed 's/^/[scoring-us] /'

# ---------- 6a. SWS news enrichment ----------
# Non-fatal: news is modal enrichment, not the core leaderboard contract. It
# must run before packing so deep-us.tar.gz carries the refreshed `news[]`.
echo "[refresh-us] running SWS news enrichment..."
if ! bash scripts/sws-news-sharded.sh us 2>&1 | sed 's/^/[news-us] /'; then
  echo "[refresh-us] news enrichment failed — non-fatal, packing existing deep briefs"
fi

# ---------- 6b. Pack deep briefs for prod serving ----------
# data/sws-us/deep/ is gitignored (~5.4k files). Prod (Vercel) serves the
# per-stock modal from this committed tarball (usPicksDal extracts one member
# on demand). Members are deep/<TICKER>.json — matching usPicksDal's lookup.
if [ -d "${DATA_DIR}/deep" ] && [ -n "$(ls -A "${DATA_DIR}/deep" 2>/dev/null)" ]; then
  echo "[refresh-us] packing deep-us.tar.gz..."
  if tar -czf "${DATA_DIR}/deep-us.tar.gz" -C "${DATA_DIR}" deep; then
    echo "[refresh-us] packed $(ls "${DATA_DIR}/deep" | wc -l | tr -d ' ') deep files → ${DATA_DIR}/deep-us.tar.gz"
  else
    echo "[refresh-us] tarball pack failed — non-fatal (local deep/ still serves the modal)"
  fi
fi

# ---------- 7. Quality summary from deployable artifacts ----------
# The summary script is owned separately. When it is absent or fails, keep the
# generated data inspectable locally but fail closed for auto-ship.
rm -f "${QUALITY_SUMMARY_TMP}"
if [ -f scripts/sws-market-quality-summary.mjs ]; then
  echo "[refresh-us] computing market quality summary..."
  if node scripts/sws-market-quality-summary.mjs --market us > "${QUALITY_SUMMARY_TMP}"; then
    echo "[refresh-us] wrote quality summary counters → ${QUALITY_SUMMARY_TMP}"
  else
    echo "[refresh-us] quality summary failed — auto-ship will be skipped"
    QUALITY_GATE_FAILED=1
    rm -f "${QUALITY_SUMMARY_TMP}"
  fi
else
  echo "[refresh-us] scripts/sws-market-quality-summary.mjs missing — auto-ship will be skipped"
  QUALITY_GATE_FAILED=1
fi

# ---------- 8. Narrate (optional — only if the script + an API key exist) ----------
HAVE_KEY=0
[ -n "${ANTHROPIC_API_KEY:-}" ] && HAVE_KEY=1
{ [ "${HAVE_KEY}" -eq 0 ] && [ -f .env ] && grep -q '^ANTHROPIC_API_KEY=' .env; } && HAVE_KEY=1
if [ -f scripts/sws-narrate-picks-us.mjs ] && [ "${HAVE_KEY}" -eq 1 ]; then
  echo "[refresh-us] narrating..."
  node scripts/sws-narrate-picks-us.mjs 2>&1 | tail -8 | sed 's/^/[narrate-us] /' || echo "[narrate-us] non-zero exit — continuing"
else
  echo "[refresh-us] skipping narrate (no script or no ANTHROPIC_API_KEY — deterministic one-liners stand)"
fi

# ---------- 9. PDF (optional — only if the generator exists) ----------
if [ -f scripts/generate-us-picks-pdf.py ]; then
  echo "[refresh-us] generating PDF..."
  python3 scripts/generate-us-picks-pdf.py 2>&1 | tail -5 | sed 's/^/[pdf-us] /' || echo "[pdf-us] non-zero exit — continuing"
else
  echo "[refresh-us] skipping PDF (generator not present)"
fi

# ---------- 10. Write last-refresh.json ----------
SWS_QUALITY_SUMMARY_PATH="${QUALITY_SUMMARY_TMP}" node --input-type=module - <<'EOF'
import { existsSync, readFileSync, writeFileSync } from "fs";
import { PATHS } from "./scripts/sws-config-us.mjs";
let picks = {};
try { picks = JSON.parse(readFileSync(PATHS.picksLatest, "utf-8")); } catch {}
let quality = {};
const qualityPath = process.env.SWS_QUALITY_SUMMARY_PATH;
if (qualityPath && existsSync(qualityPath)) {
  try {
    const summary = JSON.parse(readFileSync(qualityPath, "utf-8"));
    quality = {
      ...summary,
      news_aggregate_generated_at: summary.news_aggregate?.generated_at ?? null,
      news_aggregate_coverage_count: summary.news_aggregate?.coverage_count ?? null,
      news_aggregate_items_count: summary.news_aggregate?.items_count ?? null,
      news_progress_done_count: summary.news_progress?.done_count ?? null,
      news_progress_failed_count: summary.news_progress?.failed_count ?? null,
    };
  } catch {}
}
writeFileSync(PATHS.lastRefresh, JSON.stringify({
  pipeline: "api-us",
  finished_at: new Date().toISOString(),
  scored_count: picks.scored_count ?? null,
  universe_size: picks.universe_size ?? null,
  scanned_at: picks.scanned_at ?? null,
  ...quality,
}, null, 2) + "\n");
console.log(`[refresh-us] wrote ${PATHS.lastRefresh} (scored_count=${picks.scored_count ?? "?"})`);
EOF

# ---------- 11. Market metadata + global macro calendar ----------
echo "[refresh-us] refreshing macro calendar (non-fatal)..."
node scripts/refresh-macro-calendar.mjs 2>&1 | tail -12 | sed 's/^/[macro-calendar] /' || \
  echo "[macro-calendar] non-zero exit — continuing with prior calendar"

echo "[refresh-us] refreshing US index constituents (non-fatal)..."
node scripts/refresh-us-index-constituents.mjs 2>&1 | tail -12 | sed 's/^/[us-index] /' || \
  echo "[us-index] non-zero exit — continuing with prior index snapshot"

UNIVERSE_AGE_HOURS=$(node --input-type=module -e '
import { existsSync, readFileSync } from "fs";
const p = "data/sws-us/universe-meta.json";
if (!existsSync(p)) { console.log(9999); process.exit(0); }
try {
  const j = JSON.parse(readFileSync(p, "utf-8"));
  if (!j.generatedAt) { console.log(9999); process.exit(0); }
  console.log(Math.floor((Date.now() - new Date(j.generatedAt).getTime()) / 3600000));
} catch { console.log(9999); }
' 2>/dev/null)
UNIVERSE_AGE_HOURS="${UNIVERSE_AGE_HOURS:-9999}"
if [ "${UNIVERSE_AGE_HOURS}" -lt 264 ]; then
  echo "[refresh-us] universe-meta.json is ${UNIVERSE_AGE_HOURS}h old — skipping sitemap rebuild"
else
  echo "[refresh-us] universe-meta.json is ${UNIVERSE_AGE_HOURS}h old — rebuilding US universe from sitemap..."
  node scripts/sws-universe-from-sitemap-us.mjs --write 2>&1 | tail -20 | sed 's/^/[us-universe] /' || \
    echo "[us-universe] non-zero exit — continuing with prior universe"
fi

# ---------- 12. Quality gate before auto-ship ----------
if [ -f scripts/sws-market-quality-gate.mjs ]; then
  echo "[refresh-us] running market quality gate..."
  if ! node scripts/sws-market-quality-gate.mjs --market us --summary "${QUALITY_SUMMARY_TMP}"; then
    echo "[refresh-us] market quality gate failed — auto-ship will be skipped"
    QUALITY_GATE_FAILED=1
  fi
else
  echo "[refresh-us] scripts/sws-market-quality-gate.mjs missing — auto-ship will be skipped"
  QUALITY_GATE_FAILED=1
fi

# ---------- 13. Auto-ship generated data ----------
SWS_SHIP_MARKET=us \
SWS_SHIP_MIN_SCORED=5000 \
SWS_SHIP_PICKS_PATH="${DATA_DIR}/picks-latest.json" \
SWS_SHIP_LAST_REFRESH_PATH="${DATA_DIR}/last-refresh.json" \
SWS_SHIP_FAILED_SHARDS="$((FAIL + QUALITY_GATE_FAILED))" \
SWS_SHIP_SCRAPE_SKIPPED="${SCRAPE_SKIPPED}" \
SWS_SHIP_COMMIT_BODY="US SWS full refresh generated data. Seed/capped runs and shard failures are intentionally refused by scripts/sws-auto-ship.sh." \
sws_auto_ship_market \
  "${DATA_DIR}/deep-us.tar.gz" \
  "${DATA_DIR}/last-refresh.json" \
  "${DATA_DIR}/picks-latest.json" \
  "${DATA_DIR}/sws-scored-universe.json" \
  "${DATA_DIR}/v3-universe-stats.json" \
  "${DATA_DIR}/universe.json" \
  "${DATA_DIR}/universe-meta.json" \
  "${DATA_DIR}/us-index-constituents.json" \
  data/macroCalendar.json

echo "[refresh-us] done in $(( $(date +%s) - START_EPOCH ))s. Full successful uncapped runs auto-ship via PR; seed/capped runs remain local for review."
