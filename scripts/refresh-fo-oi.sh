#!/usr/bin/env bash
#
# F&O OI-Delta Swing Screener — refresh wrapper.
# Thin shell around scripts/refresh-fo-oi.mjs for cron / shell scheduling.
#
# Usage:
#   ./scripts/refresh-fo-oi.sh                     # most-recent IST weekday
#   ./scripts/refresh-fo-oi.sh --date=2026-05-05   # explicit date
#   ./scripts/refresh-fo-oi.sh --force             # bypass mtime grace
#
# Exit codes:
#   0  success (or BhavcopyNotPublished — silent skip, cron will retry)
#   75 EX_TEMPFAIL — bhavcopy blocked (cookie/Cloudflare); retry-later signal
#   1  unexpected failure
#
# Logs to data/nse-fo/refresh.log (also tee'd to stdout). Lock file held in
# data/nse-fo/pipeline.lock so concurrent invocations exit cleanly.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p data/nse-fo

exec node scripts/refresh-fo-oi.mjs "$@"
