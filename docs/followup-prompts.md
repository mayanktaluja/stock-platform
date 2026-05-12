# Follow-up prompts — paste-ready Claude sessions

Each block below is a self-contained prompt for the listed feature/fix. Copy a single block into a fresh Claude session at the project root (`/Users/mayanktaluja/Desktop/claude/stock-platform`) and Claude will have enough context to act without re-reading the original audit report.

The prompts are ordered by **value-for-effort** as I'd judge them — pick from the top.

---

## 1.2 — Stale `upcoming_earnings` filter (deferred from Phase 1)

```
Today the SWS Picks "📅 Upcoming Earnings (next 30 days)" section displays
events whose date is already in the past. The filter `days >= 0 && days <= 30`
runs once at scoring time inside `services/swsScoring.js::categoriseStock`,
and the results get baked into `data/sws/picks-latest.json`. When the cache
ages a couple of days, every event dated 1–2 days ago still shows up under
"upcoming."

Audit found 31 of 242 names dated `2026-05-04` (yesterday) on a 15h-old
snapshot. SOBHA, JSL, GODREJPROP all surfaced as "upcoming" despite already
having reported.

Implement the fix in two layers:

1. Re-filter at request time inside `server.js:/api/sws-picks` (around the
   block that already augments rows with `nifty500`/`composite_verdict`).
   Drop any `upcoming_earnings` row whose `next_earnings_date` is more than
   1 calendar day in the past (so a same-day report after market close
   still shows). The `days_until` field already exists on each row.

2. Tighten the offline filter in `services/swsScoring.js::buildLeaderboard`
   so the next pipeline run stops emitting past dates entirely. Same calc
   `Math.ceil((new Date(d) - new Date()) / 86400000) >= 0`.

Verify with `curl /api/sws-picks | jq '.sections.upcoming_earnings | map(.next_earnings_date) | unique[:5]'` —
no dates earlier than today.

Also add a unit test under `test/swsCategorise.test.mjs` covering: row dated
yesterday → dropped; row dated today → kept; row dated 31 days from now →
dropped.
```

---

## 2.10 — Live-price overlay on `/api/sws-picks`

```
SWS picks render with prices baked into the cached `picks-latest.json`. The
`scanned_at` stamp is typically 12-24 hours old, so `current_price_inr` is
yesterday's price overlaid on today's market. `upside_pct` rendered on the
card is computed from this stale price + a stale FV, so the user sees a
subtly wrong DISCOUNT/PREMIUM chip during the trading day.

Fix at the response boundary inside `server.js:/api/sws-picks`. For every
row in every section, look up the latest cached NSE quote (NSE/Yahoo via the
existing `fetchQuote(symbol)` helper used by `/api/portfolio`). If a fresher
price is available, recompute:
- `current_price_inr` → live close
- `upside_pct` → `((fair_value_inr - current_price) / current_price) * 100`
- `valuation_band` → run through `valuationBandFromUpside()` from
  `services/swsScoring.js`

Constraints:
- Hot path: 800+ rows can't all wait on Yahoo. Batch the lookup against the
  `fetchQuote` cache only — if the cache is cold for a ticker, leave the
  baked price untouched (don't fan out to Yahoo on a tab open).
- Tag overlaid rows with `live_price: true` so the UI can show a tiny "live"
  dot on the price.
- Never override when the deep-scrape FV is null/imputed — the upside_pct
  in those cases is reconciled separately.

Test: open SWS Picks during market hours, check that `STAR.NS`'s
current_price_inr matches `/api/stock/STAR.NS` to within ₹1.
```

---

## 2.9 — Production fundamentals staleness banner + cron monitoring

