#!/usr/bin/env bash
# Region (Korea / Taiwan) SWS refresh orchestrator — the generalization of
# sws-refresh-us.sh. Successful full runs auto-ship data via PR + auto-merge
# so prod does not stay pinned to the previous committed snapshot.
#
# Chain:  co-run guard → spawn 3 shards (retry) → parse → score →
#         news enrichment → pack tarball → (optional narrate) →
#         (optional PDF) → last-refresh.json
#
# Usage:
#   bash scripts/sws-refresh-region.sh kr
#   SWS_SCRAPE_LIMIT=200 bash scripts/sws-refresh-region.sh tw   # seed validate
#
# Env:
#   SWS_SCRAPE_LIMIT=N   cap each shard to N stocks (seed validate)
#   SWS_RESUME=1         continue shards from saved next_local_index
#   SHARD_MAX_RETRIES=N  per-shard crash retries (default 2)
#   SWS_REGION_AUTO_PR=0 skip branch + commit + push + PR for KR/TW
#   SWS_KR_AUTO_PR=0     skip auto-PR for Korea only
#   SWS_TW_AUTO_PR=0     skip auto-PR for Taiwan only
#   SWS_REGION_AUTO_MERGE=0 leave KR/TW PRs open instead of enabling auto-merge
#   SWS_KR_AUTO_MERGE=0     leave Korea PRs open instead of enabling auto-merge
#   SWS_TW_AUTO_MERGE=0     leave Taiwan PRs open instead of enabling auto-merge
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
LIVE_SHARDS="$(ps -A -o command= | grep -E "sws-api-scrape-region\.mjs.*--region[ ]+${CODE}.*--shard[ ]+[123]" | grep -v grep | sed -E 's/.*--shard[ ]+([123]).*/\1/' | sort -u | paste -sd, - || true)"
PIDS=()
FAIL=0
SCRAPE_SKIPPED=false

LIMIT_ARG=""
if [ -n "${SWS_SCRAPE_LIMIT:-}" ]; then
  LIMIT_ARG="--limit ${SWS_SCRAPE_LIMIT}"
  echo "[refresh-${CODE}] SWS_SCRAPE_LIMIT=${SWS_SCRAPE_LIMIT} — each shard caps at ${SWS_SCRAPE_LIMIT} stocks (seed mode)"
fi

if [ -n "${LIVE_SHARDS}" ]; then
  echo "[refresh-${CODE}] shards [${LIVE_SHARDS}] already running → skipping scrape, scoring/PDF only"
  SCRAPE_SKIPPED=true
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

# ---------- 6a. SWS news enrichment ----------
# Non-fatal: news is modal enrichment, not the core leaderboard contract. It
# must run before packing so deep-${CODE}.tar.gz carries refreshed `news[]`.
echo "[refresh-${CODE}] running SWS news enrichment..."
if ! bash scripts/sws-news-sharded.sh "${CODE}" 2>&1 | sed "s/^/[news-${CODE}] /"; then
  echo "[refresh-${CODE}] news enrichment failed — non-fatal, packing existing deep briefs"
fi

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

# ---------- 10. Auto-propagate to prod (regional data PR) ----------
# Vercel serves committed JSON/tarball snapshots. Keep this isolated from the
# operator's working tree by copying only deployable artifacts into a temporary
# clean worktree before committing.
case "${CODE}" in
  kr)
    AUTO_PR_ENABLED="${SWS_KR_AUTO_PR:-${SWS_REGION_AUTO_PR:-1}}"
    AUTO_MERGE_ENABLED="${SWS_KR_AUTO_MERGE:-${SWS_REGION_AUTO_MERGE:-1}}"
    REGION_LABEL="Korea"
    ;;
  tw)
    AUTO_PR_ENABLED="${SWS_TW_AUTO_PR:-${SWS_REGION_AUTO_PR:-1}}"
    AUTO_MERGE_ENABLED="${SWS_TW_AUTO_MERGE:-${SWS_REGION_AUTO_MERGE:-1}}"
    REGION_LABEL="Taiwan"
    ;;
esac

