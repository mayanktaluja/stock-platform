<!-- code-review-graph MCP tools -->
## Multi-agent parallelism — stock-platform patterns

When the task touches multiple independent surfaces, parallelise. The most
common patterns that apply to this repo:

| Pattern | How to parallelise |
|---------|---------------------|
| **E2E audit / regression sweep** | 5 parallel discovery agents in one message: UI inventory (`gated/index.html` + `gated/app.js`), API routes (`server.js`), test coverage (`test/` + `npx playwright test --list`), prod smoke (curl `-gamma.vercel.app`), architecture (`code-review-graph` MCP). |
| **Multi-module unit-test gap-fill** | One background agent per `services/*.js` file. Each writes its own `test/<name>.test.mjs`, runs it locally, reports findings. Wire all into `npm test` in a final single commit. Files don't overlap so no race. |
| **Multi-spec e2e additions** | One agent per new `test/e2e/*.spec.mjs` if specs cover disjoint tabs. Don't parallelise across the same tab — they'll race on `gotoApp` state and the cached `_analyzerCache` / `_newsDigest` module-level globals. |
| **One-shot security fix + spec** | Foreground only — the server.js edit + its e2e spec belong in one commit and one mental model. Don't shard. |
| **Refactor inside `gated/app.js`** | Don't parallelise. The 10,562-LOC monolith means concurrent edits collide. Sequential commits per logical section. |
| **Backtest harness changes** | Don't parallelise across the 9× duplicated `scripts/backtest-*` files. They're forks of the same logic; one human edits one, then propagates manually. |

Discovery is always parallel. Implementation is parallel when files are
disjoint. Reviews always have ONE adversarial agent — never chain a second.

A worked example covering this entire playbook lives at
`~/.claude/plans/e2e-audit-2026-05-16.md` (5 discovery agents → 1
adversarial → 4 background test-writing agents in parallel with 5
foreground commits → ship).

---

## Production URL

**The platform lives at `https://stock-platform-gamma.vercel.app`** — the Vercel
alias for `mtaluja11-3604s-projects/stock-platform`. The latest deployment URL
(`stock-platform-<hash>-mtaluja11-3604s-projects.vercel.app`) is also active
but rotates per push; the `-gamma` alias is the stable canonical entry point.

`https://starbhai.com` is **NOT** this platform — it 301-redirects to
`https://www.starbhai.com` which is a separate WordPress site under the same
owner. Anyone bookmarking starbhai.com gets the wrong destination. Either
configure starbhai.com as a Vercel custom domain or use the .vercel.app URL
in all documentation and shared links.

All production tests, perf comparisons, and external links should target the
`-gamma.vercel.app` URL until the custom-domain split is resolved.

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

## Dividends to capture (Portfolio Analyzer)

Per-holding upcoming ex-dividend tracker surfaced on the Portfolio
Analyzer tab. Two surfaces share the same data:

- New collapsible section **"Dividends to capture (N)"** below the
  Upcoming Results Calendar — full table with DPS, yield on cost,
  hold-by date, ex-date, days-until, and estimated ₹ for the user's qty.
- New **"Hold by"** column on the Upcoming Results Calendar so the
  ex-dividend cutoff sits inline with the earnings result date.

### Data source — local, zero-scrape

The upcoming-dividends feed is extracted entirely from SWS deep briefs
already on disk. No new NSE network call. Verified post-deviation: NSE
`events-latest.json` carries only board-meeting *intent* (no ex/record
dates), and SWS `dividend.recent_payments[]` is fully backward-looking.
The reliable forward-looking signal lives in `data/sws/deep/*.json`
under `news[]` with `keyDevTypeId` ∈ {45, 46, 47} — templated bodies
like `"<Co> announced Annual dividend of INR X.XX per share payable on
<PayDate>, ex-date on <ExDate> and record date on <RecordDate>."`.

`services/dividends/swsDividendsExtractor.js` regex-parses those
bodies, filters to `exDate >= today`, dedups by `(symbol, exDate)`, and
returns canonical rows.