```
The Fundamental Value Scanner reads `fundamentals.json` whose
`snapshotGeneratedAt` was 11 days stale on the local devbox during the
audit. Production has the daily cron `/api/cron/enrich-fundamentals` (Mon-Fri
13:00 UTC, see vercel.json), but if the cron silently fails the page would
keep showing stale data without flagging it.

Two changes needed:

1. **Frontend banner** in `gated/app.js`. Wherever the Fundamental Scanner
   renders its existing `fundSnapshotAge` span (look for `loadFundCategory`
   around line 2952), if `snapshotGeneratedAt` is more than 2 calendar days
   old, render an amber warning banner above the section: "Fundamentals
   snapshot is X days old — values may be out of sync with today's market."
   Re-use the `.macro-banner.severity-degraded` style added in PR 1.1.

2. **Backend health check** at `/api/cron/health` (new). Returns:
   - last successful enrich-fundamentals run (read from
     `fundamentals.json::snapshotGeneratedAt` + `snapshotEnrichedAt`)
   - SWS scrape last_refresh.json `finished_at`
   - per-cron pass/fail history (read Vercel logs if practical, otherwise
     persist a small `data/cron-history.json` from each successful cron
     handler at end of run)
   - Returns 200 + JSON when everything is fresh; 503 when any cron is
     stale beyond its expected interval (24h for fundamentals, 26h for SWS).

Add this endpoint to vercel.json's cron list as a daily ping at 13:30 UTC
so a Vercel monitor can be subscribed to its 503s.

Test the banner locally: `touch -d '5 days ago' fundamentals.json` (or
manually edit `snapshotGeneratedAt` in the file), reload — banner shows.
```

---

## 3.5 — Sector-cap guardrails block, not warn

```
The portfolio analyzer computes `sectorOverlay` (per-sector concentration,
top-3 sectors, etc.) but doesn't act on the result. Today the test portfolio
shows Capital Goods at 14.2% and the engine still recommends `SUZLON
Top-up-100%` (Capital Goods) — pushing the sector to ~16%.

In `services/swsHoldingEngine.js::scoreBandAction` the sector-weight ceiling
is `25%` for Top-up-modest. Tighten the ladder so Top-up rungs *block* when
the post-trade sector weight would exceed `15%`:

- New input: `sectorWeightAfter = sector_weight + (suggested_inr /
  totalCurrent) * 100`. The suggested_inr per Top-up rung is computed in
  `services/swsPortfolioAggregate.js::buildBaskets` already; pass it through
  to `scoreBandAction` as `proposed_sector_weight_after`.
- If `proposed_sector_weight_after > 15`: down-shift Top-up-100% → Top-up-50%,
  Top-up-50% → Top-up-25%, Top-up-25% → HOLD. Add a reason: "Sector cap
  protection: position would push <sector> to X% (cap 15%)."
- If `> 20`: hard-block to HOLD regardless of rung.

Also surface the cap as a row in the `sectorOverlay` UI panel: each sector
row gets a small chip "← cap 15%" so the user understands the gate.

New test: `test/sectorCap.test.mjs` covering:
- pw=2%, sw=14% on a Top-up-50% recommendation → down-shift to Top-up-25%
- pw=2%, sw=18% on the same → block to HOLD
- pw=2%, sw=10% → unchanged (below cap)
```

---

## 3.4 — Cross-check pillar disagreements demote conviction

```
The portfolio analyzer already computes `crosscheck.pillar_comparison` (5-
pillar agreement matrix between SWS and the independent fundamentalsV2
model). It's rendered in the modal but never demotes a recommendation. On
the test portfolio, 35/38 holdings show OVERVALUED yet the engine still
proposes 20 top-ups — the divergence is invisible to the action engine.

Wire the crosscheck output into the conviction band. In
`services/swsConvictionEngine.js::computeRecommendationV2`:

- Today `crosscheck.confidence_delta` is summed into netDelta. That's a
  single number summary; replace with the pillar-by-pillar matrix:
  - For each pillar, mark "AGREE" if `|delta| <= 15`, else "DISAGREE".
  - Count DISAGREEs. ≥3 of 5 disagreeing → tag the recommendation
    `conviction = "MIXED"` (insert below MEDIUM-LOW in the band ladder).
  - When `MIXED` fires AND the resolved action is bullish (Top-up family)
    AND the disagreement direction is `indep_more_bearish`, soften the
    action one rung toward HOLD.

The narrator (`buildReasonNarrative`) already takes the agreement map; add
a new sentence to the narrative when MIXED fires: "Independent crosscheck
disagrees on Future / Past / Dividends — softening to <action>."

UI: render a "MIXED" chip on the action badge alongside MEDIUM-HIGH etc.

Test: `test/crosscheckMixed.test.mjs` covering:
- crosscheck pillar deltas all <15 → conviction unchanged
- 3/5 deltas with |delta|>15 → MIXED tag set
- MIXED + Top-up-modest + indep_more_bearish → action drops to HOLD
```

