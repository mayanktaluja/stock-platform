# SWS API Pipeline — humanized GraphQL/REST client

**Replaces** the DOM-based scraper (`sws-scrape-playwright.mjs`) with a much
faster path that calls SWS's GraphQL endpoint directly through an
authenticated browser context. Same fingerprint as the old scraper, same safety
hooks, ~25× faster end-to-end.

## Speedup

| Metric | Old DOM scraper | New API client |
|---|---|---|
| Per-stock | ~100s (8 tab renders) | ~1.5–3s (10 backend calls in parallel) |
| Full universe (5440 stocks) | 3+ days | ~1.5 hours |
| Refresh cadence feasibility | Weekly | Daily |
| Data richness | DOM-extracted (often partial) | Full structured JSON |

## Architecture

```
┌─────────────────────────┐
│ sws-jwt-extractor.mjs   │  Opens .sws-profile-1 briefly, captures JWT
│ (one-shot, optional)    │  + headers from a real /graphql request.
└──────────┬──────────────┘  Cached in data/sws/.jwt-cache.json.
           │
           │ (NB: the live client uses page.evaluate(), so the JWT
           │  cache is just for diagnostics/future pure-HTTP path)
           ▼
┌─────────────────────────────────────────────────────┐
│ sws-api-client.mjs                                  │
│   - launchShardContext(shardId) — same stealth as   │
│     the production scrapers                         │
│   - All fetches via page.evaluate(() => fetch()):   │
│     uses Chrome's TLS fingerprint, cookies, JWT     │
│     (Cloudflare can't tell us from real frontend)   │
│   - Per stock: 7 GraphQL ops + 5 REST endpoints     │
│     fired in parallel via Promise.allSettled        │
└──────────┬──────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│ sws-api-scrape.mjs (orchestrator)                   │
│   - Walks shard's slice of universe.json            │
│   - Per stock: 2-4s pacing + ±30% jitter            │
│   - Every 50 stocks: 30-180s burst pause            │
│   - Honors panic flag, per-minute rate cap          │
│   - On Cloudflare 403 / 429 → IMMEDIATE panic      │
│   - Output: data/sws/deep-api/<TICKER>.json (raw)   │
└──────────┬──────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│ sws-api-parser.mjs                                  │
│   Maps raw API → scoring-compatible shape           │
│   (data/sws/deep/<TICKER>.json — same fields as     │
│    the old scraper output, plus richer extras)      │
└──────────┬──────────────────────────────────────────┘
           │
           ▼
   sws-scoring.mjs → picks-latest.json
   generate-sws-picks-pdf.py → Top-50-Buy-Now-{date}.pdf
```

## Anti-block design

The client is invisible to Cloudflare for these reasons:

1. **Browser-context fetch** — `page.evaluate(() => fetch(url, ...))` runs
   inside Chrome itself. Same TLS fingerprint, same cookies, same JWT
   auto-attachment. From SWS's perspective we ARE the frontend.
2. **Stealth launch** — uses `playwright-extra` with `puppeteer-extra-plugin-stealth`
   (masks webdriver flag, etc.) via `launchShardContext`. Identical to the
   production scrapers.
3. **Pacing** — 2-4s/stock with ±30% jitter, 30-180s burst pause every 50
   stocks. Slower than absolute network capability but matches a "human
   reading research notes" cadence.
4. **Same residential IP** — no proxy rotation (which would itself look
   suspicious for an authenticated session).
5. **Honors all existing safety hooks** — panic flag, per-minute rate cap
   subcommand in `sws-deep-scrape.mjs`. A panic-stop halts ALL shards
   within the next stock check.

## Daily refresh

Scheduled task `sws-api-refresh-daily` runs at 02:00 IST every day:

```
cron: 0 2 * * * (local time)
prompt: cd .../stock-platform && bash scripts/sws-refresh-api.sh
```

Each run:
1. Acquires pipeline lock (one refresh at a time)
2. Detects already-running shards; if any, skip scrape and just refresh score+PDF
3. Otherwise: 3 parallel API shards (same alphabetical slicing as old)
4. Parses raw → scoring shape
5. Runs scoring → `picks-latest.json`
6. Optionally narrates (if `ANTHROPIC_API_KEY` set)
7. Generates PDF
8. Writes `last-refresh.json` for the dashboard

## Files & directories

| Path | Purpose |
|---|---|
| `scripts/sws-api-client.mjs` | Low-level HTTP client (browser-context fetch) |
| `scripts/sws-api-scrape.mjs` | Per-shard orchestrator |
| `scripts/sws-api-parser.mjs` | Raw API → scoring-compatible JSON |
| `scripts/sws-jwt-extractor.mjs` | One-shot JWT capture (diagnostics) |
| `scripts/sws-api-extract-queries.mjs` | Extracts GraphQL queries from research captures |
| `scripts/sws-refresh-api.sh` | Top-level refresh pipeline (replaces sws-refresh.sh) |
| `scripts/sws-stealth-context.mjs` | (existing) shared browser launcher |
| `data/sws/deep-api/<TICKER>.json` | Raw API payload per stock |
| `data/sws/deep-api-parsed/<TICKER>.json` | Parsed (scoring-compatible) shape |
| `data/sws/deep/<TICKER>.json` | Active scoring input (mirror of -parsed/) |
| `data/sws/deep.scraper-backup/` | Backup of old DOM scraper output |
| `data/sws/api-queries.json` | Extracted GraphQL operation queries |
| `data/sws/.jwt-cache.json` | (optional) JWT diagnostics cache |
| `data/sws/api-research/` | Research captures (per-ticker network logs) |
| `data/sws/progress-api-{1,2,3}.json` | Per-shard progress (separate from old `progress-N.json`) |