### Refresh

```bash
node scripts/refresh-dividends.mjs   # local walk over data/sws/deep/*.json
```

Writes `data/catalysts/dividends-upcoming.json`. Chained into
`scripts/sws-nightly.sh` right after `refresh-nse-corporate.mjs` (120s
timeout, non-fatal). Cookies/IP-block risk is irrelevant — no network.

### Modules

| File | Role |
|------|------|
| `services/dividends/swsDividendsExtractor.js` | Reads SWS deep `news[]` events, regex-parses DPS + exDate + recordDate + payDate from templated bodies, returns future-dated rows. |
| `services/portfolio/portfolioDividendService.js` | Joins holdings × dividend feed. Strips `.NS\|.BO\|.BSE` suffix both sides + uppercase. Multi-dividend tie-break: earliest future ex_date wins. Computes hold_by_date (ex_date − 1 calendar day), days_until_hold_by, total_payout_inr (DPS × qty), yield_on_cost_pct (DPS ÷ avg_price). |
| `scripts/refresh-dividends.mjs` | Orchestrator. Atomic write to `data/catalysts/dividends-upcoming.json`. |
| `services/swsPortfolioAggregate.js` (extended) | `buildSWSReport` now calls `attachDividendsToHoldings` before tier building, so every downstream surface (Upcoming Results Calendar column + Dividends section) sees `h.sws.next_dividend`. |
| `gated/app.js` — `renderSWSDividendCalendar` | The collapsible section renderer; mirrors the earnings calendar's `<details class="analyzer-tier-details">` pattern. Factual phrasing ("Est. ₹ for your qty", not "earn") — site-wide `#sebiSiteFooter` covers disclaimer. |

### Tests

```bash
node test/swsDividendsExtractor.test.mjs        # 32 cases including 5 verbatim SWS bodies + negative coverage
node test/portfolioDividendService.test.mjs     # 33 cases: ₹-math, tie-break, symbol normalization (M&M.NS, BAJAJ-AUTO.NS)
npx playwright test portfolio-analyzer-dividends.spec.mjs  # 3 e2e specs (factual phrasing, sort order, Hold-by column)
```

Spec is named `portfolio-analyzer-dividends.spec.mjs` (not `analyzer-dividends`)
because it MUST run after `portfolio-analyzer-fresh-banner.spec.mjs` —
alphabetical ordering matters: running the dividends spec first leaves
the shared analyzer-cache priming that breaks the banner spec's
`snapshot_at >= t0` assertion.

---

## Earnings Watch tab

A SEBI-RA-style upcoming-results dashboard with predictions, price
bands, 9-cell trading playbook, and post-result T+1 plans. Visible to
every signed-in user; the only auth requirement is the global session
gate in `server.js` (no per-route admin check on `/api/earnings/*`).

### Refresh cadence (run locally, twice daily, then commit)

```bash
node scripts/refresh-catalysts.mjs       # NSE event-calendar (already existed)
node scripts/refresh-nse-corporate.mjs   # NSE announcements + bulk/block deals
node scripts/refresh-earnings.mjs        # Build the snapshot from the above
node scripts/refresh-earnings.mjs --skip-llm   # ...or skip the LLM step (CI/offline)
```

`refresh-earnings.mjs` runs the LLM qualitative signal (predictor component 9)
between aggregation and prediction. It uses `GEMINI_API_KEY` → `GROQ_API_KEY`
→ a deterministic keyword heuristic — so it works with no keys at all, just at
lower fidelity. `--skip-llm` forces the heuristic. Results are hash-cached in
`data/catalysts/llm-signal-cache.json` (commit it — keeps steady-state runs at
near-zero LLM calls).

The `data/catalysts/` JSON files (`events-latest`, `nse-announcements-rolling`,
`nse-bulk-block-rolling`, `earnings-watch-latest`, `earnings-watch-stats`,
`llm-signal-cache`, `earnings-history/<date>.json`) all need to be committed
for Vercel to read them.

