# PROJECT_STATUS.md — stock-platform

**Last updated: 2026-06-23**

Living snapshot of where the project is right now. Update this file whenever
you ship a meaningful PR or change direction. The point is that a fresh AI
assistant (Codex, Cursor, Claude in a new conversation, etc.) — or a human
reviewer — can read this, `[AGENTS.md](../AGENTS.md)`, and
`[docs/ARCHITECTURE.md](ARCHITECTURE.md)` (the deep design dive) and have full
context in under 10 minutes.

If this file goes stale, it is **worse than not having it.** Don't let it
drift more than one major PR behind.

---

## Where we are right now

The platform is **in production**, live at
[starbhai-stock-platform.vercel.app](https://starbhai-stock-platform.vercel.app),
serving a single-tenant Indian equity research workflow. Auth, the SWS picks
pipeline, portfolio analyzer, earnings watch, risk lab, and macro thesis are
all shipped — plus US / Korea / Taiwan picks tabs, Sector Outlook, and a 5x Lab.

The headline scoring engine is now **V4** (`swsScoringV4.js`) — V3 was deleted
in #437. The current investment is in **signal quality and back-testing
discipline**: V4 shipped with a deliberately *lower* historical backtest than
V3 (cleaner FV model, fixed coverage traps), so the active work is recovering
that gap through weight tuning rather than chasing new features.

Compounder Lab and Earnings Edge were retired in June 2026 to remove unused
experimental surface area and nightly refresh load.

## Recently shipped (themed, newest first — rolling ~4–6 week window; `git log` is the archive)

### SWS current-cohort trailing audit (June 2026)
- **This PR** — Added a research-only `scripts/sws-current-cohort-trailing-audit.mjs`
  tool that measures today's SWS section cohorts against 3y/5y trailing price
  returns and Nifty 50 price-index returns. The output is deliberately marked
  `claim_allowed: false`, `hindsight_bias: true`, and `survivorship_bias: true`
  so it can inform section confidence without being confused for a realized
  Track Record backtest. The pure audit service has regression coverage and is
  wired into `npm test`.

### Market Radar / StockInsights experiment (June 2026)
- **This PR** — Added a signed-in experimental Market Radar tab backed by a
  manual, cached StockInsights snapshot (`data/marketInformation/latest.json`).
  Page views never call StockInsights directly; `scripts/refresh-market-information.mjs`
  performs the provider refresh with a default one-page / 50-row guardrail so
  the 7-day / 100-call trial is not burned by UI traffic. The feed is
  informational only: it surfaces corporate announcements, filing category,
  sentiment, AI summary, source links, provider lag, stale audit, and
  portfolio/watchlist filters without changing SWS scores, action ladders, or
  portfolio recommendations. Production customer-facing use still needs
  StockInsights Business terms confirmed before scaling beyond the trial.

### Track Record freshness hardening (June 2026)
- **This PR** — Track Record Section Alpha is now a first-class SWS publish
  artifact. `data/track-record/section-performance-latest.json` is valid only
  when its `sourceScannedAt` exactly matches `data/sws/picks-latest.json`
  `scanned_at`; stale or missing stored snapshots are bypassed and rebuilt from
  current picks as explicit transient fallback responses that are not cached.
  Both India SWS publish paths rebuild, validate, detect, and stage the artifact
  so Section Alpha moves with the accepted picks deployment. The Track Record UI
  now shows source scan/computed metadata and only warns when the backend serves
  degraded transient fallback.

### Decision-quality contracts (June 2026)
- **This PR** — Non-US/KR/TW research surfaces now expose additive
  `decision_contract` metadata so the UI can distinguish actionable,
  stagger-only, wait, research-only, shadow-only, degraded, and hindsight
  states without changing existing schema versions or V4 scoring. India Buy Now
  is the only surface allowed to promote rows to `Actionable now`; Sector
  Outlook and Watchlist show context/research-only states, Risk Lab remains
  shadow-only, 5x Lab is research-only until its backtest gate is available,
  Earnings sizing copy is context-only, Track Record exposes signed-alpha as
  the primary hindsight metric, and Portfolio Analyzer labels execution context
  beside KEEP/TRIM/SELL/TOP-UP rows.

### 5x Lab trust and validation hardening (June 2026)
- **This PR** — 5x Lab now separates research rank from entry actionability.
  The API exposes snapshot status, age, validation gate, survivorship warning,
  model-implied evidence labels, deterministic candidate limit/filter handling,
  and tradability states (`TRADABLE_NOW`, `WAIT_FOR_VOLUME`, `SIZE_DOWN`,
  `AVOID_ENTRY`). The UI shows stale/degraded/missing and unvalidated banners
  before action copy, labels paper-book values as cash/snapshot-only when MTM is
  unavailable, and keeps base-rate/drawdown/not-empirically-confirmed language
  visible.
- **This PR** — The 5x refresh pipeline writes immutable point-in-time snapshots
  under `data/strategy/pit/<YYYY-MM-DD>.json`, and
  `scripts/resolve-5x-outcomes.mjs` resolves outcomes only from PIT rows plus an
  explicit outcome-input file. The resolver reports unresolved,
  suspended/merged/delisted, and missing-price rows instead of silently dropping
  failed names. A shadow `quality_factor_v2` now records cash-flow, balance
  sheet, governance, and data-confidence evidence and prevents story/theme text
  alone from lifting weak-quality names into the top tier.

### Market Intelligence backdrop safety (June 2026)
- **This PR** — Market Intelligence now has a first-class SWS Discovery Radar
  review queue backed by `data/sws/discovery-feed-latest.json` and
  `/api/sws-discovery-feed`. The radar catches FINOPB-style off-section high
  Future Growth names and KRISHNADEF-style momentum/news names where Future
  Growth is unavailable or false-zero, keeps the copy explicitly review-only
  rather than buy-now, reuses the existing SWS stock modal, and sends a
  formatted nightly HTML digest from the same artifact after the confirmed
  input-diff step.
- **This PR** — Market Intelligence now treats the market verdict as a
  conservative backdrop read rather than a deterministic buy-day command. The
  `/api/market-verdict` route delegates to a pure `buildMarketVerdict()` engine,
  preserves legacy fields, and adds `marketState`, `sourceQuality`,
  `decisionBasis`, and component diagnostics. `CALM` is neutral, stale or
  missing macro becomes insufficient evidence, breadth uses only cached heatmap
  data, and hard gates cap severe macro/FII pressure before any score can turn
  green. The UI now leads with Constructive/Mixed/Risk-off/Insufficient labels,
  explains missing or stale inputs, removes overconfident copy, and shows
  upcoming catalysts as context only.

### India Market actionability upgrade (June 2026)
- **This PR** — India Market keeps the legacy `best_to_buy_now` API/storage key
  but presents it as Best Stocks to Buy Now with a stricter fresh-buy policy
  layered outside V4 scoring. Refresh scoring now emits entry-band metadata, FV
  sanity warnings, liquidity/freshness/ASM-GSM gates, and deterministic section
  tie-breaks while preserving existing section query params and Track Record
  identifiers such as `sws_best_buynow`.
- The UI now groups India sections into Actionable Ideas and Research / Watch
  by default, with a Flat Sections toggle, per-section sort modes, entry-state
  badges, no-buy-above levels, and stale/FV warning badges. Growing Sector Value
  records clearer macro-fallback audit state when Sector Outlook data is stale.

### SWS fair-value recovery hardening (June 2026)
- **This PR** — India SWS fair values were restored after a sparse generated
  artifact republish dropped Top 30 coverage. The API client now sends the
  correct `companyId` variable to `NarrativeValuationHistory`, the parser only
  trusts matched-company analyst target narratives, the sanity gate blocks
  sharp FV coverage regressions, and conflicted nightly recovery PRs must pass
  that same gate before pushing replacement generated data. The refreshed India
  artifact restores Top 30 FV coverage to 28/30 and full-universe SWS raw-FV
  coverage to 841/5575.

### Sector Outlook trust-first redesign (June 2026)
- **This PR** — Sector Outlook now preserves the same 24 raw SWS sector labels
  shown in the India Market sector filter, while normalizing those labels only
  for macro cross-check lookup. The refresh script fills the full India sector
  universe, the generated payload records observed vs universe sector counts,
  and `/api/sector-outlook/latest` adds a runtime stale/macro-mismatch audit so
  the tab can warn instead of silently serving an outdated regime read.
- **This PR** — Sector Outlook now ranks sectors by a numeric 0–100 trust score
  before outlook direction. The trust model blends evidence volume, sector
  breadth, 30/90/365-day signal stability, macro/external agreement, retained
  classifier confidence, optional sector-index confirmation, and macro
  freshness; HIGH/MED/LOW confidence is derived from that trust score instead
  of ad-hoc evidence rules. Missing macro or sector-index context is marked
  `UNCORROBORATED` rather than failing refresh, while true opposite-sign macro
  or price evidence is marked `DIVERGENT` and lowers trust. The UI now shows a
  Trust column before Outlook, keeps horizon switches trust-sorted, and exposes
  factor-level drilldown evidence.

### Portfolio SWS input alert rollout (June 2026)
- **This PR** — SWS portfolio input-change email delivery now supports a narrow
  `SWS_INPUT_ALERTS_SUPPRESS_EMAILS` recipient blocklist. The cron checks the
  comma-separated lowercase/trimmed email list before user preference and
  portfolio eligibility, emits skipped recipients with
  `reason: "recipient_suppressed"`, and leaves all other recipients, in-app
  alert state, portfolio data, and ledger history untouched.
- **This PR** — SWS input-change emails now require confirmed v2 alert
  artifacts before delivery. The parser rejects unstable non-consensus default
  narrative fair values unless an explicit `AnalystConsensusTarget` source is
  present, the nightly diff writes a two-consecutive-full-run confirmation
  state, the cron refuses legacy/unconfirmed artifacts, and the alert ledger
  adds a 14-day semantic transition cooldown.
- **This PR** — SWS portfolio input-change emails now prepend a Portfolio
  Analyzer reduction-review block when an alert-affected holding newly enters a
  confirmed reduction/exit from the analyzer construction plan. The cron reuses
  the saved-portfolio analyzer rerun path, records lightweight
  `PORTFOLIO_ACTION_STATE` baselines in the SWS alert ledger on live passes,
  avoids repeat highlights for continuing reductions, and keeps failed sends
  retryable by writing only `EMAIL_FAILED`.
- **This PR** — SWS portfolio input-change emails now roll out to every signed-in
  user with uploaded Analyzer/Portfolio holdings, defaulting email alerts on
  while preserving an explicit Portfolio Analyzer opt-out. The send cron now
  loads each user's holdings before delivery, skips users without uploaded
  portfolios or material held-stock changes, and keeps same-run dedupe stable
  even when alert digest semantics change. Alert emails use a structured
  Gmail-safe table, suppress sub-2% fair-value-only moves, and keep the raw
  nightly diff artifact exhaustive for audit/debugging.

### Platform menu + theme shell (June 2026)
- **This PR** — The app shell now defaults to light mode regardless of OS
  preference, with dark mode persisted through `localStorage.starbhaiTheme`.
  The top-right legacy Labs/More control has been replaced by a working
  Platform menu generated from the same tab guards as `switchTab`, including
  admin-only Users visibility, Sector Outlook opt-out handling, keyboard and
  outside-click dismissal, active `aria-current` sync, and an in-menu
  light/dark switch. App-shell metadata and the manifest now use the light
  default while the dark palette remains available behind `[data-theme=dark]`.

### Chronos forecast overlay (June 2026)
- **This PR** — India `best_fundamentals` stock modals can now show a cached,
  experimental Chronos timing/risk overlay for up to 100 stocks. The refresh
  stage runs offline after SWS scoring, selects `.NS` Yahoo OHLCV with `.BO`
  fallback, calls a local Python Chronos worker (`amazon/chronos-2` primary,
  Bolt fallback), and commits only compact `data/sws/chronos-forecast-*.json`
  artifacts. The API hides stale digest mismatches, Vercel excludes model/OHLCV
  caches, and the modal copy explicitly says the overlay does not change the
  Starbhai score or analyzer action.

### V4-only score contract (June 2026)
- **This PR** — SWS score truth is now V4-native across first-party market
  APIs, cards, modals, analyzer payloads, earnings signals, Track Record
  snapshot mapping, scorer outputs, and static guards. Generated payloads
  dual-write `top_ranked_30_v4`, `signals.v4`, and `v4-universe-stats.json`
  while temporarily mirroring legacy V3 compatibility keys. Surveillance and
  risk-overlay metadata now live under `regulatory_flags` / `risk_overlay`, and
  `fundamentalsV2` fallback scores are explicit non-SWS fallback candidates
  instead of populating V4 score fields.

### Snowflake Gap Lab (June 2026)
- **US follow-up** — US Market now has the same experimental Snowflake Gap Lab
  contract as India, with USD market-cap buckets, a $50M hygiene floor,
  US-native shadow scoring, API clone-safety, US-scoped UI chunking, and
  explicit `snowflake_gap_lab` audit metadata. Canonical V4 remains the source
  of record; the first populate-only US artifact ships a capped 200-row Gap
  Lab section from the current US deep tarball.
- **Warning-banner follow-up** — India stock-detail modals now break SWS
  insufficient-data warnings down by Snowflake section, using the persisted
  `snowflake_data_quality.by_pillar` counts that are present across current
  India warning payloads. When refreshed payloads include a full
  `snowflake_check_matrix`, the same banner groups the missing metric names by
  section; otherwise it keeps the existing sample metric examples.
- **Data backfill follow-up** — `scripts/sws-populate-gap-lab.mjs` can now
  populate only `sections.snowflake_gap_lab` and its audit block from the
  current India SWS deep files, without running the full scorer or rewriting
  canonical V4 sections. The June 4 backfill packed Snowflake check matrices
  into `data/sws/deep.tar.gz` and populated 415 India Gap Lab rows; KRISHNADEF
  is included as a review-only example with canonical V4 unchanged.
- **Ordering follow-up** — Snowflake Gap Lab rows now sort by experimental
  shadow V4 score descending, with score delta used only as a tie-breaker, so
  the section reads like the other score-led India Market sections.
- **This PR** — India Market now has an experimental Snowflake Gap Lab surface
  for discovering SWS data-gap candidates without changing canonical V4. The
  parser persists the visible Snowflake check matrix, the pure
  `swsSnowflakeGapLab` helper imputes only explicit no-data V4 checks from
  self-excluded sector/industry plus market-cap peers, and the resulting
  shadow V4 metadata stays under `snowflake_gap_lab`. The lab excludes
  dividend checks, GSM rows, sub-₹500cr companies, thin peer samples, and weak
  deltas; it is intentionally absent from Track Record, section-performance,
  model-portfolio, and recommendation mappings.

### Unified global search (June 2026)
- **This PR** — Header global search now covers every committed SWS scored
  universe across India, US, Korea, and Taiwan while keeping results compact.
  The API reads only scored-universe JSON, preserves India NSE/BSE dedupe and
  India-scoped Yahoo fallback, and returns market metadata so the frontend
  opens India, US, Korea, or Taiwan SWS detail modals correctly. KR/TW ticker
  lookup now resolves mixed-case SWS keys such as `q500036.KS` and `01001t.TW`
  without breaking deep tarball lookups.

### SWS nightly artifact contract (June 2026)
- **This PR** — The isolated SWS nightly now separates deployable artifacts
  from local generator caches before opening its auto-refresh PR. Loose India
  deep briefs, Sector Outlook classified-news shards, F&O history, Groww stock
  cache, coverage diagnostics, and Risk Lab LLM cache are restored/cleaned
  after the packed deep tarball, 5x Lab, Risk Lab, and coverage steps have run.
  The auto-PR allow-list now includes the served universe, sanity, coverage
  master, Risk Lab, macro thesis, and 5x Lab snapshots, and the Vercel bundle
  contract explicitly includes runtime JSON/tarball artifacts while excluding
  local working sets.

### Portfolio Analyzer evidence-gated reductions (June 2026)
- **This PR** — Portfolio Analyzer reductions now pass through an explicit
  evidence contract before any ladder sizing can create rupee-sized sell rows.
  Discounted/high-V4 holdings with stale or single-factor fiscal weakness are
  downgraded to review/blocked status instead of confirmed reductions, thin SWS
  coverage becomes `coverage_watch`, and same-run sell proceeds stay excluded
  from buy capital until confirmed. The cockpit now surfaces decision evidence,
  counter-evidence, FV/data freshness, small/micro sleeve warnings, and
  blocked reduction candidates separately from confirmed thesis-break or
  risk-cap actions.

### India Growing Sector Value fallback (June 2026)
- **This PR** — India Market's Growing Sector Value section now keeps showing
  candidates when Sector Outlook is out of sync with the current macro regime.
  The canonical Sector Outlook tailwind strategy still fails closed on
  stale/macro-mismatched outlooks, but the UI can render a clearly labeled
  current-macro fallback using only positive macro sector impacts plus the
  existing high-confidence fair-value and hygiene gates. Macro-fallback rows
  are marked separately and are not snapshotted into the canonical
  `sws_growing_sector_value` Track Record cohort.

### Lab surface decommission (June 2026)
- **This PR** — Compounder Lab and Earnings Edge are fully retired: tabs,
  renderer scripts, APIs, sleeve services, generated data, promoter-PIT feed,
  and nightly refresh/reconcile jobs were removed. Retired deep links now
  canonicalize to India Market (`#tab=picks`), while 5x Lab and Track Record
  paper-trade infrastructure remain intact.

### US/KR/TW modal enrichment quality gate (June 2026)
- **This PR** — US, Korea, and Taiwan refresh jobs now treat SWS Recent News
  and Rewards/Risks as a shipping contract for stock-detail modals. The
  existing shared India modal renderer remains the single UI path; the refresh
  scripts run `sws-news-sharded.sh <market>` after parse/score and before
  packing `deep-<market>.tar.gz`, then compute a tarball-backed quality summary
  and run a fail-closed auto-ship gate. Local generated data remains inspectable
  on quality failure, but PR/auto-merge is skipped if deployable tarballs lose
  canary news/reward coverage. `/sws-status-us`, `/sws-status-kr`, and
  `/sws-status-tw` now print stored quality counters from `last-refresh.json`.

### US/KR/TW e2e fixture isolation (June 2026)
- **This PR** — US/KR/TW Playwright market fixtures now write under the ignored
  `.e2e/sws-root` tree via `SWS_REPO_ROOT_OVERRIDE`, and the runtime DALs honor
  that same override so tests and web-server reads stay aligned. This prevents
  synthetic fixture rows from leaking into committed `data/sws-*` production
  artifacts. Known leaked fixture markers such as `GROWTH / Quality Growth Co`
  and the dead `nasdaq-growth` Simply Wall Street URL are quarantined at the
  market API layer, and market stock-detail routes now refuse orphan deep
  briefs unless the ticker still exists in a non-fixture scored universe row.
  New guard tests fail if known fixture markers are served by market APIs or if
  fixture builders mutate tracked production outputs.

### SWS fair-value source fidelity (May 2026)
- **This PR** — SWS fair value is now treated as source-of-truth across India,
  US, Korea, and Taiwan picks. Finite SWS FV values are preserved even when the
  FV/price ratio is unusually high or low; upside is computed from raw SWS FV
  plus current price, and extreme-ratio telemetry now stamps `ok_sws_raw_fv`
  instead of suppressing the value. Card/scored-universe/API rows carry
  `fair_value_source` and `upside_source`, parser output records SWS FV/upside
  source metadata, and 52w ranges fall back to SWS price history when Groww
  52w data is absent. The shared modal renderer now falls back from null card
  FV/upside to populated deep overview values, fixing the HIMS-style US modal
  case where valid deep data rendered as unavailable.

### India Market modal source fidelity (May 2026)
- **This PR** — India stock modals now keep raw scraped own P/E separate from
  peer-benchmark eligibility. Groww/Refinitiv `peRatio` is displayed whenever
  it is finite, including `0` and negative values; missing/null P/E remains
  unavailable and is not synthesized from negative EPS. V4 relative-P/E scoring
  still only scores when own P/E and peer P/E are both positive. Peer P/E can
  now come from Groww `industryPe` even when own P/E is missing, and SWS REST
  industry rows fill peer net margin and future revenue growth when
  `primaryIndustry.industryAverages` is absent. The India deep brief tarball was
  rebuilt so production modal data reflects the new source contract.

### Earnings Watch freeze/de-dupe (May 2026)
- **This PR** — Earnings Watch now has strict bucket ownership: `events[]`
  serves today/future rows only and `recent_results[]` serves past rows only,
  so same-day cards no longer duplicate between the today section and the
  recent/status tracker. Due-event predictions freeze to the latest pre-event
  history archive row, with same-day fallback only when no pre-event snapshot
  exists. Read-time normalization repairs already-committed snapshots on
  `/api/earnings/upcoming`, `/api/earnings/upcoming/stats`, and
  `/api/earnings/:symbol`, while refresh-time freezing prevents future
  same-day recomputes from changing the displayed call. History archive v5 adds
  a compact `display_snapshot` for near-term rows so future frozen cards can
  preserve the exact prediction-time display without storing full event blobs.

### Portfolio Analyzer construction layer (May 2026)
- **This PR** — Portfolio Analyzer now separates SWS research opinions from
  executable portfolio construction. Raw SWS actions still drive action mix,
  stance pills, audit evidence, and candidate lists, but only
  `constructionPlan.fundedTrades[]` carries executable buy rupees. Buy capital
  is `freshCapitalInr + confirmedFreedCapitalInr`; today's suggested trims are
  shown as potential future freed capital and are not reused until execution is
  confirmed. Funded adds require HIGH-confidence discounted FV, fresh/verified
  price data, post-trade single-name and sector room, min ₹25k size, and max 5
  buys. The analyzer UI now leads with "Today's funded plan" and relabels old
  top-up/basket surfaces as eligible but unfunded add candidates.

### Track Record credibility spotlight (May 2026)
- **This PR** — Track Record headline history now has a deployed canonical seed
  ledger under `data/track-record/` with the existing file/KV store layered on
  top. Production no longer depends on mutable KV as the only historical copy,
  `/api/track/stats` exposes seed/overlay diagnostics, and the SWS refresh
  pipeline snapshots Track Record rows even when narration is skipped.
- **This PR** — Track Record now excludes SWS Upcoming Earnings and Avoid from
  public metrics, filters, CSV export, calibration, section scorecards, and the
  India Market best-alpha spotlight. Those rows remain in storage for explicit
  audit-only lookups, but future SWS snapshots no longer write those
  context-only buckets into the public track-record pipeline.
- **This PR** — India Market's Track Record Spotlight now auto-selects a
  single best 7d/30d proof point from `bestOverall` instead of showing manual
  timeframe chips. The banner still names the selected window/cohort (for
  example, `30d · Best to Buy Now top 3 +5.0%`) while the Track Record tab
  keeps the full 7d/30d and cohort audit controls.
- **This PR** — India Market section track record now stores daily SWS cohorts
  for official Top 3 / Top 5 / Top 10 / Top 20 samples per section, keeps a
  shared Nifty 500 benchmark per timeframe, preserves legacy top-10 API
  behavior when `cohorts` is omitted, and lets the homepage spotlight choose
  the strongest eligible 7d/30d proof point with explicit cohort labeling.
  Duplicate partial cohorts cannot win under a misleading larger label; Track
  Record now exposes Best / Top 3 / Top 5 / Top 10 / Top 20 controls as the
  audit view.

### Branded Vercel URL (May 2026)
- **Vercel-only platform link** — the canonical public link is
  `https://starbhai-stock-platform.vercel.app`. This keeps the platform on
  Vercel-managed DNS/CDN and keeps `starbhai.com` completely out of the stock
  platform setup.

### V4 composite score — V3 deleted (May 2026)
- **#437** — **V4 is now the sole SWS composite score; V3 is deleted.** New
  `services/swsScoringV4.js`: pillars 76 (Health 22 / Future 20 / Valuation 18 /
  Past 16) + coverage-renormalised FV 12 + momentum 12 − risk overlay ≤15 → a
  0–100 score with **absolute** verdict cutoffs (TOP_PICK ≥59 / STRONG ≥47 /
  ACCEPTABLE ≥37 / WATCH ≥28 / AVOID), applied across all four regions. The
  Dividends pillar was dropped from the score. The `signals.v3.*` /
  `top_ranked_30_v3` / `v3-universe-stats.json` names were **kept as
  V4-carrying aliases on purpose** — don't blind-rename them. Honest caveat:
  V4's 4-yr backtest *trails* V3 (XIRR ~58% vs 66%, Sharpe ~1.75 vs 2.05);
  weight tuning is the stated recovery path.
- **#438** — Fix stock-modal crash (`undefined hasV3` in score-breakdown).
- **#439** — CI modal-render e2e job to catch `renderSwsModalCore` regressions.

### Multi-region Markets (May 2026)
- **#379 / #386** — US Market tab + first full US scrape (~5,448 names), as a
  fully isolated `data/sws-us/` fork (US scorer/parser import India's, never edit).
- **#383 / #391 / #408** — **Region registry** (`scripts/sws-regions.mjs`):
  config/universe/scrape/parse/score/DAL + `registerRegionPicksRoutes` factory +
  generic `renderRegionPicks`, keyed by region code. Korea (~2,590) + Taiwan
  (~2,339) scraped and live, in ₩ / NT$. **KR/TW are registry config, not forks;
  India + US pipelines frozen.** Numeric tickers dot-suffixed (005930.KS /
  2330.TW); 4-market co-run guard on the one shared SWS account.
- **#390** — US/KR/TW Markets at 1:1 parity with India (rich modal, dropdown,
  collapse). **#393 / #404** — regional deep briefs are packed as tarballs for
  local/DAL use, but the catch-all Vercel lambda serves compact card fallback
  data to avoid bundle-size/file-count risk.
- **This PR** — US/KR/TW stock-detail APIs now normalize `returns_pct` from
  deep briefs, card rows, or audit-trail aliases, and enriched card data carries
  1D / 7D / 1M / 3M / 1Y total returns for modal fallback rendering.
- **This PR** — US/KR/TW stock modals now render Total Returns from full deep
  briefs or compact card fallback data, and the regional DAL prefers fresher
  packed deep tarballs with a Node extraction fallback when shell `tar` fails.
- **This PR** — US/KR/TW stock modals also accept an offline
  `fundamentals-latest.json` Yahoo enrichment snapshot, so sparse SWS briefs can
  still show India-style valuation, profitability, balance-sheet, dividend, and
  ownership metrics without fetching anything at modal-open time.

### New experimental surfaces (May 2026)
- **#347** — Sector Outlook tab (SWS news themes × macro regime; no named picks v1).
- **#348 / #354** — 5x Lab (concentrated multibagger) + per-pick
  Strategy & Reasoning with a live pre-mortem. **#350** — prod gate/data fix.
- **#337** — Compounder Lab + Earnings Edge two-sleeve paper-trade book + NSE PIT
  promoter-transaction feed. Retired in June 2026.

### Auth & navigation (May 2026)
- **#458** — Flatten privileged navigation: US/KR/TW Markets, Risk Lab, and
  Sector Outlook stay visible in the main tab bar for signed-in users; only
  Users remains owner-admin-only. Admin authority is now hard-coded to
  `mtaluja11@gmail.com` via `computeIsAdmin()` rather than `ADMIN_EMAILS`.
- **#395 / #467 / current** — Owner-admin access is hard-coded to
  `mtaluja11@gmail.com`; all read-only market and lab tabs are visible to
  signed-in users, and only Users/admin/write routes stay owner-only.
- **#361** — "More" dropdown for privileged tabs. **#370** — Avoid List section
  removed from India Market. **#360** — density toggle removed. **#380** — mobile
  info-icon sizing fix.

### Pipeline / infra reliability (May 2026)
- **Current** — SWS nightly isolated-worktree recovery hardened after the
  2026-06-04 00:30 IST failure: the launchd wrapper now discards stale
  generated files before resetting the dedicated worktree, force-checks out
  `origin/main`, and links ignored local runtime artifacts
  (`node_modules`, SWS API queries, and `.sws-profile-*`) so scrapes and
  auto-push pre-push tests run with dependencies.
- **This PR** — India SWS nightly now fires at **00:30 IST daily** instead of
  16:30 IST, matching observed SWS rolling-update behavior. The installed
  LaunchAgent was reloaded from the repo template, so it now runs
  `sws-nightly-isolated.sh`; the SWS circadian scrape window and Groww
  full-refresh gate moved with the schedule so the 00:30 launch is not blocked.
- **This PR** — Free-tier CPU reduction: idle signed-in browser tabs no longer
  generate continuous minute-level Vercel Function traffic. `/api/market`
  serves public, cacheable, non-user market data; warm-cache crons are
  manual-only; surveillance refresh is owned by local launchd nightly because
  NSE blocks Vercel datacenter traffic. Protected shell/app JS remains
  auth-gated, with conservative static cache headers so private app surfaces
  are not CDN-public.
- **This PR** — Permanent refresh shipping fix: successful full India/US/KR/TW
  SWS refreshes now auto-open generated-data PRs and auto-merge to `main`, while
  seed/capped runs and failed-shard runs are refused. US/KR/TW shortcuts ship
  only their own `data/sws-<market>/` deployable artifacts, index/universe
  metadata, and the global `data/macroCalendar.json`; they explicitly do not
  run India fundamentals, F&O OI, or Earnings Watch refreshes. India nightly now
  uses HTTPS preflight instead of ICMP-only ping, continues auxiliary refreshes
  after early SWS scrape failure, and can data-only ship those auxiliary outputs
  so stale banners do not persist while SWS is being debugged.
- **This PR** — `data/macroCalendar.json` is now managed by
  `scripts/refresh-macro-calendar.mjs`, which pulls public Fed/BLS/MoSPI/RBI
  event sources where available and preserves the prior good calendar without
  bumping `_updated` when future coverage is too thin.
- **This PR** — `sws-nightly.sh` now re-execs itself from a temporary stable
  copy before any branch checkout. This prevents Bash from reading a rewritten
  working-tree script mid-run, which caused the 2026-05-25 post-news step to
  jump into a duplicate SWS scrape after the first scrape/PDF/news had already
  completed.
- **This PR** — NSE Surveillance (ASM/GSM) freshness hardening: root
  `surveillance.json` is bundled into Vercel, runtime snapshot selection picks
  the best populated/fresh value across KV/cache and disk, and zero-row NSE
  outages preserve the last-good populated snapshot. Manual refresh landed a
  2026-05-25 snapshot with 169 flagged names.
- **#345** — Decommission Neon Postgres; full JSON-only DAL.
- **#357 / #358 / #402** — macroRegime single-writer hardening (no stash/pop
  clobber; backup macro refresh via PR not push-to-main; single-writer rule
  extended to `macro-headlines/` + `macroRegime-history/`).
