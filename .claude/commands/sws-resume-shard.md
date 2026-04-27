---
description: Resume a specific SWS scrape shard. Used by scheduled tasks. Usage: /sws-resume-shard {1|2|3}
allowed-tools: Bash, Read, Write, mcp__Claude_in_Chrome__*, mcp__scheduled-tasks__create_scheduled_task, mcp__scheduled-tasks__update_scheduled_task, mcp__scheduled-tasks__list_scheduled_tasks
---

# SWS Shard Resume

Equivalent to `/sws-scan-shard $ARGUMENTS`. Resumes the named shard from its last checkpoint.

Read shard ID from `$ARGUMENTS` and follow the protocol in `.claude/commands/sws-scan-shard.md` exactly. There is no special "resume" logic — the shard always picks up from `next_local_index` in its progress file. The protocol is idempotent.

If the shard's progress file shows `complete: true`, do not re-scrape. Instead:
1. Check whether the OTHER two shards' progress files are also `complete: true`.
2. If yes → all 3 shards done → fire `/sws-finalise` (which runs scoring + PDF). Then exit.
3. If no → just exit. The watcher task will fire eventually.
