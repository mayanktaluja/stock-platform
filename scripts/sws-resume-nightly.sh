#!/usr/bin/env bash
#
# Resume the SWS launchd jobs (nightly scrape, Phase 5 reminder) after a pause.
# Reverse of: launchctl unload ~/Library/LaunchAgents/com.starbhai.sws-*.plist
#
# NOTE: the standalone fundamentalsHistory launchd job
# (com.starbhai.sws-fundamentals-history) was removed 2026-06-10 — its work is
# now folded into the nightly chain (sws-nightly.sh, 18h-gated step) so there is
# no separate job to resume.
#
# Usage: sws-resume      (alias defined in ~/.zshrc)
#        bash /Users/mayanktaluja/code/stock-platform/scripts/sws-resume-nightly.sh

set -e

NIGHTLY=~/Library/LaunchAgents/com.starbhai.sws-nightly.plist
REMINDER=~/Library/LaunchAgents/com.starbhai.sws-phase5-reminder.plist

# Idempotent: unload first in case they're already loaded, then load.
launchctl unload "$NIGHTLY" 2>/dev/null || true
launchctl unload "$REMINDER" 2>/dev/null || true
launchctl load -w "$NIGHTLY"
launchctl load -w "$REMINDER"

echo "── SWS launchd jobs resumed ──"
launchctl list | grep starbhai
echo
echo "Next nightly fire:        00:30 IST daily"
echo "Phase 5 reminder:         09:00 IST daily check (fires email on 2026-05-18)"
echo "fundamentalsHistory:      folded into the nightly chain (no separate job)"
