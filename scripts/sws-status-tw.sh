#!/usr/bin/env bash
# Taiwan SWS pipeline status — one-shot snapshot of the TW picks pipeline (data/sws-tw/).
# The Taiwan analog of scripts/sws-status.sh (India), sws-status-us.sh (US), and
# sws-status-kr.sh (Korea). Read-only. Auto-detects the live TW data dir (the repo's
# own data/sws-tw, or an active git worktree's), so it works whether the scrape runs
# in-repo or in a worktree.
# Override detection with: SWS_TW_DIR=/abs/path/data/sws-tw
set -o pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

DATA_DIR="${SWS_TW_DIR:-}"
DETECT_NOTE=""
if [ -z "$DATA_DIR" ]; then
  # Tier 1: if a TW scrape is LIVE, report ITS worktree (resolve the proc's cwd).
  # Beats mtime so a watch never gets stolen by another worktree's fresh write.
  for pid in $(ps -A -o pid=,command= | grep -E 'sws-api-scrape-region\.mjs.*--region[ ]+tw' | grep -v grep | awk '{print $1}'); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    if [ -n "$cwd" ] && [ -d "$cwd/data/sws-tw" ]; then DATA_DIR="$cwd/data/sws-tw"; DETECT_NOTE="  [live scrape pid $pid]"; break; fi
  done
  # Tier 2: no live scrape -> most-recently-written candidate; warn if >1 exists,
  # since an unrelated worktree's seed can out-recency the real full run.
  if [ -z "$DATA_DIR" ]; then
    best=""; bestt=0; cands=0
    for d in "$REPO/data/sws-tw" "$REPO"/.claude/worktrees/*/data/sws-tw; do
      [ -d "$d" ] || continue
      cands=$((cands + 1))
      t=$(stat -f %m "$d"/progress-api-*.json "$d"/last-refresh.json "$d"/refresh-tw-shard-*.log "$d"/picks-latest.json 2>/dev/null | sort -rn | head -1)
      [ -z "$t" ] && t=0
      if [ "$t" -gt "$bestt" ]; then bestt="$t"; best="$d"; fi
    done
    DATA_DIR="$best"
    [ "$cands" -gt 1 ] && DETECT_NOTE="  [!] $cands candidate dirs, no live scrape -- picked most-recent; pin with SWS_TW_DIR= if this is the wrong run"
  fi
fi

echo "============================================================"
echo "  Taiwan SWS pipeline status — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"
if [ -z "$DATA_DIR" ] || [ ! -d "$DATA_DIR" ]; then
  echo "  x No data/sws-tw found (repo or worktrees). Has a TW scrape run yet?"
  exit 0
fi
echo "  data dir: $DATA_DIR$DETECT_NOTE"
if [ -n "$DETECT_NOTE" ] && [ "${DETECT_NOTE#*\!}" != "$DETECT_NOTE" ]; then
  for d in "$REPO/data/sws-tw" "$REPO"/.claude/worktrees/*/data/sws-tw; do
    [ -d "$d" ] || continue
    sc=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$d/picks-latest.json','utf8')).scored_count)}catch(e){console.log('-')}" 2>/dev/null)
    mark=" "; [ "$d" = "$DATA_DIR" ] && mark="*"
    echo "    $mark $(echo "$d" | sed 's#.*/worktrees/##; s#.*/stock-platform/##')  (picks scored_count=${sc:--})"
  done
fi

UNIV=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DATA_DIR/universe.json','utf8')).length)}catch(e){console.log('?')}" 2>/dev/null)
[ -z "$UNIV" ] && UNIV='?'

echo ""
echo "-- live TW scrape processes --"
ps -A -o pid,etime,command | grep -E 'sws-api-scrape-region\.mjs.*--region[ ]+tw|sws-refresh-region\.sh[ ]+tw' | grep -v grep || echo "  (none -- TW scrape not running)"

echo ""
echo "-- co-run safety (ONE shared SWS account -- India/US/Korea must NOT scrape concurrently) --"
SIB=""
I=$(ps -A -o command= | grep -E 'sws-api-scrape\.mjs[ ]+[123]|sws-refresh-api\.sh' | grep -vE 'grep|gh pr|pr create|--body|sws-status' | head -1)
U=$(ps -A -o command= | grep -E 'sws-api-scrape-us\.mjs[ ]+[123]|sws-refresh-us\.sh' | grep -vE 'grep|gh pr|pr create|--body|sws-status' | head -1)
K=$(ps -A -o command= | grep -E 'sws-api-scrape-region\.mjs.*--region[ ]+kr|sws-refresh-region\.sh[ ]+kr' | grep -vE 'grep|gh pr|pr create|--body|sws-status' | head -1)
[ -n "$I" ] && { echo "  ! India scrape RUNNING -- a TW refresh will refuse (exit 5):"; echo "      $I"; SIB=1; }
[ -n "$U" ] && { echo "  ! US scrape RUNNING -- a TW refresh will refuse (exit 5):"; echo "      $U"; SIB=1; }
[ -n "$K" ] && { echo "  ! Korea scrape RUNNING -- a TW refresh will refuse (exit 5):"; echo "      $K"; SIB=1; }
[ -z "$SIB" ] && echo "  ok: no India / US / Korea scrape running"

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
  l="$DATA_DIR/refresh-tw-shard-$s.log"
  if [ -f "$l" ]; then
    d=$(grep -c '"event":"stock_done"' "$l" 2>/dev/null); d=${d:-0}
    fl=$(grep -c '"event":"stock_failed"' "$l" 2>/dev/null); fl=${fl:-0}
    echo "  shard $s: $d done, $fl failed"
    TOT=$((TOT + d))
  else echo "  shard $s: (no log)"; fi
