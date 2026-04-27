---
description: Schedule all 3 SWS shards as independent task chains. One command, walk away. Usage: /sws-launch-all
allowed-tools: Bash, Read, mcp__scheduled-tasks__create_scheduled_task, mcp__scheduled-tasks__list_scheduled_tasks
---

# SWS Launch All Shards (Orchestrator)

This command schedules **3 separate task chains**, one per shard. Each chain runs as its own Claude process — true OS-level parallel scraping. You run this command once and walk away.

## Prerequisites (you must do these first)

1. **3 Chrome windows open**, all logged into Simply Wall Street (same Chrome profile so they share the session). Verify each shows the SWS dashboard with the "ST" avatar in the top-right.
2. **Claude extension installed in all 3 windows** so they appear in `mcp__Claude_in_Chrome__list_connected_browsers`.
3. **Mac kept awake**: in any terminal, run `caffeinate -dimsu &` (or `caffeinate -dimsu -t 259200 &` for 3 days).

If any prerequisite is missing, **stop and tell the user** before scheduling anything.

## Protocol

### Step 0: Pre-flight
1. Run `node scripts/sws-deep-scrape.mjs check-panic`. If exit 1, stop — panic-stop flag is active. Tell the user to review and delete `data/sws/panic-stop.flag`.
2. Verify universe exists: `ls data/sws/universe.json`. If missing, run `node scripts/sws-build-universe.mjs --seed`.
3. Verify 3 browsers connected. Use `mcp__Claude_in_Chrome__list_connected_browsers`. If fewer than 3 connected, ask the user to open more Chrome windows before proceeding. (1 browser = sequential, 2 = partial parallel — both work but slower than 3.)
4. List existing scheduled tasks via `mcp__scheduled-tasks__list_scheduled_tasks`. If any `sws-shard-*` or `sws-watcher` tasks already exist, list them to the user and confirm whether to replace or skip.

### Step 1: Compute fireAt timestamps
Run via Bash (use ISO 8601 with timezone offset):
```bash
node -e '
const now = Date.now();
const offsetMin = -new Date().getTimezoneOffset();
const sign = offsetMin >= 0 ? "+" : "-";
const oh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
const om = String(Math.abs(offsetMin) % 60).padStart(2, "0");
const fmt = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "") + sign + oh + ":" + om;
const t1 = now + 30 * 1000;          // shard 1: in 30 sec
const t2 = now + 2 * 3600 * 1000;    // shard 2: +2 hrs (ramp-up)
const t3 = now + 4 * 3600 * 1000;    // shard 3: +4 hrs (ramp-up)
console.log(JSON.stringify({ shard1: fmt(t1), shard2: fmt(t2), shard3: fmt(t3) }, null, 2));
'
```
Capture the 3 ISO timestamps.

### Step 2: Schedule the 3 shard launches
For each shard, call `mcp__scheduled-tasks__create_scheduled_task` with:

**Shard 1 task:**
- `taskId`: `sws-shard-1-launch`
- `description`: `SWS scrape shard 1 — first ramp-up wave`
- `fireAt`: (timestamp from Step 1, shard1)
- `prompt`: 
```
You are starting SWS scrape shard 1. Follow the playbook in `.claude/commands/sws-scan-shard.md` exactly. The shard ID is 1. Make sure to:
1. Check panic-stop first
2. Acquire shard 1 lock
3. Pick the first available Chrome browser (use list_connected_browsers + select_browser)
4. Scrape stocks from this shard's slice (next_local_index in progress-1.json)
5. After ~3-5 stocks (or when context budget tightens), schedule the next session via mcp__scheduled-tasks__create_scheduled_task with taskId="sws-shard-1-resume", fireAt=30 seconds from now, prompt="Resume SWS scrape shard 1 — follow .claude/commands/sws-resume-shard.md exactly. Shard ID is 1."
6. Release the lock and exit.
```
- `notifyOnCompletion`: false (we don't need a notification per fire — too noisy over 3 days)

**Shard 2 task:** same shape, taskId `sws-shard-2-launch`, fireAt = shard2 timestamp, shard ID 2 throughout.

**Shard 3 task:** same shape, taskId `sws-shard-3-launch`, fireAt = shard3 timestamp, shard ID 3 throughout.

### Step 3: Schedule the watcher
This task fires every 30 minutes and checks if all 3 shards are complete. When they are, it triggers `/sws-finalise` (scoring + PDF). Only one watcher task — recurring.

Call `mcp__scheduled-tasks__create_scheduled_task`:
- `taskId`: `sws-watcher`
- `description`: `Watch for all 3 SWS shards complete, then trigger finalisation`
- `cronExpression`: `*/30 * * * *` (every 30 min)
- `prompt`:
```
You are the SWS watcher. Check whether all 3 shards have completed:
1. Read /Users/mayanktaluja/Desktop/claude/stock-platform/data/sws/progress-1.json
2. Read /Users/mayanktaluja/Desktop/claude/stock-platform/data/sws/progress-2.json  
3. Read /Users/mayanktaluja/Desktop/claude/stock-platform/data/sws/progress-3.json

If ALL 3 have `complete: true`:
  - Run `node /Users/mayanktaluja/Desktop/claude/stock-platform/scripts/sws-scoring.mjs`
  - Run `python3 /Users/mayanktaluja/Desktop/claude/stock-platform/scripts/generate-sws-picks-pdf.py`
  - Then disable this watcher task by replying with: "All 3 shards complete. Picks + PDF generated. Watcher should be disabled — please call mcp__scheduled-tasks__update_scheduled_task with taskId=sws-watcher and enabled=false."
  - Exit.

Otherwise:
  - Print one-line status: "Shard 1: X done, Shard 2: Y done, Shard 3: Z done"
  - Exit. Watcher will check again in 30 minutes.
```
- `notifyOnCompletion`: false

### Step 4: Print summary
```
✅ SWS scan launched — 3 shard chains scheduled
  Shard 1: starts in 30 sec        (browser: <deviceId of browser 1>)
  Shard 2: starts in 2 hrs         (browser: <deviceId of browser 2>)
  Shard 3: starts in 4 hrs         (browser: <deviceId of browser 3>)
  Watcher: every 30 min            (auto-fires /sws-finalise when all complete)

Walk away. Check the Picks tab in the dashboard for live status.
If you see a 🚨 panic banner: review SWS in browser, decide, then delete data/sws/panic-stop.flag.

Estimated completion: ~3 days from now (~T+76h).
```

## Hard rules

- **Never schedule more than 1 watcher.** If one already exists, update it instead of creating a duplicate (causes double scoring runs).
- **Never schedule with fireAt in the past.** Always use timestamps from Step 1 directly.
- **If user has fewer than 3 browsers connected**, schedule only that many shards. The other shard(s) can be launched manually later via `/sws-scan-shard N`.
- **Never delete a panic-stop flag automatically.** That requires user review.
