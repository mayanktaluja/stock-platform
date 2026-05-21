#!/usr/bin/env bash
# Region (Korea / Taiwan) SWS refresh orchestrator — the generalization of
# sws-refresh-us.sh. Deliberately lean: NO auto-PR / auto-merge, NO launchd cron,
# NO Neon, NO mail. Run by hand (via /sws-refresh-kr or /sws-refresh-tw) and
# commit the result yourself.
#
# Chain:  co-run guard → spawn 3 shards (retry) → parse → score →
#         (optional narrate) → (optional PDF) → pack tarball → last-refresh.json
#
# Usage:
#   bash scripts/sws-refresh-region.sh kr
#   SWS_SCRAPE_LIMIT=200 bash scripts/sws-refresh-region.sh tw   # seed validate
#
# Env:
#   SWS_SCRAPE_LIMIT=N   cap each shard to N stocks (seed validate)
#   SWS_RESUME=1         continue shards from saved next_local_index
#   SHARD_MAX_RETRIES=N  per-shard crash retries (default 2)
#
# Exit codes: 0 ok · 2 bad args · 3 panic flag set · 4 panic mid-scrape ·
#   5 another market's scrape is co-running (refused) · phase non-zero is logged.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CODE="${1:-}"
case "${CODE}" in
  kr|tw) ;;
  *) echo "usage: sws-refresh-region.sh <kr|tw>"; exit 2 ;;
esac

START_EPOCH=$(date +%s)
DATA_DIR="data/sws-${CODE}"
PANIC_FLAG="${DATA_DIR}/panic-stop.flag"
mkdir -p "${DATA_DIR}"

# ---------- 1. Co-run guard (shared SWS account: India / US / sibling region) ----------
# shellcheck source=scripts/sws-corun-guard.sh
. "${SCRIPT_DIR}/sws-corun-guard.sh"
if ! corun_guard "${CODE}"; then
  echo "[refresh-${CODE}] aborting — see above."
  exit 5
fi

# ---------- 2. Pre-flight: panic flag ----------
if [ -f "${PANIC_FLAG}" ]; then
  echo "[refresh-${CODE}] PANIC flag set — refusing to run. Review SWS in a browser, then delete ${PANIC_FLAG}:"
  head -30 "${PANIC_FLAG}" 2>/dev/null | sed 's/^/    /'
  exit 3
fi

# ---------- 3. Detect already-running shards for this region ----------
LIVE_SHARDS="$(ps -A -o command= | grep -E "node[^|]*sws-api-scrape-region\.mjs.*--region[ ]+${CODE}.*--shard[ ]+[123]" | grep -vE 'grep|gh pr|pr create|--body|sws-status' | sed -E 's/.*--shard[ ]+([123]).*/\1/' | sort -u | paste -sd, - || true)"
PIDS=()
FAIL=0

LIMIT_ARG=""
if [ -n "${SWS_SCRAPE_LIMIT:-}" ]; then
  LIMIT_ARG="--limit ${SWS_SCRAPE_LIMIT}"
  echo "[refresh-${CODE}] SWS_SCRAPE_LIMIT=${SWS_SCRAPE_LIMIT} — each shard caps at ${SWS_SCRAPE_LIMIT} stocks (seed mode)"
fi

if [ -n "${LIVE_SHARDS}" ]; then
  echo "[refresh-${CODE}] shards [${LIVE_SHARDS}] already running → skipping scrape, scoring/PDF only"
else
  echo "[refresh-${CODE}] spawning 3 ${CODE} API shards in parallel"
  if [ "${SWS_RESUME:-0}" = "1" ]; then
    echo "[refresh-${CODE}] SWS_RESUME=1 — continuing from saved next_local_index"
  else
    DATA_DIR="${DATA_DIR}" node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync, existsSync } from "fs";
const dir = process.env.DATA_DIR;
for (const sid of [1, 2, 3]) {
  const fp = `${dir}/progress-api-${sid}.json`;
  if (!existsSync(fp)) continue;
  const p = JSON.parse(readFileSync(fp, "utf-8"));
  const before = p.next_local_index;
  p.next_local_index = 0;
  writeFileSync(fp, JSON.stringify(p, null, 2) + "\n");
  console.log(`[refresh] reset shard ${sid}: next_local_index ${before} → 0`);
}
EOF
  fi

  SHARD_MAX_RETRIES=${SHARD_MAX_RETRIES:-2}
  SHARD_RETRY_SLEEP_SEC=${SHARD_RETRY_SLEEP_SEC:-30}

  run_shard_with_retry() {
    local SHARD="$1"
    local LOG="${DATA_DIR}/refresh-${CODE}-shard-${SHARD}.log"
    : > "${LOG}"
    local attempt=0 rc=0
    while : ; do
      local resume=0
      [ "${attempt}" -gt 0 ] && resume=1
      echo "[refresh-${CODE}] shard ${SHARD} attempt $((attempt+1)) (SWS_RESUME=${resume})" >> "${LOG}"
      SWS_RESUME="${resume}" node scripts/sws-api-scrape-region.mjs --region "${CODE}" --shard "${SHARD}" ${LIMIT_ARG} >> "${LOG}" 2>&1
      rc=$?
      [ "${rc}" -eq 0 ] && return 0
      attempt=$((attempt + 1))
      if [ "${attempt}" -gt "${SHARD_MAX_RETRIES}" ]; then
        echo "[refresh-${CODE}] shard ${SHARD} failed after ${SHARD_MAX_RETRIES} retries (last rc=${rc})" >> "${LOG}"
        return "${rc}"
      fi
      echo "[refresh-${CODE}] shard ${SHARD} exited rc=${rc} — retry ${attempt}/${SHARD_MAX_RETRIES} (SWS_RESUME=1)" >> "${LOG}"
      sleep "${SHARD_RETRY_SLEEP_SEC}"
    done
  }

  for SHARD in 1 2 3; do
    run_shard_with_retry "${SHARD}" &
    PIDS+=("$!")
    echo "[refresh-${CODE}] shard ${SHARD} → PID $! (up to ${SHARD_MAX_RETRIES:-2} retries)"
    sleep 15  # gentle stagger
  done
  for P in "${PIDS[@]}"; do
    wait "${P}" || { FAIL=$((FAIL + 1)); echo "[refresh-${CODE}] shard PID ${P} exited non-zero after retries"; }
  done
  echo "[refresh-${CODE}] shards done in $(( $(date +%s) - START_EPOCH ))s (${FAIL} failed)"
