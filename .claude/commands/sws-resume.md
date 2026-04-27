---
description: Generic SWS resume — reads refresh-requested.json or per-shard progress and dispatches.
allowed-tools: Bash, Read, Write, mcp__Claude_in_Chrome__*, mcp__scheduled-tasks__create_scheduled_task, mcp__scheduled-tasks__update_scheduled_task, mcp__scheduled-tasks__list_scheduled_tasks
---

# SWS Generic Resume Dispatcher

Use this when the user clicked a refresh button in the Picks tab, OR after a system restart, OR if you don't know which shard to resume.

## Protocol

1. **Check for refresh request.** If `data/sws/refresh-requested.json` exists, read it. Possible modes:
   - `mode: "quick"` → run `/sws-quick-refresh`
   - `mode: "earnings"` → run `/sws-earnings-refresh`
   - `mode: "full"` → run `/sws-scan-shard {N}` for the shard ID this session is responsible for. Ask the user which shard if not clear.

2. **No refresh request → resume the most stale shard.**
   - Read `data/sws/progress-1.json`, `progress-2.json`, `progress-3.json`.
   - Find the shard whose `last_run_at` is oldest (and `complete !== true`).
   - Run `/sws-scan-shard {N}` for that shard.

3. **All 3 shards complete → run finalisation.**
   - If all 3 have `complete: true`, run `/sws-finalise` to score + categorise + write picks-latest.json + generate PDF.

4. **No work to do → exit cleanly.**
   - Print: "Nothing to resume. All shards complete; latest picks at /data/sws/picks-latest.json."
