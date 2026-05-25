# AGENTS.md — stock-platform

Tool-agnostic project context for AI coding assistants (Codex, Cursor, Aider,
Continue, Claude Code, etc.). Start here. Claude-specific instructions live in
[CLAUDE.md](CLAUDE.md); the current state of the project lives in
[docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

---

## What this is

**stock-platform** (a.k.a. **starbhai**) is a single-tenant Indian equity
research and recommendation platform. It is **not a brokerage** — no trades
are placed. It ingests fundamentals from multiple sources, scores stocks,
generates SEBI-RA-style narratives, predicts earnings reactions, and runs
backtests to validate every signal it surfaces.

Primary user: the repo owner (handle `starbhai`). Secondary users: a small
allow-list of signed-in Google OAuth accounts. Production lives at
**https://starbhai-stock-platform.vercel.app** (the stable Vercel alias;
`starbhai.com` is out of scope and must not be linked as the platform).

## Stack

- **Runtime:** Node.js (ESM, `"type": "module"`). No TypeScript.
- **Server:** Express 4 (`server.js`, ~7,900 LOC, ~96 routes). Single process.
- **Frontend:** Vanilla JS SPA in `gated/` (`app.js` is a ~13,000-LOC
  monolith — concurrent edits collide; touch it sequentially). No framework,
  no build step.
- **Database:** None. All persisted state is JSON files committed under
  `data/` (SWS scrape outputs, picks, catalysts, macro regime, fundamentals
  history, paper-trades, etc.). The repo had a Neon Postgres mirror via
  `services/swsDal/sqlBackend.js`; it was decommissioned on 2026-05-19 (#345).
  Picks/fundamentals reads now go through `services/swsDal/` over `jsonBackend`
  only. **Nuance:** user-scoped *writes* (user records, watchlist, portfolio,
  track snapshots) still use `@vercel/kv` in prod (local flat file in dev) via
  `userStorage.js` — so "Vercel KV is dead" is true only of the data-serving
  read path, not the write store.
- **Hosting:** Vercel (serverless via `api/index.js` → `server.js`). Free tier.
- **Auth:** Google OAuth (`google-auth-library`), session-gated on every
  route except a small public set. `AUTH_ENABLED=false` bypasses auth for
  local dev and Playwright tests.
- **Tests:** Node's built-in test runner for unit tests (153 `test/*.test.mjs`
  files; ~130 wired into `npm test`). Playwright for e2e (100 specs,
  `npm run test:e2e`, port 4011 via `webServer` config). Both self-skip on
  missing fixtures. ⚠️ `npm test` currently references `test/adminGate.test.mjs`
  which was renamed to `test/personalUseGate.test.mjs` — the `&&` chain breaks
  there until the path is fixed in `package.json`.
- **AI keys (optional, all graceful-degrade):** Anthropic, OpenAI, Groq, Gemini.

## Repository layout

```
.
├── server.js               # Express app, ~96 routes, session-gated
├── gated/                  # SPA (vanilla JS), session-required
│   ├── index.html          # base tabs (picks, analyzer, news, track, watchlist,
│   │                       #   risk lab, sector outlook) + a "More" dropdown for
│   │                       #   privileged tabs (US/KR/TW picks, 5x Lab, Compounder,
│   │                       #   Earnings Edge, Users), unhidden on boot by role
│   ├── app.js              # ~13K-LOC monolith — DO NOT parallelise edits
│   ├── earnings.js         # Earnings Watch tab logic
│   ├── riskLab.js          # Risk Lab tab logic
│   ├── sectorOutlook.js    # Sector Outlook tab logic
│   ├── multibaggerLab.js   # 5x Lab tab logic
│   ├── compounderLab.js    # Compounder Lab tab logic
│   ├── earningsEdge.js     # Earnings Edge tab logic
│   └── swsV2Render.js      # SWS picks renderer
├── services/               # Pure logic, unit-tested
│   ├── earnings/           # Earnings prediction + backtest pipeline (12 files)
│   ├── fundamentals/       # YoY-EPS-trajectory + history refresh
│   ├── macroThesis/        # Macro regime classifier + scenario engine
│   ├── riskLab/            # Per-stock risk decomposition + macro overlay
│   ├── swsDal/             # SWS data-access layer (JSON-only)
│   └── sws*.js             # SWS scoring, conviction, peer/sector layers, etc.
├── scripts/                # Refresh + backtest CLIs (~100 files)
│   ├── sws-nightly.sh      # The big nightly chain (sws → fundamentals → earnings → health)
│   ├── refresh-*.mjs       # Data ingestion (catalysts, NSE corporate, earnings, etc.)
│   ├── backtest-*.mjs      # 9× backtest variants (treated as forks, not shared)
│   └── sws-*.mjs           # SWS scrape pipeline (Playwright + API variants)
├── data/                   # JSON fixtures + scraped data (mostly checked in)
├── test/                   # Unit tests (Node's built-in runner)
├── test/e2e/               # Playwright specs
├── api/index.js            # Vercel entry point — forwards to server.js
├── CLAUDE.md               # Claude-specific instructions (multi-agent patterns, etc.)
└── docs/PROJECT_STATUS.md  # Living project state — read this for "what's shipped"
```

