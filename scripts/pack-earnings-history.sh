#!/usr/bin/env bash
# Pack data/catalysts/earnings-history/ (one JSON snapshot per day, ~260 MB and
# growing ~5 MB/day) into a single brotli-compressed tar for the Vercel function.
#
# WHY: shipped loose, the snapshots were 63.8 MB of the function bundle and on
# 2026-07-25 pushed it past Vercel's 250 MB uncompressed limit — every
# production and preview deploy failed until the archive was packed. It was then
# packed with `tar -czf`, but gzip compresses each snapshot on its own (its 32 KB
# window can't see the previous day's near-identical file): 21.1 MB by
# 2026-10-27, +0.2-0.6 MB a night, and the main reason the bundle hit its 200 MB
# budget. The brotli pack reaches back across days: ~3.4 MB, ~0.1 MB a night.
# Format + rationale: services/earnings/earningsHistoryPack.js.
#
# Output: data/catalysts/earnings-history.tar.br. Lazy-extracted in
# services/earnings/earningsHistoryStore.js:earningsHistoryReadDir() on first
# read in a cold Vercel container (extract target: /tmp/earnings-history).
#
# The loose directory stays in git — the local backtest, weight-tuning and
# actuals-resolution scripts all read it, and .vercelignore keeps it out of the
# upload. Only the archive ships. test/vercel-bundle-size.test.mjs fails the push
# when the archive and the loose snapshots disagree.
#
# Run anywhere: `bash scripts/pack-earnings-history.sh`

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d data/catalysts/earnings-history ]; then
  echo "[pack-earnings-history] ERROR: data/catalysts/earnings-history does not exist; skipping pack" >&2
  exit 1
fi

# Atomic (temp file + rename) and deterministic: the same snapshots always pack
# to the same bytes.
node services/earnings/earningsHistoryPack.js pack \
  data/catalysts/earnings-history data/catalysts/earnings-history.tar.br |
  sed 's/^/[pack-earnings-history] /'

# The gzip archive this replaced. .vercelignore keeps it out of the bundle; the
# nightly's `git add data/catalysts/` stages this deletion.
rm -f data/catalysts/earnings-history.tar.gz