---

## 3.6 — Live-news red-flag chip on every pick card

```
`/api/news/market` is healthy and returns articles with sentiment
(bullish/bearish/neutral). Articles aren't tagged to specific tickers
today, so the SWS picks tab can't surface "BEL has 2 negative articles in
last 24h."

Build a per-ticker news rollup:

1. New endpoint `/api/news/by-ticker` that:
   - Reads `/api/news/market` (existing rollup) plus optionally Yahoo's
     per-ticker news endpoint when called for a specific symbol.
   - Tags articles to tickers via:
     - direct mention in title (regex `\bSYMBOL\b` or full company name from
       stockList.js)
     - any company-name match against `data/sws/universe.json::name`
   - Returns a map `{ TICKER: { neg: N, pos: N, articles_24h: [...] } }`
     cached for 15 minutes.

2. In `services/swsScoring.js::pickCardFields`, add a field
   `news_flag_24h: { neg, pos }` populated from a passed-in news map.

3. Frontend `gated/app.js::renderPickCard`: when `news_flag_24h.neg >=
   2`, render a small red chip "📰 −2" next to the ticker. When
   `pos >= 2 && neg === 0`, render a green chip "📰 +2". Otherwise nothing.

4. The chip is tappable — opens a side drawer listing the matched headlines
   inline (re-use existing modal pattern).

Test: `test/newsFlag.test.mjs` mocking the news endpoint with 3 negative
articles tagged to `BEL`, asserting `news_flag_24h.neg === 3`.
```

---

## 3.7 — Pre-earnings 5-session suspension

```
The platform has both `upcoming_earnings` (242 names with earnings in next
30 days) and an action engine that emits Buy/Top-up calls. Today there's
no coupling: the engine will recommend a fresh entry on a stock that
reports earnings tomorrow, which is a binary-event coin flip, not a
fundamentals decision.

Add a pre-earnings shield in the engine.

In `services/swsHoldingEngine.js::scoreBandAction`, after the existing
upside/risks gates fire:

```js
const daysToEarnings = scored.overview?.next_earnings_date
  ? Math.ceil((new Date(scored.overview.next_earnings_date + 'T00:00:00Z') - now) / 86400000)
  : null;
if (daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 5) {
  // Buy-side actions: down-shift one rung; STRONG Top-up → Top-up-modest;
  // Top-up-modest → HOLD. Trim/exit actions pass through unchanged.
  if (action.startsWith('Top-up') || action === 'STRONG Top-up') {
    return { action: softenTowardHold(action), band, pre_earnings_shield: true };
  }
}
```

Also surface in `services/swsPortfolioAggregate.js::surfaceOutsidePicks`:
exclude any fresh pick whose `next_earnings_date` is within 5 sessions.

UI: card-level chip "📅 Earnings in Nd — pause new entries" on the card
when this shield fires.

Test: `test/preEarningsShield.test.mjs`:
- earnings = today + 3 days, action = Top-up-100% → softens to Top-up-50%
- earnings = today + 7 days → no change
- earnings = today + 3 days, action = Reduction-50% → no change
```

---

## 3.8 — Outside-picks entry-zone ladder