## How to run locally

```bash
npm install
# Local dev (no auth, port 3000):
AUTH_ENABLED=false node server.js
# Unit tests (~130 suites, ~30s):
npm test
# Playwright e2e (port 4011; pre-builds analyzer xlsx + US/KR/TW picks fixtures):
npm run test:e2e
# Smoke import check (catches ESM resolution errors):
npm run smoke
```

`.env` and `.env.local` are git-ignored. `.env.example` lists every key.
**No keys are required to run the site** — every external integration
graceful-degrades. They're only needed if you're refreshing data.

## Major features (the surfaces a reviewer should know about)

| Tab / surface | What it does | Entry points |
|---|---|---|
| **India Market** (`picks` tab) | Indian equities scored on SWS's 6-pillar Snowflake distilled into a 100-pt **V4** composite (`swsScoringV4.js`; pillars 76 + FV 12 + momentum 12 − overlay ≤15). Sectioned by verdict band (Top picks / Strong / Watchlist). Avoid List section was removed (#370). | `gated/swsV2Render.js`, `services/swsScoringV4.js`, `services/swsScoring.js`, `services/swsConvictionEngine.js` |
| **US Market** (`usPicks` tab, signed-in read) | SWS-sourced US-equity leaderboard (NASDAQ/NYSE/NYSEMKT ~5,448 liquid names). Same Snowflake + 100-pt V4, but USD ($). Fully isolated `data/sws-us/` fork — imports the India scorer, never edits it. Manual `/sws-refresh-us`; ships empty until scraped. | `scripts/sws-scoring-us.mjs`, `services/usPicksDal.js`, `server.js` (`/api/us-picks`), `gated/app.js` (renderUSPicks/renderUSModal) |
| **Korea / Taiwan Market** (`krPicks` / `twPicks` tabs, signed-in read) | SWS-sourced KOSPI+KOSDAQ (~2,623) and TWSE+TPEx (~2,335) leaderboards, in ₩ / NT$. Built on a **region registry** (`scripts/sws-regions.mjs`): generic config/universe/scrape/parse/score/DAL + a route factory + a generic render path, keyed by region code — KR/TW are config entries, NOT new forks; US + India pipelines are frozen. Numeric tickers are dot-suffixed at the universe builder (005930.KS / 2330.TW) so they survive the India BSE filters. Manual `/sws-refresh-kr` / `/sws-refresh-tw` (4-market co-run guard); ship empty until scraped. | `scripts/sws-regions.mjs`, `scripts/sws-scoring-region.mjs`, `services/regionPicksDal.js`, `server.js` (`registerRegionPicksRoutes`, `/api/{kr,tw}-picks`), `gated/app.js` (renderRegionPicks/renderRegionModal) |
| **Portfolio Analyzer** (`analyzer` tab) | Upload portfolio xlsx → per-stock recommendation (KEEP/TRIM/SELL/TOP-UP) with SEBI-RA-style narrative, sized in ₹. Cooldown gate prevents duplicate trim flags. | `gated/app.js` (portfolio sections), `services/swsHoldingEngine.js`, `services/swsPortfolioHealth.js` |
| **Earnings Watch** | Upcoming results dashboard. BEAT/INLINE/MISS predictions with confidence, 9-cell trading playbook, post-result T+1 plans. Open to every signed-in user. | `gated/earnings.js`, `services/earnings/*` (see CLAUDE.md for the 17-file breakdown) |
| **Risk Lab** | Per-stock risk decomposition: macro overlay, counter-thesis, quality scorer, consecutive-miss detector, imputation penalty. Hover tooltips for every term. | `gated/riskLab.js`, `services/riskLab/*` |
| **Macro Thesis** | India macro-regime classifier — **10 regimes** (Oil Shock, Rate Hike/Cut, War Escalation/De-escalation, Currency Weakness, Policy Stimulus, Regulatory Shock, Global Risk-Off, Calm) over 20 canonical sectors, LLM-classified (Gemini→Groq→heuristic), auto-refresh every 2h, plus a scenario engine + historical analogs. | `macroRegime.js`, `services/macroThesis/*`, `data/macroRegime.json` |
| **Track Record** | Public-facing performance log: every recommendation, when issued, what it returned vs Nifty. | `gated/index.html#trackTab`, `services/recommendationLedger.js` |
| **Watchlist** | User-curated list, persists in `.watchlist.json`. | `gated/app.js`, `.watchlist.json` |
| **News digest** (`news` tab) | Daily catalyst/news roundup with LLM-flagged disagreements. | `gated/app.js`, `services/catalystsService.js` |
| **Sector Outlook** (experimental) | Bottom-up SWS news themes × current macro regime. No named stock picks in v1. Visible to all signed-in users. | `gated/sectorOutlook.js`, `data/sectorOutlook/` |
| **5x Lab** (`multibagger`, personal-use) | Concentrated multibagger strategy (₹1L→₹5L/12m) with per-pick rationale + live pre-mortem. UI states a <10% base rate. | `gated/multibaggerLab.js`, `services/multibagger/`, `scripts/refresh-5x-strategy.mjs` |
| **Compounder Lab** (personal-use) | "Safe" sleeve — Marcellus-style quality screen, top-20 by upside, paper-traded. | `gated/compounderLab.js`, `services/compounder/`, `data/compounder/latest.json` |
| **Earnings Edge** (personal-use) | "Aggressive" sleeve — post-BEAT names through 5 KEC-post-mortem gates, paper-traded. Shares the compounder paper-trade harness. | `gated/earningsEdge.js`, `services/earningsEdge/`, `data/earnings-edge/latest.json` |