- **#406** — universe-meta stamp on rebuild + 11-day nightly self-heal.
- **#325 / #326** — `MACRO_ALLOW_HEURISTIC_ONLY` for keyless callers + GH Actions
  backup macro workflow (heuristic-only, no secrets).
- **#218 / #219** — sws-nightly resilience (worktree-safe sync, no `--delete-branch`).

### Earlier (Apr–early May, condensed — see `git log` for the full archive)
- **Earnings Watch pipeline (#208–#217):** calendar builder → multi-component
  predictor → LLM qualitative signal (Gemini/Groq/heuristic) → resolve actuals →
  weight-tuning sweep → daily pipeline-health summary. Opened to all signed-in
  users (#209).
- **Portfolio Analyzer:** dividends-to-capture + Hold-by column (#344), Last
  Earnings column (#323), cooldown gate vs duplicate trims (#196 / #210).
- **Risk Lab + UX:** hover tooltips (#336), discrimination + LLM-disagreement +
  macro transparency (#330), platform-wide UI/UX overhaul (#322 / #340),
  progressive-disclosure overhaul (#207).
- **SWS picks polish (#194–#206):** credibility ribbon, Newly-Added/Trending
  badges, search-hit chips, skeleton loaders.

## Active themes / what's in flight

- **V4 weight tuning (the headline investment).** V4 shipped despite a lower
  historical backtest than V3 — by design (cleaner relative-FV model, fixed
  coverage/absent-FV traps). The score is deliberately *tunable, not frozen*;
  recovering the XIRR/Sharpe gap via `scripts/sws-backtest-weight-sweep.mjs` is
  the active work. `data/sws/predictor-weights-v1.json` is the rollback anchor.
- **Auth model settling.** Two-tier (#395) shipped, and owner admin is now
  centralized in `computeIsAdmin()` as `mtaluja11@gmail.com` while public
  research tabs stay visible to signed-in users. Per-user data namespacing
  remains the eventual goal. **Verify `server.js` + `services/auth/` before
  touching auth.**
- **Earnings predictor validation.** Backtest wired
  (`scripts/backtest-earnings-predictions.mjs`); the V1 cap-lift gate (≥30
  resolved + ≥55% bucket hit-rate + Brier <0.20) is still warming up. Weight
  tuning won't run until ≥80 resolved across ≥2 quarters, ≥5 sectors with ≥10
  events.

## Known production gotchas (also in AGENTS.md / ARCHITECTURE.md, repeated for emphasis)

- **`gated/app.js` is ~13,040 LOC.** Concurrent edits collide — edit sequentially.
- **NSE cookie-gated endpoints fail on Vercel datacenter IPs.** Run locally, commit JSON.
- **V4-native score names are the first-party contract.** `signals.v4`,
  `top_ranked_30_v4`, and `v4-universe-stats.json` are canonical runtime
  surfaces. Historical V3 labels may still exist as temporary compatibility
  mirrors or ledger identifiers, but UI/API/analyzer code should not use them
  as score truth.
- **V4 verdicts are absolute cutoffs** (≥59 / ≥47 / ≥37 / ≥28), not rank-based — no
  universe band is loaded at runtime.
- **Vercel KV is dead for the picks/fundamentals READ path** (#195) but still backs
  user-scoped *writes* (watchlist, portfolio, track) via `userStorage.js`.
- **Regional deep briefs are packed as `deep-{us,kr,tw}.tar.gz`** (#393), but the
  catch-all Vercel lambda must stay on compact `picks-latest.json` fallback data
  for regional modals to avoid bundle-size/file-count risk. Regional refresh
  jobs must run SWS news enrichment before packing these tarballs; the quality
  gate skips auto-ship when canary Rewards/Risks or Recent news disappear.
- **9× backtest scripts are forks**, not a shared library — propagate fixes by hand.
- **Auto-refresh PRs flood the repo** — `chore(macro|sws): auto-refresh ...` open every
  few hours. They commit data files, not code.
- **`starbhai.com` is out of scope for this platform** — do not configure it in
  Vercel, OAuth, CORS, metadata, or shared app links. Always link
  `https://starbhai-stock-platform.vercel.app`.

## Roadmap items (not yet started)

- **Per-user portfolio namespacing.** Currently every signed-in user sees
  the same global portfolio. Next iteration of the auth shipped in early May.
- **Mobile layout pass.** SPA is desktop-first; mobile is tolerable but not
  loved.
- **Custom domain.** Deferred. The current branded link is Vercel-managed:
  `https://starbhai-stock-platform.vercel.app`.
- **Screener.in ingestion** for 10y fundamentals. SWS only exposes 5 rows
  of `fiscal.yearly_history` and no ROCE — any Marcellus-replica-style
  10y-quality filter blocks on this.
- **NSE PIT (insider) 7(2) scraper.** SWS capture has no insider data
  (`is_insider` + `insider_ownership_pct` are null universe-wide). The prior
  promoter-transaction feed was retired with Earnings Edge; broader
  insider-signal surfacing would need a new product surface and refresh path.

## Near-term cleanups (small, known)

- **Stale V3 code comments (cosmetic).** `swsHoldingEngine.js`, `v3SignalAdapter.js`,
  and `loadV3UniverseStats.js` still describe `computeV3Score` as if it were live;
  `earningsLlmBatcher.js:202` JSDoc still says the LLM floor defaults to 50 (the
  constant is 47). Code is correct V4 — only the comments are stale.

## Refresh cadence summary

See [AGENTS.md](../AGENTS.md#data-pipelines-refresh-cadences) for the full
table. TL;DR: everything that touches NSE runs **locally**, writes JSON to
`data/`, commits, Vercel serves. Nothing originates ingestion on Vercel.

## How to update this file

When you ship a PR that:

- Adds a new feature, tab, or major surface → add a line under "Recently shipped"
- Changes direction or starts a new investment theme → update "Active themes"
- Finds a new production gotcha → add it to "Known production gotchas"
- Completes a roadmap item → strike it from "Roadmap items" and move it to "Recently shipped"

Update the `Last updated:` date at the top.

When a section gets to >15 lines under "Recently shipped", trim the oldest
entries — they live in `git log` permanently. This is a **rolling 4–6 week
snapshot**, not an archive.
