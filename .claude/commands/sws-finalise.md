---
description: Score all scraped stocks, categorise, write picks-latest.json, generate PDF.
allowed-tools: Bash, Read, Write
---

> **Model note:** This command inherits the current session's model. Opus 4.7 is recommended (deeper reasoning for the categorisation pass) but Sonnet 4.6 will work fine since the heavy lifting is deterministic JS + Python. Use `/model` to switch.

# SWS Finalisation (Layer 2 + Layer 3)

Use this after all 3 shards have completed scraping. Single Opus 4.7 session.

## Steps

1. **Score & categorise:**
   ```bash
   node scripts/sws-scoring.mjs
   ```
   This reads every file in `data/sws/deep/`, scores each, builds the categorised leaderboard, and writes `data/sws/picks-latest.json`.

2. **Backfill last-quarter beat/miss on upcoming-earnings cards:**
   ```bash
   node scripts/sws-fetch-earnings-beat.mjs
   ```
   Calls Yahoo Finance `quoteSummary({modules:["earningsHistory"]})` for every ticker in the upcoming-earnings section (~200–250) at concurrency 5 and writes `last_quarter_result` (`"beat" | "miss" | "inline" | null`) back into the picks JSON. ~15 seconds. Safe to fail without aborting the rest of the pipeline — the badge simply won't render for tickers Yahoo can't resolve. Tail of the output prints `beat=N miss=N inline=N unknown=N`.

3. **Generate PDF:**
   ```bash
   python3 scripts/generate-sws-picks-pdf.py
   ```
   Writes `reports/sws-picks/Top-50-Buy-Now-{YYYY-MM-DD}.pdf`.

4. **Cleanup scheduled tasks:**
   List scheduled tasks via `mcp__scheduled-tasks__list_scheduled_tasks`. Delete any `sws-shard-*-resume` and `sws-watcher` tasks via `mcp__scheduled-tasks__update_scheduled_task` (set `enabled: false` or delete).

5. **Print summary:**
   ```
   ✅ SWS scan complete
   Scored:        {N} stocks
   Failed:        {F} (in /data/sws/failed.json — try /sws-retry-failed to re-scrape)
   Top sections:
     Best to Buy Now:        {N1}
     Deep Value:             {N2}
     Quality Growth:         {N3}
     Midterm:                {N4}
     Dividend Aristocrats:   {N5}
     Smallcap Hidden Gems:   {N6}
     Insider Buying:         {N7}
     Upcoming Earnings:      {N8}
     Avoid:                  {N9}
   PDF: reports/sws-picks/Top-50-Buy-Now-{date}.pdf
   ```
