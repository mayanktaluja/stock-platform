# SWS Deep-Scrape — Operational Runbook

Quick reference for running and maintaining the SWS Picks pipeline.

## Architecture (1-paragraph)
3 parallel Claude (Sonnet 4.6) sessions × 3 Chrome browsers, each owning 1/3 of the universe (modular partition by `index % 3`). Each scrapes overview + 7 sub-tabs per stock, parses to structured JSON, saves to `data/sws/deep/<TICKER>.json`, advances its own `progress-{1,2,3}.json`. Self-chains via scheduled tasks every ~30s (clean exit) or 15min (rate-limited). When all 3 progress files show `complete: true`, a watcher fires `/sws-finalise` (Opus 4.7) which scores, categorises, writes `picks-latest.json`, generates the PDF.

## Files
- **Code**: `scripts/sws-config.mjs`, `sws-build-universe.mjs`, `sws-parse-capture.mjs`, `sws-deep-scrape.mjs`, `sws-scoring.mjs`, `generate-sws-picks-pdf.py`
- **Slash commands**: `.claude/commands/sws-scan-shard.md`, `sws-resume-shard.md`, `sws-resume.md`, `sws-finalise.md`
- **Data**: `data/sws/universe.json`, `progress-{1,2,3}.json`, `deep/<TICKER>.json`, `picks-latest.json`, `failed.json`, `panic-stop.flag`, `refresh-requested.json`, `scan-{1,2,3}.lock`
- **Endpoints**: `/api/sws-picks`, `/api/sws-scan/status`, `/api/sws-scan/initial-start`, `/api/sws-refresh/{quick,earnings,full}`, `/api/sws-pdf/latest`
- **UI**: New "SWS Picks" tab in dashboard

## First-time setup
```bash
# 1. Build the universe from the SWS public sitemap (no login required, no
#    subscription cost). Pulls 12 paginated sitemap shards, dedups dual-listings
#    (NSE > BSE), produces ~5,440 unique India companies SWS covers.
node scripts/sws-universe-from-sitemap.mjs --dry-run    # show diff first
node scripts/sws-universe-from-sitemap.mjs --merge --reset-progress
# → universe.json: 5,440 entries (NSE 2,864 + BSE-only 2,576)
# → progress-{1,2,3}.json rebuilt from data/sws/deep/ (preserves done work)

# Legacy seed-only path (kept for reference; superseded by sitemap):
# node scripts/sws-build-universe.mjs --seed
```

### Quarterly maintenance — refresh universe from sitemap

Re-run quarterly to pick up newly-listed stocks and SWS coverage changes:

```bash
node scripts/sws-universe-from-sitemap.mjs --dry-run    # inspect diff first
# If the diff looks reasonable:
node scripts/sws-universe-from-sitemap.mjs --merge --reset-progress
```

The script is safe to re-run:
- The `--dry-run` flag never touches `universe.json`.
- A backup of pre-merge state lives at `data/sws/universe.json.pre-sitemap-backup` after first merge (manually overwrite if you want a fresh baseline).
- Already-scraped JSONs in `data/sws/deep/` are never deleted; `--reset-progress` just rebuilds the per-shard pointers to skip past what's already on disk.
- Merge categorises any "dropped" existing entries into `duplicate_of_kept` / `placeholder_search_url` / `truly_missing_from_sitemap` and writes the full list to `data/sws/universe-sitemap-dropped.json` for inspection.

This can be wired into a Cowork weekly schedule once Phase 3 lands — for now, run by hand.

## Running the initial scan (~3 days, conservative timing)

You have **two paths** — pick whichever you prefer:

### Path A: One command, walk away (recommended)

