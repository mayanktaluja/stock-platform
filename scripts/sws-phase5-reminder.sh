#!/bin/bash
# One-shot reminder: nudges to retire the on-disk JSON layer once Phase 4
# (SWS_READ_FROM_DB=1) has been stable for a week.
#
# Loaded by ~/Library/LaunchAgents/com.starbhai.sws-phase5-reminder.plist,
# fires daily at 09:00 IST, exits silently until 2026-05-18 (Phase 5 due
# date), sends the mail once, then self-disables via a marker file.

set -euo pipefail

DUE_DATE="2026-05-18"
MARKER="$HOME/.starbhai-phase5-reminder-sent"
REPO="/Users/mayanktaluja/code/stock-platform"

# Already sent?
[ -f "$MARKER" ] && exit 0

# Due yet? Compare YYYY-MM-DD strings lexically — works because the format
# is fixed-width.
TODAY="$(date +%Y-%m-%d)"
[ "$TODAY" \< "$DUE_DATE" ] && exit 0

cd "$REPO"

SUBJECT="Starbhai: Phase 5 cutover due — retire JSON commits"

BODY=$(cat <<'EOF'
A week ago you flipped Phase 4 (SWS_READ_FROM_DB=1) — the app now serves
SWS data from Neon. Time to retire the on-disk JSON layer:

1. PHASE 5 — drop JSON commits in the auto-PR.
   Edit scripts/sws-refresh-api.sh line ~309 (the `git add` lines):

     REMOVE:  git add data/sws/picks-latest.json data/sws/last-refresh.json \
              data/sws/v3-universe-stats.json data/sws/sws-scored-universe.json
              git add data/sws/deep/

     ADD:     mkdir -p data/sws/snapshots
              node scripts/sws-emit-summary.mjs
              pg_dump --data-only --table='sws_*' --table='nse_event_calendar' \
                --format=custom "$DATABASE_URL_UNPOOLED" \
                | gzip -9 > "data/sws/snapshots/$(date -u +%Y-%m-%d).pg.dump.gz"
              git add "data/sws/snapshots/$(date -u +%Y-%m-%d).pg.dump.gz"
              git add "data/sws/snapshots/$(date -u +%Y-%m-%d).summary.json"

   Then update .gitignore so data/sws/snapshots/ ships ONLY .gz + .summary.json.

2. PHASE 6 follow-up — convert scripts/sws-news-scrape.mjs and the four
   straggler scripts (sws-backfill-trade-log, sws-build-delta,
   coverage-gap-analysis, combined-shadow-summary, sws-shard-watchdog)
   to use the DAL. Until this lands, the pipeline machine must still
   write JSON to disk locally (just won't be committed).

3. VERIFY: after the first Phase 5 nightly run, the auto-PR diff should
   contain exactly one .pg.dump.gz + one .summary.json. PR review goes
   from unreviewable to scannable.

Full playbook: services/swsDal/README.md

EOF
)

if node scripts/sws-mail-summary.mjs "$SUBJECT" "$BODY" >> "$REPO/data/sws/launchd-stdout.log" 2>&1; then
  touch "$MARKER"
  echo "[phase5-reminder] $TODAY — email sent, marker written" >> "$REPO/data/sws/launchd-stdout.log"
else
  echo "[phase5-reminder] $TODAY — mail send FAILED; will retry tomorrow" >> "$REPO/data/sws/launchd-stderr.log"
  exit 1
fi