fi

# ---------- 4. Re-check panic mid-run ----------
if [ -f "${PANIC_FLAG}" ]; then
  echo "[refresh-${CODE}] panic raised during scrape → skipping parse/score to avoid partial data."
  head -30 "${PANIC_FLAG}" 2>/dev/null | sed 's/^/    /'
  exit 4
fi

# ---------- 5. Parse raw API → scoring-compatible JSON ----------
echo "[refresh-${CODE}] parsing raw API payloads..."
node scripts/sws-api-parser-region.mjs --region "${CODE}" --dest deep 2>&1 | tail -5 | sed "s/^/[parser-${CODE}] /"

# ---------- 6. Score → picks-latest.json ----------
echo "[refresh-${CODE}] running scoring..."
node scripts/sws-scoring-region.mjs --region "${CODE}" 2>&1 | tail -14 | sed "s/^/[scoring-${CODE}] /"

# ---------- 6b. Pack deep briefs for prod serving ----------
if [ -d "${DATA_DIR}/deep" ] && [ -n "$(ls -A "${DATA_DIR}/deep" 2>/dev/null)" ]; then
  echo "[refresh-${CODE}] packing deep-${CODE}.tar.gz..."
  if tar -czf "${DATA_DIR}/deep-${CODE}.tar.gz" -C "${DATA_DIR}" deep; then
    echo "[refresh-${CODE}] packed $(ls "${DATA_DIR}/deep" | wc -l | tr -d ' ') deep files → ${DATA_DIR}/deep-${CODE}.tar.gz"
  else
    echo "[refresh-${CODE}] tarball pack failed — non-fatal (local deep/ still serves the modal)"
  fi
fi

# ---------- 7. Narrate (optional — script + key must exist; absent in v1) ----------
HAVE_KEY=0
[ -n "${ANTHROPIC_API_KEY:-}" ] && HAVE_KEY=1
{ [ "${HAVE_KEY}" -eq 0 ] && [ -f .env ] && grep -q '^ANTHROPIC_API_KEY=' .env; } && HAVE_KEY=1
if [ -f scripts/sws-narrate-picks-region.mjs ] && [ "${HAVE_KEY}" -eq 1 ]; then
  echo "[refresh-${CODE}] narrating..."
  node scripts/sws-narrate-picks-region.mjs --region "${CODE}" 2>&1 | tail -8 | sed "s/^/[narrate-${CODE}] /" || echo "[narrate-${CODE}] non-zero exit — continuing"
else
  echo "[refresh-${CODE}] skipping narrate (no script or no ANTHROPIC_API_KEY — deterministic one-liners stand)"
fi

# ---------- 8. PDF (optional — generator must exist; absent in v1) ----------
if [ -f scripts/generate-region-picks-pdf.py ]; then
  echo "[refresh-${CODE}] generating PDF..."
  python3 scripts/generate-region-picks-pdf.py --region "${CODE}" 2>&1 | tail -5 | sed "s/^/[pdf-${CODE}] /" || echo "[pdf-${CODE}] non-zero exit — continuing"
else
  echo "[refresh-${CODE}] skipping PDF (generator not present)"
fi

# ---------- 9. Write last-refresh.json ----------
SWS_REGION_CODE="${CODE}" node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync } from "fs";
import { makeRegionConfig } from "./scripts/sws-config-region.mjs";
const cfg = makeRegionConfig(process.env.SWS_REGION_CODE);
let picks = {};
try { picks = JSON.parse(readFileSync(cfg.PATHS.picksLatest, "utf-8")); } catch {}
writeFileSync(cfg.PATHS.lastRefresh, JSON.stringify({
  pipeline: `api-${process.env.SWS_REGION_CODE}`,
  finished_at: new Date().toISOString(),
  scored_count: picks.scored_count ?? null,
  universe_size: picks.universe_size ?? null,
  scanned_at: picks.scanned_at ?? null,
}, null, 2) + "\n");
console.log(`[refresh] wrote ${cfg.PATHS.lastRefresh} (scored_count=${picks.scored_count ?? "?"})`);
EOF

echo "[refresh-${CODE}] done in $(( $(date +%s) - START_EPOCH ))s. Review ${DATA_DIR}/picks-latest.json, then commit + push manually."
