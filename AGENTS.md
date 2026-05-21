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
**https://stock-platform-gamma.vercel.app** (the stable Vercel alias;
`starbhai.com` is a separate WordPress site and should not be linked).

## Stack

- **Runtime:** Node.js (ESM, `"type": "module"`). No TypeScript.
- **Server:** Express 4 (`server.js`, ~7,400 LOC, ~80 routes). Single process.
- **Frontend:** Vanilla JS SPA in `gated/` (`app.js` is a 11,700-LOC
  monolith — concurrent edits collide; touch it sequentially). No framework,
  no build step.
- **Database:** None. All persisted state is JSON files committed under
  `data/` (SWS scrape outputs, picks, catalysts, macro regime, fundamentals
  history, paper-trades, etc.). The repo had a Neon Postgres mirror via
  `services/swsDal/sqlBackend.js`; it was decommissioned on 2026-05-19 (see
  `~/.claude/plans/create-a-plan-to-precious-dongarra.md`). Reads now go
  through `services/swsDal/` over `jsonBackend` only.
- **Hosting:** Vercel (serverless via `api/index.js` → `server.js`). Free tier.
- **Auth:** Google OAuth (`google-auth-library`), session-gated on every
  route except a small public set. `AUTH_ENABLED=false` bypasses auth for
  local dev and Playwright tests.
- **Tests:** Node's built-in test runner for unit tests (~100 suites wired
  into `npm test`). Playwright for e2e (`npm run test:e2e`, port 4011 via
  `webServer` config). Both self-skip on missing fixtures.
- **AI keys (optional, all graceful-degrade):** Anthropic, OpenAI, Groq, Gemini.

## Repository layout

```
.
├── server.js               # Express app, ~80 routes, session-gated
├── gated/                  # SPA (vanilla JS), session-required
│   ├── index.html          # 5 top-level tabs: picks, analyzer, news, track, watchlist
│   ├── app.js              # 11.7K-LOC monolith — DO NOT parallelise edits
│   ├── earnings.js         # Earnings Watch tab logic
│   ├── riskLab.js          # Risk Lab tab logic
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
# Unit tests (~100 suites, ~30s):
npm test
# Playwright e2e (port 4011, builds fixture xlsx first):
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
| **SWS Picks** (`picks` tab) | Top-200 Indian large-caps scored on SWS's 6-pillar Snowflake + a 100-pt V3 breakdown. Sectioned by verdict (Top picks / Watchlist / Avoid). | `gated/swsV2Render.js`, `services/swsScoring.js`, `services/swsConvictionEngine.js` |
| **US Picks** (`usPicks` tab, admin-only — "More" dropdown) | SWS-sourced US-equity leaderboard (NASDAQ/NYSE/NYSEMKT ~5,448 liquid names). Same Snowflake + 100-pt V3, but USD ($). Fully isolated `data/sws-us/` fork — imports the India scorer, never edits it. Manual `/sws-refresh-us`; ships empty until scraped. | `scripts/sws-scoring-us.mjs`, `services/usPicksDal.js`, `server.js` (`/api/us-picks`), `gated/app.js` (renderUSPicks/renderUSModal) |
| **Portfolio Analyzer** (`analyzer` tab) | Upload portfolio xlsx → per-stock recommendation (KEEP/TRIM/SELL/TOP-UP) with SEBI-RA-style narrative, sized in ₹. Cooldown gate prevents duplicate trim flags. | `gated/app.js` (portfolio sections), `services/swsHoldingEngine.js`, `services/swsPortfolioHealth.js` |
| **Earnings Watch** | Upcoming results dashboard. BEAT/INLINE/MISS predictions with confidence, 9-cell trading playbook, post-result T+1 plans. Open to every signed-in user. | `gated/earnings.js`, `services/earnings/*` (see CLAUDE.md for the 17-file breakdown) |
| **Risk Lab** | Per-stock risk decomposition: macro overlay, counter-thesis, quality scorer, consecutive-miss detector, imputation penalty. Hover tooltips for every term. | `gated/riskLab.js`, `services/riskLab/*` |
| **Macro Thesis** | India macro-regime classifier (5 regimes × 4 components: rates / liquidity / FX / sentiment) with auto-refresh every 2h and historical analogs. | `services/macroThesis/*`, `data/macroRegime.json` |
| **Track Record** | Public-facing performance log: every recommendation, when issued, what it returned vs Nifty. | `gated/index.html#trackTab`, `services/recommendationLedger.js` |
| **Watchlist** | User-curated list, persists in `.watchlist.json`. | `gated/app.js`, `.watchlist.json` |
| **News digest** (`news` tab) | Daily catalyst/news roundup with LLM-flagged disagreements. | `gated/app.js`, `services/catalystsService.js` |

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
- **Admin routes:** none currently — every signed-in user sees the same data.
  (Per-user namespacing is on the roadmap; see PROJECT_STATUS.md.)
- **Test bypass:** `AUTH_ENABLED=false` skips the session check. Used in
  local dev and Playwright. Don't ship a release with this set in prod env.
- **Rate limits:** `express-rate-limit`. `NODE_ENV=test` disables limits so
  e2e specs don't trip them.

## Production gotchas (read before changing anything load-bearing)

1. **`gated/app.js` is 11,700 LOC.** Concurrent edits collide. Edit sequentially.
2. **NSE cookie-gated endpoints fail on Vercel.** Must run locally; commit the JSON.
3. **Vercel KV is dead.** Old code paths still reference it — the canonical
   reads now come from disk JSON. If you see KV in a recent refactor, it's
   probably wrong (see `fix(fundamentals): rip out dead Vercel KV path` #195).
4. **SWS scrapes need a fresh JWT.** Hourly refresh; failures are silent.
   `sws-status` skill shows current pipeline state.
5. **Auto-refresh PRs land via GitHub Actions.** Macro regime and SWS picks
   each open their own PRs every few hours (`chore(macro): auto-refresh ...`).
   These are committing data, not code; don't be alarmed by the PR volume.
6. **The 9× backtest scripts diverge.** They're forks. Fixing one doesn't
   fix the others.

## Where to look next

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

_Last updated: 2026-05-19. Update this file when the stack, layout, or
major features change in a way that would mislead a fresh reader._
