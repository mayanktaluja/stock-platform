#!/usr/bin/env bash
# Pack data/sws/deep/ (5,517 per-ticker JSON files, ~70 MB) into a single
# gzipped tarball so Vercel's serverless function can bundle it as ONE file
# instead of 5,517 (which trips the Hobby tier's 15k source-file cap).
#
# Called by scripts/sws-refresh-api.sh just before the deep-dir git-add line.
# Output: data/sws/deep.tar.gz (~10 MB). Lazy-extracted in
# services/swsDal/jsonBackend.js:ensureDeepDir() on first read in a cold
# Vercel container (extract target: /tmp/sws-deep).
#
# Run anywhere: `bash scripts/sws-pack-deep.sh`

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d data/sws/deep ]; then
  echo "[sws-pack-deep] ERROR: data/sws/deep does not exist; skipping pack" >&2
  exit 1
fi

# Atomic write: pack to a sibling temp file, then mv. Avoids the deploy
# capturing a half-written tarball mid-pack.
TMP="data/sws/deep.tar.gz.tmp.$$"
tar -czf "$TMP" -C data/sws deep
mv -f "$TMP" data/sws/deep.tar.gz

SIZE=$(ls -lh data/sws/deep.tar.gz | awk '{print $5}')
COUNT=$(ls data/sws/deep | wc -l | tr -d ' ')
echo "[sws-pack-deep] packed $COUNT files -> data/sws/deep.tar.gz ($SIZE)"
