#!/usr/bin/env bash
#
# One-shot status snapshot for the autonomous SWS refresh pipeline.
# Safe to run any time — read-only.
#
# Usage:
#   sws-status                 # full snapshot (shell alias, no cd needed)
#   sws-status --watch         # refresh every 5s (Ctrl+C to stop)
#   sws-status --live          # tail-f current shard logs
#   sws-status --pr            # only show recent auto-refresh PRs
#

REPO_DIR="/Users/mayanktaluja/code/stock-platform"
cd "${REPO_DIR}" || { echo "cannot cd to ${REPO_DIR}"; exit 1; }

MODE="snapshot"
case "${1:-}" in
  --watch) MODE="watch" ;;
  --live)  MODE="live" ;;
  --pr)    MODE="pr-only" ;;
esac

show() {
  clear 2>/dev/null

  echo "============================================================"
  echo "  SWS pipeline status — $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "============================================================"

  # ─── 1. launchd job ───
  echo
  echo "── launchd ──"
  if launchctl list | grep -q starbhai; then
    launchctl list | awk '/starbhai/ {printf "  pid=%-6s  exit=%-3s  label=%s\n", $1, $2, $3}'
    echo "  schedule: 00:30 IST daily"
  else
    echo "  ⚠ NOT registered. Run: launchctl load -w ~/Library/LaunchAgents/com.starbhai.sws-nightly.plist"
  fi

  # ─── 2. Live processes ───
  echo
  echo "── live processes ──"
  PROCS=$(ps -ax -o pid,etime,command | grep -E "sws-(api|nightly|refresh|pipeline)|caffeinate.*sws" | grep -v grep)
  if [ -n "${PROCS}" ]; then
    echo "${PROCS}" | awk '{printf "  %-7s  %-10s  %s %s %s\n", $1, $2, $3, $4, $5}'
  else
    echo "  (none — pipeline is idle)"
  fi

  # ─── 3. Pipeline lock ───
  echo
  echo "── pipeline lock ──"
  if [ -f data/sws/pipeline.lock ]; then
    echo "  🔒 HELD: $(cat data/sws/pipeline.lock | tr -d '\n' | sed 's/{//;s/}//')"
  else
    echo "  unlocked"
  fi

  # ─── 4. Per-shard live progress ───
  echo
  echo "── shard progress (file-based) ──"
  for s in 1 2 3; do
    LOG="data/sws/refresh-api-shard-$s.log"
    if [ -f "$LOG" ]; then
      DONE=$(grep -c '"event":"stock_done"' "$LOG" 2>/dev/null)
      ERRS=$(grep -c '"event":"stock_error"' "$LOG" 2>/dev/null)
      MTIME=$(stat -f "%Sm" -t "%H:%M:%S" "$LOG" 2>/dev/null)
      printf "  shard %s: done=%-4s errs=%-3s (last activity %s)\n" "$s" "$DONE" "$ERRS" "$MTIME"
    else
      echo "  shard $s: (no log)"
    fi
  done

  # ─── 5. Last finished run summary ───
  echo
  echo "── last finished run (JSON layer) ──"
  if [ -f data/sws/last-refresh.json ]; then
    node --input-type=module -e '
      import {readFileSync} from "fs";
      const lr = JSON.parse(readFileSync("data/sws/last-refresh.json","utf-8"));
      const sc = lr.sections_count || {};
      const ago = lr.finished_at ? Math.round((Date.now() - new Date(lr.finished_at).getTime())/60000) : null;
      console.log(`  finished:    ${lr.finished_at} (${ago}m ago)`);
      console.log(`  pipeline:    ${lr.pipeline}`);
      console.log(`  duration:    ${Math.round((lr.duration_seconds||0)/60)}m`);
      console.log(`  shards fail: ${lr.shards_failed}`);
      console.log(`  scored:      ${lr.scored_count}`);
      const keys = Object.keys(sc);
      if (keys.length) {
        const summary = keys.map(k => `${k}=${sc[k]}`).join(", ");
        console.log(`  sections:    ${summary}`);
      }
    ' 2>/dev/null
  else
    echo "  (data/sws/last-refresh.json missing)"
  fi

  # ─── 6. Phase 5 reminder ───
  echo
  echo "── Phase 5 reminder ──"
  if [ -f "$HOME/.starbhai-phase5-reminder-sent" ]; then
    echo "  ✓ already sent ($(stat -f "%Sm" "$HOME/.starbhai-phase5-reminder-sent"))"
  elif launchctl list | grep -q phase5-reminder; then
    DUE="2026-05-18"
    TODAY=$(date +%Y-%m-%d)
    if [ "$TODAY" \< "$DUE" ]; then
      DAYS_LEFT=$(( ($(date -j -f "%Y-%m-%d" "$DUE" "+%s") - $(date +%s)) / 86400 ))
      echo "  queued — fires on $DUE ($DAYS_LEFT days from now)"
    else
      echo "  due — should fire on next 09:00 IST tick"
    fi
  else
    echo "  ⚠ launchd job not loaded. Run: launchctl load -w ~/Library/LaunchAgents/com.starbhai.sws-phase5-reminder.plist"
  fi

  # ─── 7. Most recent nightly log lines ───
  echo
  echo "── nightly log (last 6 lines) ──"
  if [ -f data/sws/sws-nightly.log ]; then
    tail -6 data/sws/sws-nightly.log | sed 's/^/  /'
  else
    echo "  (no nightly log yet — first run hasn't fired)"
  fi

  # ─── 8. Recent PRs from auto-refresh ───
  if [ "$MODE" != "pr-only" ]; then
    echo
    echo "── recent auto-refresh PRs ──"
  fi
  if command -v gh >/dev/null 2>&1; then
    gh pr list --search "chore(sws): auto-refresh in:title" --state all --limit 5 \
      --json number,state,title,mergedAt,createdAt 2>/dev/null | \
      node --input-type=module -e '
        let s = ""; for await (const c of process.stdin) s += c;
        try {
          const prs = JSON.parse(s);
          if (!prs.length) { console.log("  (none yet)"); }
          for (const p of prs) {
            const status = p.mergedAt ? "✓ merged" : p.state.toLowerCase();
            const when = (p.mergedAt || p.createdAt || "").slice(0,16).replace("T"," ");
            console.log(`  #${p.number}  ${status.padEnd(10)}  ${when}  ${p.title}`);
          }
        } catch { console.log("  (gh query failed)"); }
      ' 2>/dev/null || echo "  (gh query failed)"
  else
    echo "  (gh CLI not available)"
  fi

  echo
  echo "── log file paths (tail -f any of these) ──"
  echo "  data/sws/sws-nightly.log         — orchestrator"
  echo "  data/sws/refresh-api.log         — wrapper (scrape→parse→score→PDF)"
  echo "  data/sws/refresh-api-shard-{1,2,3}.log — live shard scrapers"
  echo "  data/sws/launchd-stdout.log      — what launchd captured"
}

case "$MODE" in
  pr-only)
    if command -v gh >/dev/null 2>&1; then
      gh pr list --search "chore(sws): auto-refresh in:title" --state all --limit 10 \
        --json number,state,title,mergedAt,createdAt 2>/dev/null | \
        node --input-type=module -e '
          let s = ""; for await (const c of process.stdin) s += c;
          try {
            const prs = JSON.parse(s);
            for (const p of prs) {
              const status = p.mergedAt ? "✓ merged" : p.state.toLowerCase();
              const when = (p.mergedAt || p.createdAt || "").slice(0,16).replace("T"," ");
              console.log(`#${p.number}  ${status.padEnd(10)}  ${when}  ${p.title}`);
            }
          } catch (e) { console.log("(gh query failed: " + e.message + ")"); }
        ' 2>/dev/null
    fi
    ;;
  live)
    echo "Tailing live shard + refresh logs. Ctrl+C to stop."
    sleep 1
    tail -f data/sws/refresh-api.log data/sws/refresh-api-shard-{1,2,3}.log 2>/dev/null
    ;;
  watch)
    while true; do
      show
      echo
      echo "(refreshing every 5s — Ctrl+C to stop)"
      sleep 5
    done
    ;;
  *)
    show
    ;;
esac