if [ "${AUTO_PR_ENABLED:-1}" != "0" ] \
   && [ -z "${SWS_SCRAPE_LIMIT:-}" ] \
   && command -v gh >/dev/null 2>&1 \
   && [ "${FAIL}" -eq 0 ] \
   && [ "${SCRAPE_SKIPPED}" != "true" ]; then
  AUTO_DATE="$(date -u +%Y-%m-%d)"
  AUTO_STAMP="$(date -u +%Y-%m-%d-%H%M%S)"
  AUTO_BRANCH="chore/sws-${CODE}-auto-refresh-${AUTO_STAMP}"
  git fetch origin main >/dev/null 2>&1 || true
  BASE_REF="HEAD"
  git rev-parse --verify origin/main >/dev/null 2>&1 && BASE_REF="origin/main"
  ELAPSED=$(( $(date +%s) - START_EPOCH ))
  AUTO_WT="$(mktemp -d "${TMPDIR:-/tmp}/sws-${CODE}-auto-ship.XXXXXX")"
  echo "[refresh-${CODE}] auto-PR: branching ${AUTO_BRANCH} from ${BASE_REF} in ${AUTO_WT}"

  if git worktree add -b "${AUTO_BRANCH}" "${AUTO_WT}" "${BASE_REF}" >/dev/null 2>&1; then
    mkdir -p "${AUTO_WT}/${DATA_DIR}"
    COPY_FAIL=0
    for ARTIFACT in \
      "deep-${CODE}.tar.gz" \
      "last-refresh.json" \
      "picks-latest.json" \
      "sws-scored-universe.json" \
      "v3-universe-stats.json"; do
      if [ -f "${DATA_DIR}/${ARTIFACT}" ]; then
        cp "${DATA_DIR}/${ARTIFACT}" "${AUTO_WT}/${DATA_DIR}/${ARTIFACT}" || COPY_FAIL=1
      else
        echo "[refresh-${CODE}] auto-PR: missing ${DATA_DIR}/${ARTIFACT}"
        COPY_FAIL=1
      fi
    done

    if [ "${COPY_FAIL}" -ne 0 ]; then
      echo "[refresh-${CODE}] auto-PR: missing deployable artifacts — skipping"
    else
      git -C "${AUTO_WT}" add \
        "${DATA_DIR}/deep-${CODE}.tar.gz" \
        "${DATA_DIR}/last-refresh.json" \
        "${DATA_DIR}/picks-latest.json" \
        "${DATA_DIR}/sws-scored-universe.json" \
        "${DATA_DIR}/v3-universe-stats.json"

      if git -C "${AUTO_WT}" diff --cached --quiet; then
        echo "[refresh-${CODE}] auto-PR: no ${CODE} data changes to commit — skipping"
      else
        SCORED_COUNT="$(node --input-type=module -e "import fs from 'fs'; const p=JSON.parse(fs.readFileSync('${DATA_DIR}/picks-latest.json','utf8')); process.stdout.write(String(p.scored_count ?? 'unknown'));" 2>/dev/null || echo unknown)"
        COMMIT_MSG="chore(sws-${CODE}): auto-refresh ${AUTO_DATE} — full universe rescan

Auto-generated by scripts/sws-refresh-region.sh.
region: ${CODE}, duration: ${ELAPSED}s, shards_failed: ${FAIL}, scored_count: ${SCORED_COUNT}.

Without this commit, prod's stateless Vercel functions would continue
serving the previous deploy's ${REGION_LABEL} picks snapshot."

        if git -C "${AUTO_WT}" commit -m "${COMMIT_MSG}" >/dev/null 2>&1; then
          if git -C "${AUTO_WT}" push -u origin "${AUTO_BRANCH}" 2>&1 | sed "s/^/[refresh-${CODE}] /"; then
            PR_OUTPUT="$(gh -R mayanktaluja/stock-platform pr create --base main \
              --head "${AUTO_BRANCH}" \
              --title "chore(sws-${CODE}): auto-refresh ${AUTO_DATE}" \
              --body "Auto-generated by \`scripts/sws-refresh-region.sh ${CODE}\` — ships freshly-scraped ${REGION_LABEL} SWS data to prod.

* duration: ${ELAPSED}s
* shards_failed: ${FAIL}
* scored_count: ${SCORED_COUNT}
* see \`${DATA_DIR}/last-refresh.json\` for full pipeline summary

Once merged, prod (\`starbhai-stock-platform.vercel.app\`) will redeploy with the new ${REGION_LABEL} picks." 2>&1)"
            PR_URL="$(echo "${PR_OUTPUT}" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)"

            if [ -n "${PR_URL}" ]; then
              echo "[refresh-${CODE}] auto-PR opened: ${PR_URL}"
              if [ "${AUTO_MERGE_ENABLED:-1}" = "1" ]; then
                gh -R mayanktaluja/stock-platform pr merge "${PR_URL}" --squash --auto 2>&1 | sed "s/^/[refresh-${CODE}] /" \
                  || gh -R mayanktaluja/stock-platform pr merge "${PR_URL}" --squash 2>&1 | sed "s/^/[refresh-${CODE}] /" \
                  || echo "[refresh-${CODE}] auto-merge failed — PR awaits manual review"
              else
                echo "[refresh-${CODE}] auto-merge disabled — PR awaits manual review."
              fi
            else
              echo "[refresh-${CODE}] gh pr create failed: ${PR_OUTPUT}"
            fi
          fi
        else
          echo "[refresh-${CODE}] auto-PR: git commit failed — leaving changes in ${AUTO_WT}"
          AUTO_WT=""
        fi
      fi
    fi

    if [ -n "${AUTO_WT}" ]; then
      git worktree remove --force "${AUTO_WT}" >/dev/null 2>&1 || true
      git branch -D "${AUTO_BRANCH}" >/dev/null 2>&1 || true
    fi
  else
    echo "[refresh-${CODE}] auto-PR: worktree checkout failed — skipping"
    rmdir "${AUTO_WT}" >/dev/null 2>&1 || true
  fi
else
  echo "[refresh-${CODE}] auto-PR skipped (seed mode, failed shard, gh missing, scrape skipped, or auto-PR disabled)"
fi

echo "[refresh-${CODE}] done in $(( $(date +%s) - START_EPOCH ))s."