### Fundamentals history refresh (chained into sws-nightly.sh, ahead of earnings)

```bash
node scripts/refresh-fundamentals-history.mjs              # incremental, budget-capped
node scripts/refresh-fundamentals-history.mjs --dry-run    # show the plan only
node scripts/refresh-fundamentals-history.mjs --module all # force 4-call full fetch
```

Feeds the predictor's YoY-EPS-trajectory component. Universe is the curated
`stockList` ∪ current Earnings Watch symbols; NEW stocks (coverage) are fetched
before STALE ones (freshness); Yahoo calls are budget-capped (`--max-fetches`,
default 1800) with overflow deferred to the next run. This is a ~30-min Yahoo
job — **chained into `scripts/sws-nightly.sh` immediately before `refresh-
earnings.mjs`** behind an 18h freshness gate (sws-nightly.sh:460-515), so the
predictor always reads a fresh trajectory file. Previously a standalone 04:00
IST launchd job (`com.starbhai.sws-fundamentals-history`, wrapper
`scripts/sws-fundamentals-history-nightly.sh`, plist
`scripts/com.starbhai.sws-fundamentals-history.plist`) — that job is dormant
after silently exiting 127 for 23 days when its script path moved. Never on a
Vercel cron. `refresh-earnings.mjs` still logs a warning if
`fundamentalsHistory.json` goes >7 days stale as defence-in-depth. Manual
corrections go in `data/fundamentals-history-overrides.json` (reapplied after
every refresh).

### Resolving actuals (run locally, then commit)

```bash
node scripts/resolve-earnings-actuals.mjs            # SWS news → Yahoo fallback
node scripts/resolve-earnings-actuals.mjs --dry-run  # preview, no writes
node scripts/resolve-earnings-actuals.mjs --re-resolve  # re-check ≤90d for restatements
```

Fills the `actual_verdict` / `actual_t1_close_inr` / `actual_source` fields on
archived predictions so the backtest harness can score the predictor. SWS news
briefs (`data/sws/deep/<TICKER>.json:news[]`) are the primary source — zero
network cost, full universe; Yahoo `earningsHistory` is the fallback for stocks
SWS hasn't briefed yet. Both are keyed to the fiscal-quarter end (parsed from
`fiscal_quarter`), not the NSE event date, to dodge IST/EST off-by-one bugs.
Runs locally; commit the updated `earnings-history/<date>.json` files.

`scripts/migrate-earnings-history-schema.mjs` is a one-shot v1→v2 stamper —
already applied; only needed if a pre-v2 history file resurfaces.

### Backtest

```bash
node scripts/backtest-earnings-predictions.mjs  # human-readable
node scripts/backtest-earnings-predictions.mjs --json  # machine-readable
```

Reports overall hit-rate, hit-rate-by-confidence-bucket, Brier score,
and the V1 confidence-cap-lift gate (≥30 resolved + ≥55% bucket hit-rate +
Brier <0.20). Predictions are deduped by `(symbol, event_iso_date)` across
daily snapshots and bucketed by `predictor_version` — the cap-lift gate is
computed over the latest version only, never a cross-version average. Metrics
stay zero until `scripts/resolve-earnings-actuals.mjs` populates `actual_*`.

### Weight tuning

```bash
node scripts/tune-earnings-weights.mjs        # human-readable
node scripts/tune-earnings-weights.mjs --json # machine-readable
```

Re-scores resolved archived predictions under candidate component-weight
MULTIPLIER configs (off the v4-archived `score_breakdown`) and ranks them by
hit-rate with a held-out 20% check. It NEVER edits `earningsPredictor.js` — it
recommends directional shifts a human applies by hand, with
`data/catalysts/predictor-weights-v1.json` as the rollback anchor. It refuses
to recommend anything until the validation gate clears: ≥80 resolved rows with
`score_breakdown`, across ≥2 fiscal quarters, with ≥5 sectors carrying ≥10
events each. Until then it just writes `earnings-weight-tuning.json` with
`gate_met: false` — that's expected (the gate won't clear for months).

