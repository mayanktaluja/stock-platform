#!/usr/bin/env bash
# US SWS refresh orchestrator — the US fork of sws-refresh-api.sh, deliberately
# leaner: NO auto-PR / auto-merge, NO launchd cron, NO Neon, NO mail. The user
# runs this by hand (via /sws-refresh-us) and commits the result themselves.
#
# Chain:  co-run guard → spawn 3 US shards (retry) → parse → score →
#         (optional narrate) → (optional PDF) → write last-refresh.json
#
# Env:
#   SWS_SCRAPE_LIMIT=N   cap each shard to N stocks (use for the seed validate)
#   SWS_RESUME=1         continue shards from saved next_local_index (no reset)
#   SHARD_MAX_RETRIES=N  per-shard crash retries (default 2)
#
# Exit codes: 0 ok · 3 US panic flag set · 4 panic mid-scrape · 5 India scrape
# co-running (refused) · non-zero from a phase is logged but non-fatal.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

START_EPOCH=$(date +%s)
DATA_DIR="data/sws-us"
PANIC_FLAG="${DATA_DIR}/panic-stop.flag"
mkdir -p "${DATA_DIR}"

# ---------- 1. Co-run guard ----------
# The US and India pipelines share ONE SWS account + cf_clearance cookie, so a
# concurrent run doubles ban exposure and contends on the Chrome profile lock.
# Refuse if any India scrape (sws-api-scrape.mjs <shard> or sws-refresh-api.sh)
# is live. The regex matches the India script but NOT sws-api-scrape-us.mjs
# (which has "-us" before ".mjs").
INDIA_RUNNING="$(ps -A -o command= | grep -E 'sws-api-scrape\.mjs[ ]+[123]|sws-refresh-api\.sh' | grep -v grep | head -1 || true)"
if [ -n "${INDIA_RUNNING}" ]; then
  echo "[refresh-us] REFUSING to start — an India SWS scrape is running (shared SWS account/cf_clearance):"
  echo "    ${INDIA_RUNNING}"
  echo "[refresh-us] wait for it to finish, then re-run /sws-refresh-us."
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

# ---------- 7. Narrate (optional — only if the script + an API key exist) ----------
HAVE_KEY=0
[ -n "${ANTHROPIC_API_KEY:-}" ] && HAVE_KEY=1
{ [ "${HAVE_KEY}" -eq 0 ] && [ -f .env ] && grep -q '^ANTHROPIC_API_KEY=' .env; } && HAVE_KEY=1
if [ -f scripts/sws-narrate-picks-us.mjs ] && [ "${HAVE_KEY}" -eq 1 ]; then
  echo "[refresh-us] narrating..."
  node scripts/sws-narrate-picks-us.mjs 2>&1 | tail -8 | sed 's/^/[narrate-us] /' || echo "[narrate-us] non-zero exit — continuing"
else
  echo "[refresh-us] skipping narrate (no script or no ANTHROPIC_API_KEY — deterministic one-liners stand)"
fi

# ---------- 8. PDF (optional — only if the generator exists) ----------
if [ -f scripts/generate-us-picks-pdf.py ]; then
  echo "[refresh-us] generating PDF..."
  python3 scripts/generate-us-picks-pdf.py 2>&1 | tail -5 | sed 's/^/[pdf-us] /' || echo "[pdf-us] non-zero exit — continuing"
else
  echo "[refresh-us] skipping PDF (generator not present)"
fi

# ---------- 9. Write last-refresh.json ----------
node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync } from "fs";
import { PATHS } from "./scripts/sws-config-us.mjs";
let picks = {};
try { picks = JSON.parse(readFileSync(PATHS.picksLatest, "utf-8")); } catch {}
writeFileSync(PATHS.lastRefresh, JSON.stringify({
  pipeline: "api-us",
  finished_at: new Date().toISOString(),
  scored_count: picks.scored_count ?? null,
  universe_size: picks.universe_size ?? null,
  scanned_at: picks.scanned_at ?? null,
}, null, 2) + "\n");
console.log(`[refresh-us] wrote ${PATHS.lastRefresh} (scored_count=${picks.scored_count ?? "?"})`);
EOF

echo "[refresh-us] done in $(( $(date +%s) - START_EPOCH ))s. Review data/sws-us/picks-latest.json, then commit + push manually."