done
if [ "$UNIV" != "?" ] && [ "$UNIV" -gt 0 ] 2>/dev/null; then echo "  total done this run: $TOT / $UNIV ($((TOT*100/UNIV))%)"; else echo "  total done this run: $TOT"; fi

echo ""
echo "-- last finished full run --"
if [ -f "$DATA_DIR/last-refresh.json" ]; then
  node -e "const p=JSON.parse(require('fs').readFileSync('$DATA_DIR/last-refresh.json','utf8'));const fa=p.finished_at?new Date(p.finished_at):null;const age=fa?Math.round((Date.now()-fa.getTime())/60000):null;console.log('  finished:',p.finished_at||'?',(age!=null?'('+age+'m ago)':''));console.log('  pipeline:',p.pipeline||'?','| scored_count:',(p.scored_count??'?'),'| universe_size:',(p.universe_size??'?'))" 2>/dev/null
else echo "  (no last-refresh.json -- no full run has finished yet)"; fi

echo ""
echo "-- stored quality counters (last-refresh.json) --"
if [ -f "$DATA_DIR/last-refresh.json" ]; then
  DATA_DIR="$DATA_DIR" node --input-type=module - <<'EOF' 2>/dev/null || echo "  (unreadable quality counters)"
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(`${process.env.DATA_DIR}/last-refresh.json`, "utf-8"));
const value = (key) => p[key] ?? "?";
const scored = Number(p.scored_count ?? 0);
const deep = Number(p.deep_files_scanned);
const news = Number(p.news_populated_count);
const rewards = Number(p.rewards_populated_count);
const risks = Number(p.risks_populated_count);
const progressFailed = Number(p.news_progress_failed_count ?? 0);
const hasCore = [deep, news, rewards].every(Number.isFinite) && scored > 0;
let status = "UNKNOWN";
if (hasCore) {
  status = deep < scored * 0.95 || news / scored < 0.20 || rewards / scored < 0.20
    ? "FAIL"
    : (Number.isFinite(risks) && risks / scored < 0.10) || progressFailed > 0
      ? "WARN"
      : "PASS";
}
const pct = (n) => Number.isFinite(n) && scored > 0 ? `${Math.round((n / scored) * 100)}%` : "?";
console.log(`  quality: ${status} | deep_files_scanned: ${value("deep_files_scanned")} (${pct(deep)}) | scored_count: ${value("scored_count")}`);
console.log(`  populated: news=${value("news_populated_count")} (${pct(news)}) rewards=${value("rewards_populated_count")} (${pct(rewards)}) risks=${value("risks_populated_count")} (${pct(risks)})`);
console.log(`  news items: ${value("news_items_total")} | aggregate: generated_at=${value("news_aggregate_generated_at")} coverage=${value("news_aggregate_coverage_count")} items=${value("news_aggregate_items_count")}`);
console.log(`  news progress: done=${value("news_progress_done_count")} failed=${value("news_progress_failed_count")}`);
EOF
else echo "  (no last-refresh.json -- quality counters unknown)"; fi

echo ""
echo "-- picks-latest.json (what the Taiwan Picks tab serves) --"
if [ -f "$DATA_DIR/picks-latest.json" ]; then
  node -e "const p=JSON.parse(require('fs').readFileSync('$DATA_DIR/picks-latest.json','utf8'));console.log('  scored_count:',(p.scored_count??'?'),'| currency:',(p.currency??'?'),'| scanned_at:',(p.scanned_at??'?'));const s=p.sections||{};console.log('  sections:',Object.keys(s).map(k=>k+'='+(Array.isArray(s[k])?s[k].length:'?')).join(', '))" 2>/dev/null
else echo "  (no picks-latest.json yet -- written after the scrape+score completes)"; fi

if [ -f "$DATA_DIR/panic-stop.flag" ]; then echo ""; echo "  ! PANIC FLAG SET -- TW refresh refuses until removed: $DATA_DIR/panic-stop.flag"; fi

echo ""
echo "-- logs (tail -f to watch) --"
echo "  orchestrator: /tmp/sws-tw-refresh.log"
echo "  $DATA_DIR/refresh-tw-shard-{1,2,3}.log"