## Data pipelines (refresh cadences)

Every pipeline writes JSON under `data/` that Vercel reads — **Vercel never
originates data ingestion**, only serves what's been committed. NSE endpoints
in particular reject Vercel datacenter IPs, so cookie-gated NSE scrapes MUST
run from a local machine (see `nse.js:76-83` and CLAUDE.md).

| Pipeline | Cadence | Trigger | Output |
|---|---|---|---|
| **SWS nightly** (`scripts/sws-nightly.sh`) | Nightly via launchd | Local Mac | `data/sws/picks-latest.json` + per-stock deep briefs |
| **Macro regime** (`scripts/refresh-macro-regime.mjs`) | Every 2h via launchd | Local Mac | `data/macroRegime.json` |
| **Fundamentals history** (`scripts/refresh-fundamentals-history.mjs`) | Chained into sws-nightly, gated on 18h freshness | Local Mac | `data/fundamentalsHistory.json` |
| **Earnings calendar** (`scripts/refresh-catalysts.mjs` + `refresh-nse-corporate.mjs`) | Manual twice-daily | Local Mac | `data/catalysts/*.json` |
| **Earnings prediction** (`scripts/refresh-earnings.mjs`) | Manual after the two above | Local Mac | `data/catalysts/earnings-watch-latest.json` |
| **Earnings actuals** (`scripts/resolve-earnings-actuals.mjs`) | Manual post-result | Local Mac | Updates `data/catalysts/earnings-history/<date>.json` |
| **Earnings health** (`scripts/earnings-health-summary.mjs`) | Last step in sws-nightly | Local Mac | `data/catalysts/earnings-health.json` |
| **NSE F&O bhavcopy** (`services/foBhavcopyFetcher.js`) | On-demand via cron route | Vercel-safe (different endpoint, no cookie) | KV store |

## Backtesting

Every signal that ships should have a backtest harness. Conventions:

- **Earnings predictor**: `scripts/backtest-earnings-predictions.mjs`. V1 cap-lift
  gate (≥30 resolved, ≥55% bucket hit-rate, Brier <0.20) must clear before
  confidence caps lift. Gate state is in `data/catalysts/earnings-health.json`.
- **Weight tuning**: `scripts/tune-earnings-weights.mjs`. Never auto-edits
  predictor code — only recommends multiplier shifts.
- **SWS picks**: 9× backtest variants under `scripts/backtest-*.mjs`. These
  are **forks of the same logic**, not a shared library — propagating a fix
  means editing each one by hand.

## Auth model