### Health summary (run last in the nightly chain)

```bash
node scripts/earnings-health-summary.mjs        # human-readable
node scripts/earnings-health-summary.mjs --json # machine-readable
```

Rolls the whole pipeline's observable state into `data/catalysts/earnings-
health.json`: deduped resolved-actuals count + delta, LLM provider split,
cap-lift-gate state + days-in-state, archive-schema distribution, predictor-
version mix, restatements, and an `alerts` array (mixed schema, all-heuristic
LLM, dropped resolved count, gate-just-cleared…). If `SLACK_WEBHOOK_URL` is set
it also posts a one-liner; absent the env var it just writes the JSON. Run it
after the backtest so a silent failure in any stage surfaces.

### Modules

> **V3→V4 naming note (#437).** The SWS composite score is now **V4**
> (`services/swsScoringV4.js`); V3 is deleted. The earnings bus deliberately
> kept the legacy `signals.v3.*`, `v3SignalAdapter.js`, `loadV3UniverseStats.js`,
> and `v3-universe-stats.json` names as **V4-carrying aliases** — they are
> load-bearing, not dead code. **Don't blind find-replace `v3`→`v4`.**
> `PREDICTOR_VERSION` likewise still reads `earnings-predict-v3-2026-05` even
> though it runs on V4 inputs. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8.

| File | Role |
|------|------|
| `services/earnings/earningsCalendarBuilder.js` | NSE event-calendar → calendar rows |
| `services/earnings/signalAggregator.js` | Joins SWS deep + V4 breakdown (via the legacy `signals.v3` bus alias) + history + sector + announcements + deals |
| `services/earnings/v3SignalAdapter.js` | Resolves the SWS **V4** 100-pt composite — reads `v4_breakdown`/`v4_score_100`, returns them under the legacy `v3_*` keys. (`computeV3Score` is deleted; it imports `computeV4Score`/`verdictV4FromScore`.) |
| `services/earnings/loadV3UniverseStats.js` | Loads `data/sws/v3-universe-stats.json` (filename unchanged) for momentum percentiles only — V4 verdicts are absolute cutoffs, no runtime band lookup |
| `services/earnings/earningsPredictor.js` | component scorer (3 V4 pillars: future/past + valuation + risk overlay; then runup + sector + trajectory + echo + announcements + deals + missing-data penalty + LLM signal) → BEAT/INLINE/MISS + confidence |
| `services/earnings/earningsLlmSignal.js` | LLM qualitative classifier — Gemini → Groq → heuristic (Gemini-first since 2026-05-17), never throws |
| `services/earnings/earningsLlmBatcher.js` | Batches the LLM signal across the calendar, hash-cached in `data/catalysts/llm-signal-cache.json` |
| `services/earnings/llmPromptHardener.js` | Prompt-injection defence — sanitises + delimiter-wraps untrusted SWS news bodies |
| `services/earnings/priceBandBuilder.js` | Bull/Base/Bear (capped ±15%) |
| `services/earnings/earningsRationaleNarrator.js` | 3-paragraph deterministic rationale |
| `services/earnings/reactionPlaybook.js` | 9-cell BEAT/INLINE/MISS × Raise/Maintain/Cut matrix |
| `services/earnings/nseAnnouncementsIngester.js` | NSE corporate-announcements (rolling 30d) |
| `services/earnings/nseBulkBlockIngester.js` | NSE bulk + block deals (rolling 7d) |
| `services/earnings/earningsHistoryArchive.js` | Per-day prediction snapshots + dedup/calibration for backtest |
| `services/earnings/actualsIngester.js` | Post-result `actual_*` resolution (SWS news brief + Yahoo fallback) |
| `services/earnings/weightTuner.js` | Multiplier-sweep logic for data-tuning predictor weights (gated on resolved actuals) |
| `services/earnings/earningsHealth.js` | Pure aggregator for the daily pipeline health summary + alert rules |
| `services/earnings/earningsWatchService.js` | Read-side service for the API |