1. Open 3 Chrome windows (same profile so they share Mayank's logged-in SWS session). Verify each shows SWS dashboard with the "ST" avatar.
2. In any terminal: `caffeinate -dimsu &` (prevents Mac sleep).
3. Open ONE terminal: `claude` → `/sws-launch-all`.
4. Walk away. The command schedules 3 staggered task chains (shard 1 fires in 30s, shard 2 in 2 hrs, shard 3 in 4 hrs) plus a watcher task that fires `/sws-finalise` when all complete.
5. Monitor via the Picks tab in the dashboard.

### Path B: Manual 3-terminal control (more visibility, more clicks)

1. Open 3 Chrome windows (same as above).
2. `caffeinate -dimsu &`.
3. **Ramp-up:**
   - **T+0**: Terminal 1 → `claude` → `/sws-scan-shard 1`. Walk away for 2 hrs.
   - **T+2h**: If Picks tab status is clean (~50 stocks done, no red banner) → Terminal 2 → `claude` → `/sws-scan-shard 2`.
   - **T+4h**: If both clean → Terminal 3 → `claude` → `/sws-scan-shard 3`.
4. All 3 self-chain via scheduled tasks for ~60 hrs more.

**Either path:** When all 3 shards done, the watcher fires `/sws-finalise` automatically. PDF appears in `reports/sws-picks/`.

## On-demand refresh (after initial scan)

Click in the UI:
- **Quick refresh** (~5 hr): overview only for all stocks
- **Earnings refresh** (~15 min): only stocks with earnings in next 14 days
- **Full refresh** (~3 days): full deep refresh

Then in 3 terminals: `claude` → `/sws-resume`.

## If panic-stop fires

UI shows red banner with reason + shard + timestamp. Steps:

1. Check SWS in browser: any unread email about unusual activity? Can you load any stock page normally? Subscription still active?
2. **If everything looks normal**: likely false positive. Delete `data/sws/panic-stop.flag` and run `/sws-resume-shard {N}` for each halted shard.
3. **If anything looks off**: STOP. Don't resume. Subscription is more important than the scan.
4. Worst case: contact SWS support — paid users doing personal research are typically reinstated quickly.

## Manual recovery commands

```bash
# Inspect a shard's state
node scripts/sws-deep-scrape.mjs shard-state 1

# Check whether panic-stop is active
node scripts/sws-deep-scrape.mjs check-panic && echo "clean" || echo "PANIC-STOP ACTIVE"

# Force-release a stuck lock
node scripts/sws-deep-scrape.mjs release-lock 1

# Score what's been scraped so far (partial run)
node scripts/sws-scoring.mjs

# Inspect a single stock's score breakdown
node scripts/sws-scoring.mjs RELIANCE

# Generate PDF (after scoring)
python3 scripts/generate-sws-picks-pdf.py
```

## Path C: Playwright driver (Phase 1, no Claude in the loop)

The Playwright driver replaces the Chrome-MCP + Sonnet driver. ~10–50× faster, ~0 model tokens. Tier-2 fallback to the Chrome-MCP slash command kicks in only when selectors drift.

### One-time setup

```bash
# 1. Install Playwright + stealth deps + Anthropic SDK (for Phase 3 narrate).
npm install
npx playwright install chromium

# 2. Per-shard browser profiles. Each shard gets its own profile dir
#    (.sws-profile-{1,2,3}/, gitignored) with its own cookies. You log into
#    SWS once per profile.
for SID in 1 2 3; do
  npx playwright open --browser chromium \
    --user-data-dir=".sws-profile-${SID}" \
    https://simplywall.st/login
  # → log in, close the window, the cookies persist.
done
```

### Run a single shard

```bash
# Standard run (uses session-stock-count from HUMANISATION, ~30–60 stocks).
npm run sws:pw:1                                   # shard 1
node scripts/sws-scrape-playwright.mjs 2           # shard 2
node scripts/sws-scrape-playwright.mjs 3 --max 5   # shard 3, cap to 5 stocks

# Dry run — gates pass, prints next stock, no browser launch.
node scripts/sws-scrape-playwright.mjs 1 --max 1 --dry-run

# Ignore the IST circadian window (use sparingly — defeats anti-detection).
node scripts/sws-scrape-playwright.mjs 1 --ignore-window
```

The driver respects every existing safeguard (jittered waits, rate caps, panic-stop flag, shard lock) and adds: shuffled tab order, gaussian-jittered sleeps, per-tab humanisation (scroll + mouse), variable session length, IST circadian window, weekly rest day per shard, max-2-shards concurrency cap.

### Compare against legacy Chrome-MCP output (Phase-1 merge gate)

```bash
# Default sample of 10 well-known tickers
npm run sws:compare

# Custom ticker list
node scripts/sws-compare-playwright.mjs RELIANCE INFY TCS

# Re-diff existing snapshots without re-scraping
node scripts/sws-compare-playwright.mjs --report-only
```

Writes `data/sws/playwright-comparison/_report.md` with per-ticker exact / within-tolerance / DIVERGE counts. Tolerance is ±5% on price-like fields (price, market cap, fair value); ratios + snowflake numbers must match exactly. Exits 0 only if zero divergent fields — wire this into the Phase-1 merge check.

### Tier-2 fallback (selector drift)

When a Playwright tab parse comes back empty/null, the driver appends to `data/sws/failed.json`. Re-run those tickers via the legacy Chrome-MCP path with `/sws-scan-shard {N}` for the offending shard, OR add a new `/sws-fallback-failures` slash command that loops over `failed.json` (Phase 1.5).

`failed.json` size is the canary: if it grows fast, SWS changed their UI and the regex layer in `sws-parse-capture.mjs` needs an update.

## What the safeguards are doing for you

- **Per-stock cooldown**: 20-45s random sleep between stocks (no metronome).
- **Sub-tab waits**: 3.5-7.5s random per tab.
- **Long pause**: every 20-30 stocks, a 2-5 min "human stepped away" pause.
- **Rate cap**: hard limit of 2 stocks/min/shard, 400 stocks/day/shard.
- **Detection**: scans every page for HTTP 429, captcha text, login redirects, "rate limited" / "unusual activity" banners, anomalous slow loads.
- **Panic-stop**: ANY signal halts ALL 3 shards immediately; flag must be manually deleted to resume.
- **Account health**: every 50 stocks, navigates to dashboard and verifies still logged in.
- **Stagger**: shards started 2 hrs apart at the beginning so SWS sees gradual ramp, not 3× simultaneous load.