```
The Tier B basket today says "buy SUZLON ₹16,250" — flat suggestion at
market. Add a per-pick entry zone derived from ATR + recent technical
pivots, the same primitives the Mid-term tab already uses.

In `services/swsPortfolioAggregate.js::pickToBasketRow` (around line 200),
extend the row with:

```js
const technicals = await loadTechnicals(pick.ticker); // wraps fetchAtrAndPivot
row.entry_zone = {
  buy_at: technicals.support_pivot,            // recent swing low
  buy_above: technicals.entry_trigger,          // close > 20-DMA
  stop_loss: technicals.atr_stop,               // entry - 2*ATR
  target: technicals.fibonacci_target,          // 1.5R from entry
  reasoning: 'Buy on retest of ₹X (support); stop ₹Y (-2 ATR); target ₹Z (1.5R).',
};
```

The Mid-term tab already has `getMidtermAnalysis(symbol)` in
`analysis.js` — reuse it. Don't add a new technical helper.

UI: render the entry zone inline in the basket card, replacing the bare
"Suggested ₹X" line:

```
Buy ₹820–840  ·  SL ₹775  ·  Target ₹925  ·  R:R 1.5x
```

Test: hit `/api/portfolio/analyze` with a portfolio + fresh capital, verify
every Tier B row has `entry_zone` populated and `entry_zone.buy_at <
entry_zone.target`.
```

---

## 3.1 — Live conviction-flip alerts

```
The platform already tracks per-day SWS picks via `paperTradesStorage.js`
+ `data/audit/`. A natural extension: detect when a holding's
recommendation flipped between consecutive runs and surface it.

`services/analyzerDiff.js` already computes since-last-run action diffs for
the analyzer (see test/analyzerDiff.test.mjs). Build the same primitive at
the SWS-Picks level:

1. `services/picksHistory.js` (new): each call to /api/sws-picks writes a
   small append-only `data/sws/picks-history.jsonl` line `{date_key, ticker,
   sections, v3_score, valuation_band}` per ticker.

2. New endpoint `/api/picks/changed-today` returns rows whose
   `composite_verdict` or `valuation_band` flipped vs yesterday's snapshot
   (TOP_PICK → STRONG, FAIR → PREMIUM, etc.). Default window: 1 day; query
   string `?window=7d` for 7-day window.

3. Frontend banner on the SWS Picks tab top: "12 picks flipped conviction
   today (5 upgrades, 7 downgrades)" with a click-through to a dedicated
   list view.

4. Email digest: optional opt-in via the `STARBHAI_DIGEST_EMAIL` env var.
   At 09:30 IST every weekday, send the top 20 flipped names with their
   old/new conviction bands.

Test: `test/picksHistory.test.mjs` covering append + diff against a fixture
representing two consecutive days.
```

---

## 3.2 — Per-section "what changed" history

```
Same primitive as 3.1 but at section-membership level. Today the user
can't tell whether a stock recently entered or left a pick section.

Extend `services/picksHistory.js` (from 3.1) to track section membership:

- Per-day record: `{date_key, ticker, sections_in: ['top_30','deep_value']}`
- Diff vs yesterday: produce 3 lists per section: `entered`, `left`,
  `unchanged`.

UI: under each section header in SWS Picks, add a tiny "+5 / −2 since
yesterday" indicator. Hover/click expands to show the names.

Backend: cache per-day section snapshots so the diff is cheap on every
tab open. Reuse the SWS picks cache key.

Test: fixture with two days of picks-latest.json showing 3 entries to
deep_value + 1 exit; assert the diff produces the right entered/left lists.
```

---

## 3.3 — Portfolio analyzer "second-opinion" 3-column view

