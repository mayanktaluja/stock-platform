#!/usr/bin/env bash
# US SWS pipeline status — one-shot snapshot of the US picks fork (data/sws-us/).
# The US analog of scripts/sws-status.sh. Read-only.
# Auto-detects the live US data dir (the repo's own data/sws-us, or an active git
# worktree's), so it works whether the scrape runs in-repo or in a worktree.
# Override detection with: SWS_US_DIR=/abs/path/data/sws-us
set -o pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

DATA_DIR="${SWS_US_DIR:-}"
if [ -z "$DATA_DIR" ]; then
  best=""; bestt=0
  for d in "$REPO/data/sws-us" "$REPO"/.claude/worktrees/*/data/sws-us; do
    [ -d "$d" ] || continue
    t=$(stat -f %m "$d"/progress-api-*.json "$d"/last-refresh.json "$d"/refresh-us-shard-*.log "$d"/picks-latest.json 2>/dev/null | sort -rn | head -1)
    [ -z "$t" ] && t=0
    if [ "$t" -gt "$bestt" ]; then bestt="$t"; best="$d"; fi
  done
  DATA_DIR="$best"
fi

echo "============================================================"
echo "  US SWS pipeline status — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"
if [ -z "$DATA_DIR" ] || [ ! -d "$DATA_DIR" ]; then
  echo "  x No data/sws-us found (repo or worktrees). Has a US scrape run yet?"
  exit 0
fi
echo "  data dir: $DATA_DIR"

UNIV=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DATA_DIR/universe.json','utf8')).length)}catch(e){console.log('?')}" 2>/dev/null)
[ -z "$UNIV" ] && UNIV='?'

echo ""
echo "-- live US scrape processes --"
ps -A -o pid,etime,command | grep -E 'sws-api-scrape-us\.mjs|sws-refresh-us\.sh' | grep -v grep || echo "  (none -- US scrape not running)"

echo ""
echo "-- co-run safety (shared SWS account -- India must NOT scrape concurrently) --"
IND=$(ps -A -o command= | grep -E 'sws-api-scrape\.mjs[ ]+[123]|sws-refresh-api\.sh' | grep -vE 'grep|gh pr|pr create|--body|sws-status' | head -1)
if [ -n "$IND" ]; then echo "  ! India scrape RUNNING -- a US refresh will refuse (exit 5):"; echo "      $IND"; else echo "  ok: no India scrape running"; fi

echo ""
echo "-- per-shard progress (universe = $UNIV) --"
for s in 1 2 3; do
  f="$DATA_DIR/progress-api-$s.json"
  if [ -f "$f" ]; then
    node -e "const p=JSON.parse(require('fs').readFileSync('$f','utf8'));console.log('  shard $s: done='+(p.done_count??'?')+'  next_idx='+(p.next_local_index??'?')+'  last='+(p.last_ticker??'-')+(p.complete?'  [complete]':''))" 2>/dev/null || echo "  shard $s: (unreadable)"
  else echo "  shard $s: (no progress file)"; fi
done

echo ""
echo "-- scrape log counts (current run) --"
TOT=0
for s in 1 2 3; do
  l="$DATA_DIR/refresh-us-shard-$s.log"
  if [ -f "$l" ]; then
    d=$(grep -c '"event":"stock_done"' "$l" 2>/dev/null); d=${d:-0}
    fl=$(grep -c '"event":"stock_failed"' "$l" 2>/dev/null); fl=${fl:-0}
    echo "  shard $s: $d done, $fl failed"
    TOT=$((TOT + d))
  else echo "  shard $s: (no log)"; fi
done
if [ "$UNIV" != "?" ] && [ "$UNIV" -gt 0 ] 2>/dev/null; then echo "  total done this run: $TOT / $UNIV ($((TOT*100/UNIV))%)"; else echo "  total done this run: $TOT"; fi

echo ""
echo "-- deep brief counts --"
echo "  deep-api/: $(ls "$DATA_DIR/deep-api" 2>/dev/null | wc -l | tr -d ' ')    deep/: $(ls "$DATA_DIR/deep" 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "-- last finished full run --"
if [ -f "$DATA_DIR/last-refresh.json" ]; then
  node -e "const p=JSON.parse(require('fs').readFileSync('$DATA_DIR/last-refresh.json','utf8'));const fa=p.finished_at?new Date(p.finished_at):null;const age=fa?Math.round((Date.now()-fa.getTime())/60000):null;console.log('  finished:',p.finished_at||'?',(age!=null?'('+age+'m ago)':''));console.log('  pipeline:',p.pipeline||'?','| scored_count:',(p.scored_count??'?'),'| universe_size:',(p.universe_size??'?'))" 2>/dev/null
else echo "  (no last-refresh.json -- no full run has finished yet)"; fi

echo ""
echo "-- picks-latest.json (what the US tab serves) --"
if [ -f "$DATA_DIR/picks-latest.json" ]; then
  node -e "const p=JSON.parse(require('fs').readFileSync('$DATA_DIR/picks-latest.json','utf8'));console.log('  scored_count:',(p.scored_count??'?'),'| currency:',(p.currency??'?'),'| scanned_at:',(p.scanned_at??'?'));const s=p.sections||{};console.log('  sections:',Object.keys(s).map(k=>k+'='+(Array.isArray(s[k])?s[k].length:'?')).join(', '))" 2>/dev/null
else echo "  (no picks-latest.json yet)"; fi

if [ -f "$DATA_DIR/panic-stop.flag" ]; then echo ""; echo "  ! PANIC FLAG SET -- US refresh refuses until removed: $DATA_DIR/panic-stop.flag"; fi

echo ""
echo "-- logs (tail -f to watch) --"
echo "  $DATA_DIR/full-refresh.log"
echo "  $DATA_DIR/refresh-us-shard-{1,2,3}.log"