- **Public routes:** `/`, `/healthz`, `/api/healthz`, `/login`, `/auth/google/*`.
- **Everything else:** session-gated. Reject without a Google OAuth session.
- **Admin tier (#395):** an `ADMIN_EMAILS` env allowlist + an in-handler
  `isAdmin` check. Gates `/api/admin/*` and the SWS write/refresh routes
  (`requireAdminForSwsRefresh`). US/KR/TW picks *reads* were opened from
  admin-only to any signed-in user (`requireSignedInRead`).
- **Personal tier:** `createPersonalUseGate` (`services/auth/personalUseGate.js`),
  an email allowlist gating the experimental sleeves (`/api/compounder/*`,
  `/api/earnings-edge/*`, `/api/multibagger/*`).
- ⚠️ **Auth is in flux** — the two-tier model has wobbled; a personal-use-gate
  reversal has been parked uncommitted on the working branch at points.
  Re-read `server.js` + `services/auth/` before changing auth. (See
  PROJECT_STATUS.md and ARCHITECTURE.md §5.)
- **Test bypass:** `AUTH_ENABLED=false` skips the session check. Used in
  local dev and Playwright. Don't ship a release with this set in prod env.
- **Rate limits:** `express-rate-limit`. `NODE_ENV=test` disables limits so
  e2e specs don't trip them.

## Production gotchas (read before changing anything load-bearing)

1. **`gated/app.js` is ~13,040 LOC.** Concurrent edits collide. Edit sequentially.
2. **NSE cookie-gated endpoints fail on Vercel.** Must run locally; commit the JSON.
3. **Vercel KV is dead — for the picks/fundamentals READ path** (ripped out in
   #195; reads come from disk JSON). It is *still* the user-scoped **write**
   store (user records, watchlist, portfolio, track snapshots) via
   `userStorage.js`. So "is KV wrong here?" depends on read vs write.
4. **SWS scrapes need a fresh JWT.** Hourly refresh; failures are silent.
   `sws-status` skill shows current pipeline state.
5. **Auto-refresh PRs land via GitHub Actions.** Macro regime and SWS picks
   each open their own PRs every few hours (`chore(macro): auto-refresh ...`).
   These are committing data, not code; don't be alarmed by the PR volume.
6. **The 9× backtest scripts diverge.** They're forks. Fixing one doesn't
   fix the others.
7. **`v3` names are V4 aliases, not leftovers.** After the V4 migration (#437),
   `signals.v3.*`, `top_ranked_30_v3`, `v3-universe-stats.json`,
   `loadV3Universe()`, and `v3SignalAdapter.js` were kept by design and now
   carry V4 data. **Don't blind find-replace `v3`→`v4`** — it's load-bearing
   churn. Only the prose comments calling v3 "coverage-gated" are stale.
8. **V4 verdicts are absolute cutoffs, not rank-based.** TOP_PICK ≥59 / STRONG
   ≥47 / ACCEPTABLE ≥37 / WATCH ≥28 / else AVOID — frozen 2026-05 India
   percentiles. No universe band is loaded at runtime.
9. **Regional deep briefs ship as tarballs.** `data/sws-{us,kr,tw}/deep-*.tar.gz`
   (#393) — thousands of per-stock files packed into one to stay under Vercel's
   ~15k source-file cap. Don't expect loose `deep/*.json` to be deployed.

## Where to look next

- **Deep design + architecture (the "how/why it's built"):** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — request lifecycle, V4 scoring internals, region registry, nightly chain, every subsystem, design trade-offs.
- **What's shipped + in flight:** [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)
- **Claude-specific multi-agent patterns:** [CLAUDE.md](CLAUDE.md)
- **Fundamentals data schema:** [FUNDAMENTALS_SCHEMA.md](FUNDAMENTALS_SCHEMA.md)
- **Historical QA passes:** [docs/qa-pass-2026-05-12.md](docs/qa-pass-2026-05-12.md)
- **SWS API pipeline notes:** [scripts/SWS_API_PIPELINE.md](scripts/SWS_API_PIPELINE.md)
- **Phase-3 / Phase-4 historical reports:** [PHASE3_GATE_REPORT.md](PHASE3_GATE_REPORT.md), [PHASE4_ROLLOUT.md](PHASE4_ROLLOUT.md)

## Conventions for AI assistants

- **Squash-merge** is the default. Conventional commit subjects: `<type>(<scope>): <description>`.
- **Small focused PRs.** Each PR adds 1–3 e2e specs when it changes a UI surface.
- **Test gate.** Don't push if `npm test` is red. Don't use `--no-verify` to skip pre-commit hooks.
- **Never create new planning docs in the repo.** Plans live elsewhere (in
  Claude's case, `~/.claude/plans/`). The only repo-level project context
  files are this one, [CLAUDE.md](CLAUDE.md), and
  [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md). Update those instead of
  spawning new `*_PLAN.md` files at the root.
- **Update [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)** when you ship a
  meaningful PR — that's the file the next assistant (or human reviewer)
  will read first.

---

_Last updated: 2026-05-25. Update this file when the stack, layout, or
major features change in a way that would mislead a fresh reader._
