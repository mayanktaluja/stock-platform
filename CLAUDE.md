<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

---

## NSE scraping — runs LOCALLY, not on Vercel cron

**`nse.js:76-83` documents this**: NSE's homepage rejects Vercel
datacenter IPs from the cookie-source endpoint, so the cookie dance
fails intermittently on production. Any NSE call that needs a session
cookie (corporate-announcements, bulk-deals, block-deals, governance
filings) **must run from a local machine**, write the result to a
JSON file under `data/`, and be committed. Vercel just reads the file.

This is the same pattern as `scripts/refresh-catalysts.mjs` (NSE event
calendar) and applies equally to:
- `scripts/refresh-nse-corporate.mjs` — corp announcements + bulk/block
- `scripts/refresh-earnings.mjs` — depends on the above

**Do NOT call cookie-gated NSE endpoints from `/api/cron/*` routes.**
Those routes can flush in-process caches but should never originate
NSE traffic.

---

## Earnings Watch tab (admin-only)

A SEBI-RA-style upcoming-results dashboard with predictions, price
bands, 9-cell trading playbook, and post-result T+1 plans. Admin-only
gate: set `STARBHAI_ADMIN_PASSWORD` (different from
`STARBHAI_LOGIN_PASSWORD`) and log in with that password to see the
tab. Non-admin sessions get the tab hidden via JS + 403 on the
`/api/earnings/*` API.

### Refresh cadence (run locally, twice daily, then commit)

```bash
node scripts/refresh-catalysts.mjs       # NSE event-calendar (already existed)
node scripts/refresh-nse-corporate.mjs   # NSE announcements + bulk/block deals
node scripts/refresh-earnings.mjs        # Build the snapshot from the above
```

The `data/catalysts/` JSON files (`events-latest`, `nse-announcements-rolling`,
`nse-bulk-block-rolling`, `earnings-watch-latest`, `earnings-watch-stats`,
`earnings-history/<date>.json`) all need to be committed for Vercel to read them.

### Backtest

```bash
node scripts/backtest-earnings-predictions.mjs  # human-readable
node scripts/backtest-earnings-predictions.mjs --json  # machine-readable
```

Reports overall hit-rate, hit-rate-by-confidence-bucket, Brier score,
and the V1 confidence-cap-lift gate (≥30 resolved + ≥55% bucket hit-rate +
Brier <0.20). Until `actual_*` fields are populated in the per-day
history files, all metrics report as zero — that's expected.

### Modules

| File | Role |
|------|------|
| `services/earnings/earningsCalendarBuilder.js` | NSE event-calendar → calendar rows |
| `services/earnings/signalAggregator.js` | Joins SWS deep + history + sector + announcements + deals |
| `services/earnings/earningsPredictor.js` | 8-component scorer → BEAT/INLINE/MISS + confidence |
| `services/earnings/priceBandBuilder.js` | Bull/Base/Bear (capped ±15%) |
| `services/earnings/earningsRationaleNarrator.js` | 3-paragraph deterministic rationale |
| `services/earnings/reactionPlaybook.js` | 9-cell BEAT/INLINE/MISS × Raise/Maintain/Cut matrix |
| `services/earnings/nseAnnouncementsIngester.js` | NSE corporate-announcements (rolling 30d) |
| `services/earnings/nseBulkBlockIngester.js` | NSE bulk + block deals (rolling 7d) |
| `services/earnings/earningsHistoryArchive.js` | Per-day prediction snapshots for backtest |
| `services/earnings/earningsWatchService.js` | Read-side service for the API |
