#!/usr/bin/env bash
set -euo pipefail

# Run SWS news enrichment for one market using N parallel shards, then merge the
# per-shard news aggregate. Callers remain responsible for sequencing markets so
# India/US/KR/TW do not scrape concurrently with each other.
#
# Usage:
#   bash scripts/sws-news-sharded.sh in
#   SWS_NEWS_SHARD_COUNT=3 bash scripts/sws-news-sharded.sh us

MARKET="${1:-in}"
SHARD_COUNT="${SWS_NEWS_SHARD_COUNT:-${SWS_NEWS_SHARDS:-3}}"

if ! [[ "${SHARD_COUNT}" =~ ^[0-9]+$ ]] || [ "${SHARD_COUNT}" -lt 1 ]; then
  echo "[news-${MARKET}] invalid SWS_NEWS_SHARD_COUNT='${SHARD_COUNT}'"
  exit 2
fi

if [ "${MARKET}" = "in" ] || [ "${MARKET}" = "india" ]; then
  DATA_DIR="data/sws"
  MARKET="in"
else
  DATA_DIR="data/sws-${MARKET}"
fi
mkdir -p "${DATA_DIR}"

if [ "${SHARD_COUNT}" -eq 1 ]; then
  node scripts/sws-news-scrape.mjs --market "${MARKET}"
  exit $?
fi

echo "[news-${MARKET}] running ${SHARD_COUNT} news shard(s)"

pids=""
failed=0
for shard in $(seq 1 "${SHARD_COUNT}"); do
  log="${DATA_DIR}/news-shard-${shard}.log"
  (
    node scripts/sws-news-scrape.mjs \
      --market "${MARKET}" \
      --shard-id "${shard}" \
      --shard-count "${SHARD_COUNT}"
  ) > "${log}" 2>&1 &
  pid=$!
  pids="${pids} ${pid}:${shard}:${log}"
  echo "[news-${MARKET}] shard ${shard}/${SHARD_COUNT} -> PID ${pid} (${log})"
done

for entry in ${pids}; do
  pid="${entry%%:*}"
  rest="${entry#*:}"
  shard="${rest%%:*}"
  log="${rest#*:}"
  if wait "${pid}"; then
    echo "[news-${MARKET}] shard ${shard}/${SHARD_COUNT} done"
  else
    rc=$?
    failed=$((failed + 1))
    echo "[news-${MARKET}] shard ${shard}/${SHARD_COUNT} failed rc=${rc}; tail ${log}:"
    tail -30 "${log}" 2>/dev/null | sed "s/^/[news-${MARKET}-${shard}] /" || true
  fi
done

node scripts/sws-news-scrape.mjs \
  --market "${MARKET}" \
  --merge-shards \
  --shard-count "${SHARD_COUNT}"

if [ "${failed}" -gt 0 ]; then
  echo "[news-${MARKET}] ${failed}/${SHARD_COUNT} news shard(s) failed"
  exit 4
fi

echo "[news-${MARKET}] all news shards completed"