```
The analyzer's per-holding row collapses three signals (SWS verdict, v3
score, technical signal) into one Tier label. The detail expand shows them
but the relationship isn't visible at a glance, so the user has to keep
clicking to understand why an action was emitted.

Refactor the per-row expand into a 3-column grid:

| SWS verdict          | Composite (v3)        | Technical            |
|----------------------|-----------------------|----------------------|
| OVERVALUED · -5% FV  | TOP_PICK · 70/100     | UPTREND · MACD bull  |
| (price-vs-FV)        | (multi-factor)         | (live tech engine)   |

The data is already in the API response (sws.verdict, sws.v3_score,
liveOverlay.technicals from /api/sws-stock). Render side-by-side with a
clear "Agreement: 2/3" badge at the bottom (count of bullish vs bearish
columns).

When all 3 agree bullish → green outline on the row.
When 2/3 agree bullish → amber.
When ≤1/3 agree bullish → red.

The action emitted by the engine sits below the columns with the engine's
own reasoning paragraph.

Existing files to modify:
- `gated/app.js::renderHoldingRow` (the analyzer's per-stock row)
- CSS for `.analyzer-3col` in `gated/index.html`

Test: render with a portfolio holding that has SWS=OVERVALUED but
technical=UPTREND — verify the agreement badge says "1/3 bullish" and the
row outline is amber, not green.
```

---

## 3.11 — Conviction band age-decay

```
The combined score doesn't decay if the underlying SWS data is more than
24h old. A 7-day-old reading is treated identically to a fresh one, so the
user can be acting on stale conviction.

In `services/swsHoldingEngine.js`, after the v3 score is loaded, compute
an `age_penalty`:

```js
const ageMs = Date.now() - new Date(scored.parsed_at).getTime();
const ageDays = ageMs / 86400000;
const agePenalty =
  ageDays <= 2 ? 0 :
  ageDays <= 7 ? -3 :
  ageDays <= 14 ? -6 : -10;
const adjustedV3 = Math.max(0, scored.v3_score_100 + agePenalty);
```

Apply `adjustedV3` to the band-action lookup, surveillance gates, and
conviction band selection. Surface the penalty in the modal:
"v3 70 (raw) − 6 age (12d old) → effective 64".

When age > 14 days, also tag `data_freshness_at` red on the card.

Test: synthesize two stocks with identical raw v3 but parsed_at 1 day vs
12 days ago — verify the adjusted v3 differs by 6 and the action shifts
by one rung.
```

---

## 3.12 — Per-scanner reliability badge

```
The Track Record tab shows that Buy-Now-Nifty100 hits 51.3% beat-Nifty
(barely above coin-flip) while Small-Cap-Buy-Now hits 72.4%. These are
buried inside the Track Record tab — users can't see them on the scanner
they're actually using.

Surface a per-scanner reliability badge on the scanner header. When the
user opens the Buy Now scanner, show under the section title:

```
Last 6mo: 53% beats-Nifty · +1.3% avg α · n=125 · proceed with caution
```

For scanners with >60% beats-Nifty:
```
Last 6mo: 72% beats-Nifty · +6.5% avg α · n=98 · trustworthy signal
```

Source: `/api/track/stats` already returns `byType` aggregates. New helper:
`services/scannerReliability.js` that computes beat-rate over a configurable
window (default 6mo) per scanner type.

Endpoint `/api/scanner-reliability` returns a map keyed by scanner type
with `beats_nifty_pct`, `avg_return_pct`, `avg_alpha_pct`, `sample_size`,
`assessment: "trustworthy" | "neutral" | "caution"`.

UI: render the badge in `gated/app.js` next to each scanner's section
header.

Test: feed fixture trade history with 60% beat rate → assessment ===
"trustworthy"; with 45% → "caution".
```

---

## 2.8 — Track-record diagnosis: why Buy Now Nifty100 = 51%

