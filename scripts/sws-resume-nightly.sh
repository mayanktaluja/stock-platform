#!/usr/bin/env bash
#
# Resume the SWS launchd jobs (nightly scrape, Phase 5 reminder,
# fundamentalsHistory refresh) after a pause.
# Reverse of: launchctl unload ~/Library/LaunchAgents/com.starbhai.sws-*.plist
#
# Usage: sws-resume      (alias defined in ~/.zshrc)
#        bash /Users/mayanktaluja/code/stock-platform/scripts/sws-resume-nightly.sh

set -e

NIGHTLY=~/Library/LaunchAgents/com.starbhai.sws-nightly.plist
REMINDER=~/Library/LaunchAgents/com.starbhai.sws-phase5-reminder.plist
FUNDHIST=~/Library/LaunchAgents/com.starbhai.sws-fundamentals-history.plist

# Idempotent: unload first in case they're already loaded, then load.
launchctl unload "$NIGHTLY" 2>/dev/null || true
launchctl unload "$REMINDER" 2>/dev/null || true
launchctl load -w "$NIGHTLY"
launchctl load -w "$REMINDER"

# fundamentalsHistory job — newer; tolerate the plist not being installed
# yet so this script still resumes the other two. Install it once with:
#   cp scripts/com.starbhai.sws-fundamentals-history.plist ~/Library/LaunchAgents/
if [ -f "$FUNDHIST" ]; then
  launchctl unload "$FUNDHIST" 2>/dev/null || true
  launchctl load -w "$FUNDHIST"
else
  echo "⚠ fundamentalsHistory plist not installed — skipping (template: scripts/com.starbhai.sws-fundamentals-history.plist)"
fi

echo "── SWS launchd jobs resumed ──"
launchctl list | grep starbhai
echo
echo "Next nightly fire:        16:30 IST daily"
echo "Phase 5 reminder:         09:00 IST daily check (fires email on 2026-05-18)"
echo "fundamentalsHistory job:  04:00 IST daily"
