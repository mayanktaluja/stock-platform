---
description: Run the API-based SWS refresh pipeline (~25× faster than the DOM scraper). Usage: /sws-refresh-api
allowed-tools: Bash
---

# /sws-refresh-api — drive the API-based SWS pipeline

Fires `scripts/sws-refresh-api.sh` and tails the output back to this session.

## What this does

1. Acquires the global pipeline lock (refuses if another refresh is already running).
2. Spawns 3 parallel API shards via `sws-api-scrape.mjs` (15 s stagger).
3. Waits for all 3 shards to exit (~1-2 hrs for full universe, much faster than DOM scraper).
4. Parses raw API output (`sws-api-parser.mjs`) → scoring-compatible JSON in `data/sws/deep/`.
5. Runs scoring (`sws-scoring.mjs`).
6. Runs narration via Sonnet 4.6 (top ~50 picks) — skipped if `ANTHROPIC_API_KEY` isn't set.
7. Regenerates the PDF (`generate-sws-picks-pdf.py`).
8. Writes `data/sws/last-refresh.json` for the dashboard.

## How it differs from `/sws-refresh`

| | `/sws-refresh` (legacy) | `/sws-refresh-api` (new) |
|---|---|---|
| Scrape mechanism | Playwright DOM scrape, 8 tab renders/stock | GraphQL/REST via authenticated browser context, 12 parallel calls/stock |
| Per-stock cost | ~100 s | ~1.5–3 s |
| Full universe (5440) | 3+ days | ~1.5 hours |
| Failure rate | ~5–10% (DOM brittleness) | ~1.5% (mostly transient backend pressure) |
| Output richness | Partial (many fields null) | Full structured JSON |
| Anti-block | Stealth Playwright, panic on "suspended" text | Same fingerprint + browser-context fetch (Cloudflare-invisible) |

## Usage

```
/sws-refresh-api
```

No arguments — always full universe. For incremental updates, the daily cron handles it.

## Schedule

A daily run is already scheduled at 02:00 IST via the `sws-api-refresh-daily` task.

## Failure modes

| Symptom | Action |
|---|---|
| Exit 3 — panic flag set | Inspect `data/sws/panic-stop.flag`, then delete to resume. Never auto-clear. |
| Exit 4 — panic during scrape | Same. Look at `data/sws/refresh-api-shard-{1,2,3}.log` for the trigger. |
| Cloudflare 403 / 429 in logs | Stop. Reduce `SWS_API_DAILY_CAP`. Wait 1+ hour before retry. |
| `search_phase_execution_exception` in failed-stocks | SWS OpenSearch backend overload. Non-fatal. Will recover. |

## Run

```bash
SWS_API_DAILY_CAP=${SWS_API_DAILY_CAP:-3000} bash scripts/sws-refresh-api.sh
```