```
The Buy Now Nifty100 scanner produces ~3 picks/day from a 98-stock universe
and the track record shows only 51.3% beat-Nifty over n=125 picks. That's
worse than coin-flip after the platform's own filtering.

Run a diagnostic study:

1. Query `/api/track/history?type=buynow_nifty100&limit=200` and group by:
   - Macro regime at snapshot (CALM vs OIL_SHOCK vs WAR_DE_ESCALATION etc.)
   - Score band at snapshot (60-65 vs 65-70 vs 70+)
   - Verdict at snapshot (BUY vs WEAK BUY)
   - Sector

2. For each cell, compute: beat rate, avg α, sample size.

3. Identify the failure mode:
   - Are the failures concentrated in WEAK BUY entries?
   - Does CALM-regime picks beat-rate diverge from OIL_SHOCK picks?
   - Is one sector (e.g. Banking) dragging the avg down?

4. Write findings to `docs/buynow-diagnosis.md` with concrete proposals:
   - Possibly raise the entry score threshold from 65 to 68
   - Possibly drop "WEAK BUY" verdict from the surfacing
   - Possibly require trend ≠ Downtrend (today HEROMOTOCO with Downtrend
     was in BuyNow despite the trend conflict)

5. Proposals → backed by the data, not gut feel. Cite the cell sizes.

Don't code the fix yet — produce the diagnostic doc and a single bullet
per recommendation with its expected new beat-rate.
```

---

## Quick wins — small standalone improvements

```
A grab-bag of small fixes worth bundling into one PR. Each takes 5-30
minutes:

1. **Add a separate `midcap_gems` section** for ₹15K cr ≤ mcap < ₹50K cr.
   In services/swsScoring.js + scripts/sws-scoring.mjs::categoriseStock.
   Same gates as smallcap_gems (snowflake ≥ 22, upside ≥ 15) but a
   different mcap window. Add to the API output sections. Add to
   PICKS_SECTIONS in gated/app.js. Subtitle: "Mid-cap quality:
   mcap ₹15-50K cr (rank ~150-250)".

2. **Hide `midcap_gems` and any future bucket when empty** by allowlisting
   them in the same "hide-when-empty" pattern from PR 1.5.

3. **`/api/sws-stock/:ticker` should also accept symbols ending in `.NS`** —
   strip the suffix and proceed. Today `STAR.NS` returns invalid_ticker
   while `STAR` works. Frustrating when copying from the Buy Now scanner
   where symbols carry the suffix.

4. **Add `valuation_band` to `/api/scan/buynow` response** rows. Same
   helper from PR 2.3 — `valuationBandFromUpside(upside_pct)`. Right now
   the buynow scanner uses the legacy combined-score verdict but the new
   valuation_band would be a clearer second signal here too.

5. **Preserve modal scroll position on tab switch.** Currently if the user
   opens a modal, scrolls down, and clicks a tab in the chip-nav, the modal
   re-renders at top. The diff is `swsModalBody.scrollTop` should be saved
   on close and restored on open of the same ticker.

6. **Show "scored on demand" pill** when `card.computed_on_demand === true`
   in the modal. Today the pill is missing — users can't tell if a ticker
   came from picks-latest.json or was scored at request time.

7. **Add `In sections` banner to Portfolio Analyzer holding rows** too —
   the section_memberships endpoint is already wired, just call it for
   each holding's expanded view.
```

---

## Workflow tip when starting a new session

When you copy one of these prompts, also tell Claude:

> Check the recent commits on this branch first (`git log --oneline -20`)
> so you don't re-implement work that landed in PRs 1.1-2.11. The plan
> file at `~/.claude/plans/moonlit-mixing-flame.md` documents what shipped
> in that wave.

Otherwise Claude may re-discover already-fixed problems and waste tokens
re-exploring the codebase.

---

## New findings — 2026-05-12 QA pass

See [qa-pass-2026-05-12.md](qa-pass-2026-05-12.md) for the full pass. Three
fixes shipped (admin-gate-on-shadow-diff, .NS-suffix-on-sws-stock, modal-
scroll-memory). The items below were observed but deferred.

### N.1 — `/api/track/stats` is 460× slower in prod than local