## Per-stock data captured

For each stock, ~12 backend calls produce structured data covering:

**GraphQL operations (7)**
- `CompanySummary` — id, score (snowflake), classification, dateGenerated, info
- `getNarrativeValuation` — analyst consensus FV (defaultNarrative.latestPublishedUpdate.valuation.fairValue)
- `CompanyNarrativesWithHistogram` — narrative edges, valuation histogram, marketCap, fiscalData (yearly time series)
- `getCompanyTimeSeries` — historical timeseries (45+ points)
- `getCompanyDividends` — dividend events with annualizedYield, dates, amounts
- `getCompanyPeers` — peer companies with their analysisValue
- `NarrativeValuationHistory` — historical fair-value valuations

**REST endpoints (5)**
- `/api/company/price/<companyId>` — daily price history (~248 points = 1 year)
- `/api/company/estimates/coverage<canonicalUrl>` — analyst broker list
- `/api/company/ownership/shareholders/<companyId>` — top 20 holders by % outstanding
- `/api/industry/company/<companyId>` — industry classification
- `/api/competitors/<companyId>` — peer + score data

## Parser output (the fields scoring reads)

```js
{
  ticker, name, sector, sws_url, parsed_at, company_id,
  overview: {
    snowflake: { valuation, future, past, financial_health, dividends,
                 value, health, dividend },  // dual aliases
    snowflake_total,
    current_price_inr, market_cap_inr, market_cap_usd, market_cap_band,
    shares_outstanding,
    fair_value_inr, fair_value_range_inr: {min, max, count},
    upside_pct,
    multiples: { pe, ps, pb, ev_ebitda },  // pe & ps computed
    rewards, risks,                        // narrative-derived (sparse)
    dividend: { yield_pct, payout_pct, recent_payments, ... },
    dividend_yield_pct,                    // legacy alias
    net_margin_pct,
    forward_earnings_growth_pct, revenue_growth_pct,
    latest_revenue, latest_net_income, latest_eps,
    most_recent_reported_date,
    returns_pct: { "1M","3M","6M","1Y","5Y" },
    next_earnings_date: null,              // not yet extracted
    last_quarter_result: null,             // not yet extracted
    insider_activity: null,                // not yet extracted
  },
  ownership: { top_holders: [...], insider_ownership_pct },
  dividend, fiscal,
  valuation, future_growth, past_performance,
  _api_raw_path: "data/sws/deep-api/<TICKER>.json"
}
```

## Known gaps (future work)

The following fields are TODO — they require either additional API captures
or text-parsing the narrative excerpts. Without them, certain scoring categories
(`upcoming_earnings`, `insider_buying`, parts of `quality_growth` and `midterm`)
will under-populate:

- `next_earnings_date` — needs separate `getEstimatesNextRelease` query
- `last_quarter_result` (beat/miss) — needs `getRevenueAndEarnings` query
- `insider_activity` (buys/sells with direction) — needs `getInsiderTransactions`
- `recent_analyst_revisions` — needs `getEstimatesRevisions`
- 5Y returns — current price endpoint only returns ~1Y

Add these incrementally by:
1. Capturing the relevant GraphQL operations via `sws-api-research.mjs`
2. Re-running `sws-api-extract-queries.mjs` to update `data/sws/api-queries.json`
3. Adding new ops to `TARGET_OPERATIONS` in `sws-api-client.mjs`
4. Adding extractors in `sws-api-parser.mjs`

Re-scoring is then offline — no re-scrape needed.

## Failure modes & recovery

| Symptom | Meaning | Recovery |
|---|---|---|
| `panic_recorded` with `kind:"blocked"` (Cloudflare 403) | SWS Cloudflare flagged us as bot | STOP. Investigate. May need to reduce parallelism or wait. |
| `panic_recorded` with `kind:"rate_limited"` (HTTP 429) | SWS rate-limited us | STOP. Wait an hour, lower `RATE_CAPS.maxStocksPerMinutePerShard` in `scripts/sws-config.mjs`, retry. |
| `halt` with `reason:"auth_expired"` | JWT in browser session expired | Re-run with fresh stealth context launch (orchestrator does this on each invocation) |
| `halt` with `reason:"browser_closed"` | Playwright browser crashed | Respawn the shard. Progress preserved. |
| `stock_failed` `kind:"graphql_error"` (search_phase_execution_exception) | SWS OpenSearch backend overloaded — sheds load briefly | Non-fatal, single stock. Retry sweep at end. |
| `stock_failed` `kind:"transient"` (Failed to fetch / 5xx) | Network blip or SWS server hiccup | Non-fatal. Retry sweep at end. |
| `stock_failed` HTTP 404 | Stale canonical URL in universe.json | Run `sws-build-universe.mjs --refresh` to refresh URLs. |

## Operational notes

- The browser-context fetch is the single most important architectural choice.
  Pure Node `fetch` to `/graphql` returns 403 (Cloudflare). Going through the
  page is what makes us indistinguishable from real SWS frontend traffic.
- 3 parallel shards at ~6 simultaneous queries each = ~18 concurrent calls
  occasionally pressure SWS's OpenSearch backend (~1.5% transient failure rate).
  This is acceptable; failed tickers can be retried at the end.
- The old DOM scraper is still present (`sws-scrape-playwright.mjs`) and the
  legacy `sws-refresh.sh` works unchanged. Use it as fallback if anything
  goes wrong with the API path.
