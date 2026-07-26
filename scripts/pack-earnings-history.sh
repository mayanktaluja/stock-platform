#!/usr/bin/env bash
# Pack data/catalysts/earnings-history/ (one JSON snapshot per day, ~64 MB and
# growing ~5 MB/day) into a single gzipped tarball for the Vercel function.
#
# WHY: the daily snapshots are near-duplicates of each other, so they compress
# ~13x. Shipped loose they were 63.8 MB of the function bundle and on 2026-07-25
# pushed it past Vercel's 250 MB uncompressed limit — every production and
# preview deploy failed until the archive was packed.
#
# Output: data/catalysts/earnings-history.tar.gz (~5 MB). Lazy-extracted in
# services/earnings/earningsHistoryStore.js:earningsHistoryReadDir() on first
# read in a cold Vercel container (extract target: /tmp/earnings-history).
#
# The loose directory stays in git — the local backtest, weight-tuning and
# actuals-resolution scripts all read it, and .vercelignore keeps it out of the
# upload. Only the tarball ships.
#
# Run anywhere: `bash scripts/pack-earnings-history.sh`

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d data/catalysts/earnings-history ]; then
  echo "[pack-earnings-history] ERROR: data/catalysts/earnings-history does not exist; skipping pack" >&2
  exit 1
fi

# Atomic write: pack to a sibling temp file, then mv. Avoids a deploy or a
# concurrent reader capturing a half-written tarball mid-pack.
TMP="data/catalysts/earnings-history.tar.gz.tmp.$$"
trap 'rm -f "$TMP"' EXIT
tar -czf "$TMP" -C data/catalysts earnings-history
mv -f "$TMP" data/catalysts/earnings-history.tar.gz

SIZE=$(ls -lh data/catalysts/earnings-history.tar.gz | awk '{print $5}')
COUNT=$(find data/catalysts/earnings-history -name '*.json' | wc -l | tr -d ' ')
echo "[pack-earnings-history] packed $COUNT files -> data/catalysts/earnings-history.tar.gz ($SIZE)"