```
On the 2026-05-12 perf sweep, /api/track/stats took p50 919ms in prod vs
2ms locally. The endpoint returns a tiny 338-byte response but the handler
seems to scan all snapshots from KV on every request. Local is fast only
because the trade log is empty.

Investigate the handler in services/trackRecord/* + server.js:3834. Cache
the aggregate (windowed: 30d / 90d / 1y / all) inside the
/api/cron/snapshot-track-record cron run and store a single
`track_stats_aggregate` KV key. The /api/track/stats handler should then
be a single KV.get() not a scan.

Verify: after the change, /api/track/stats in prod p50 < 100ms.
```

### N.2 — Local Express doesn't gzip; prod parity gap

```
The local express server doesn't compress static assets — local
app.js downloads as 530KB vs 124KB on prod (Vercel auto-gzips).
This makes local dev network-tab inspection misleading, and any
"this is slow on prod!" suspicion is poisoned by the asymmetry.

Add the `compression` middleware (already common in express apps):

  import compression from "compression";
  app.use(compression());

Add `compression` to package.json deps. Test that smoke + tests
still pass. No-op in prod (Vercel does its own compression on the
edge), but local parity is restored.
```

### N.3 — Admin-tab hardening is inconsistent between Users and Earnings

```
gated/earnings.js:1018 actively REMOVES the earningsTabBtn from
the DOM whenever window.__starbhai_isAdmin !== true. gated/app.js
only sets hidden=true on usersTabBtn. Either both should be
removed (harder to bypass via devtools) or both should be hidden
(easier reasoning) — pick one.

Server-side enforcement at server.js:1712-1718 (/api/admin/users)
and server.js:2220-2237 (requireEarningsAdmin) IS the real defense.
The DOM-level hardening is belt-and-braces; consistency matters
for cognitive clarity.

Recommended: lift the removeXxxTabFromDom helper into app.js and
apply it to both tabs symmetrically.
```

### N.4 — Governance fixture missing locally; feature is dark

```
There is no governance.json at the project root in this worktree.
/api/governance/status returns {count:0, source:"empty", stale:true}
and every /api/governance/:symbol returns 404 "No governance record".

This means the governance feature does nothing locally and (probably)
in prod too, since the cron at /api/cron/refresh-governance runs on
Vercel where NSE-source endpoints are IP-blocked (see CLAUDE.md).

Action: run `node scripts/refresh-governance.mjs` locally, commit the
resulting governance.json, and confirm Vercel reads it. Long-term,
governance refresh should chain into sws-nightly the same way
catalysts+earnings already do (see commit e6fc90cd9).
```

### N.5 — Fundamentals + Surveillance snapshots 19 days stale locally

```
On 2026-05-12 the local fundamentals.json was generatedAt
2026-04-23 and surveillance.json was fetchedAt 2026-04-23 — both
19 days old. picks-latest.json was fresh (today). This suggests
the SWS pipeline runs locally on schedule but the fundamentals /
surveillance refreshers don't.

Action: confirm the nightly job set runs all four refreshers, not
just SWS. Audit scripts/com.starbhai.sws-nightly.plist and
scripts/sws-nightly.sh chain. Add fundamentals + surveillance
to the chain if missing.

This compounds issue 2.9 — without a staleness banner the user
never knows the underlying data is 19 days old.
```

### N.6 — `starbhai.com` is NOT the Vercel deployment

```
https://starbhai.com 301-redirects to https://www.starbhai.com,
which is a separate WordPress site. The actual stock-platform
deployment is at https://stock-platform-gamma.vercel.app (and
the latest deployment URL like
stock-platform-mwjw1ryiz-mtaluja11-3604s-projects.vercel.app).

Anyone bookmarking starbhai.com or sharing the link gets the
WordPress page, not the platform.

Action: either point starbhai.com at the Vercel deployment via
a custom-domain config in Vercel, OR update README / CLAUDE.md
to reflect that the prod URL is the .vercel.app alias.
```

