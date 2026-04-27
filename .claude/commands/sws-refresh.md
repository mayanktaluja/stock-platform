---
description: Run one pass of the SWS pipeline (scrape → score → narrate → PDF). Usage: /sws-refresh {quick|earnings|full}
allowed-tools: Bash
---

# /sws-refresh — drive the SWS pipeline (one pass)

Fires `scripts/sws-refresh.sh` with the requested mode and tails the output back to this session.

## What this does

1. Acquires the global pipeline lock (refuses if another refresh is already running).
2. Spawns 3 Playwright shards in parallel with a 20 s stagger.
3. Waits for all 3 shards to exit (~10–15 min per pass; each scrapes ~30–60 stocks).
4. Re-runs scoring (`sws-scoring.mjs`) on whatever's been scraped to date.
5. Runs narration via Sonnet 4.6 (top ~50 picks) — skipped if `ANTHROPIC_API_KEY` isn't set.
6. Regenerates the PDF (`generate-sws-picks-pdf.py`).
7. Writes `data/sws/last-refresh.json` for the dashboard.

## Mode reference

| Mode       | Tabs scraped | Scope                                       | Wall-clock per full sweep |
|------------|--------------|---------------------------------------------|---------------------------|
| `quick`    | overview     | all ~5,440                                  | ~3-5 hrs (many passes)    |
| `earnings` | overview     | stocks with `next_earnings_date` ≤14 days   | ~10-15 min                |
| `full`     | all 8 tabs   | all ~5,440                                  | ~24-30 hrs (many passes)  |

## Usage

Argument: `$ARGUMENTS`. Default mode is `full` if omitted.

Run:

```bash
cd ~/Desktop/claude/stock-platform && ./scripts/sws-refresh.sh ${ARGUMENTS:-full}
```

After the script exits, surface a one-line summary from `data/sws/last-refresh.json` (mode, scored_count, shards_failed, duration).

If exit code is 3 (`panic-stop` set), DO NOT clear the flag automatically — surface the contents of `data/sws/panic-stop.flag` to the user and ask whether to resume.
