# ARCHITECTURE.md — stock-platform

Deep design + architecture reference. This is the "how and why it's built" companion to
the two lighter context files:

- **[AGENTS.md](../AGENTS.md)** — fast tool-agnostic overview (stack, layout, conventions). Start there if you're new.
- **[docs/PROJECT_STATUS.md](PROJECT_STATUS.md)** — living "what's shipped / in-flight" snapshot.
- **[CLAUDE.md](../CLAUDE.md)** — Claude-specific multi-agent working patterns.

This file goes deeper than AGENTS.md: the load-bearing design decisions, the request
lifecycle, the V4 scoring internals, the region-registry generalization, the nightly data
pipeline, every analytical subsystem, and the trade-offs behind each. Read it when you're
about to change something structural and want to understand what you'll break.

> **Last updated: 2026-05-24.** Refresh the relevant section when you change the stack,
> the scoring math, the pipeline sequence, the auth model, or add a subsystem.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Core architectural principles](#2-core-architectural-principles)
3. [Runtime topology](#3-runtime-topology)
4. [Request lifecycle & middleware stack](#4-request-lifecycle--middleware-stack)
5. [Auth & access model](#5-auth--access-model)
6. [HTTP API surface](#6-http-api-surface)
7. [Frontend architecture](#7-frontend-architecture)
8. [The SWS scoring engine (V4)](#8-the-sws-scoring-engine-v4)
9. [Multi-region picks & the region registry](#9-multi-region-picks--the-region-registry)
10. [Data ingestion pipelines](#10-data-ingestion-pipelines)
11. [Analytical subsystems](#11-analytical-subsystems)
12. [Data layout (`data/`)](#12-data-layout-data)
13. [Testing & CI](#13-testing--ci)
14. [Module dependency map](#14-module-dependency-map)
15. [Key design decisions & trade-offs](#15-key-design-decisions--trade-offs)
16. [Glossary](#16-glossary)

---

## 1. System overview

**stock-platform** (a.k.a. **starbhai**) is a single-tenant Indian equity research and
recommendation platform. It is **not a brokerage** — it never places a trade or moves money.
It ingests fundamentals from Simply Wall St (SWS), NSE, and Yahoo Finance; scores stocks on a
deterministic 100-point composite; generates SEBI-RA-style narratives; predicts earnings
reactions; classifies the macro regime; and backtests every signal before surfacing it.

The whole system is built around one unusual choice: **there is no database.** All persisted
state is JSON files committed under `data/`. Data is scraped/computed on a **local Mac** (because
NSE blocks datacenter IPs and the SWS scrape needs a logged-in browser session), committed to git,
and **Vercel serverless just serves the committed JSON.** Vercel never originates ingestion.

```mermaid
flowchart LR
  subgraph sources["External data sources"]
    SWS["Simply Wall St\n(GraphQL/REST + DOM)"]
    NSE["NSE\n(cookie-gated)"]
    YF["Yahoo Finance\n(quotes, EPS history)"]
    LLM["LLM providers\nGemini / Groq\n(optional)"]
  end

  subgraph local["Local Mac (launchd crons)"]
    SCRAPE["sws-nightly.sh\nscrape → score → refresh"]
    GITREPO["git repo\ndata/*.json"]
  end

  subgraph gh["GitHub"]
    MAIN["origin/main\n+ auto-refresh PRs"]
    GHA["GitHub Actions\nmacro backup, CI"]
  end

  subgraph vercel["Vercel (Node Lambda)"]
    API["api/index.js → server.js\n(Express, ~96 routes)"]
    STATIC["gated/ SPA"]
  end

  BROWSER["Browser\n(vanilla-JS SPA)"]

  SWS --> SCRAPE
  NSE --> SCRAPE
  YF --> SCRAPE
  LLM -.optional.-> SCRAPE
  SCRAPE --> GITREPO --> MAIN
  GHA --> MAIN
  MAIN --> API
  API --> STATIC
  STATIC --> BROWSER
  BROWSER -- "GET /api/*" --> API
  API -- "fs.readFileSync(data/*.json)" --> API
  YF -. "live quote enrichment\n(hot path)" .-> API
```

**One-line mental model:** *local scrapes commit JSON to git → Vercel reads JSON from disk and
serves a vanilla-JS SPA → the SPA fetches read-only JSON APIs, enriched with live Yahoo quotes.*

---

## 2. Core architectural principles

These are the decisions everything else hangs off. Violating them is how you break the platform.

1. **JSON-on-disk is the database.** No Postgres, no ORM. Reads are `fs.readFileSync` wrapped in
   in-process `NodeCache`. The repo *had* a Neon Postgres mirror (`services/swsDal/sqlBackend.js`);
   it was decommissioned (#345, 2026-05). Reads now go through `services/swsDal/` over the
   `jsonBackend` only. **If you see SQL/Neon code, it's dead.**

2. **Local ingestion → commit → Vercel serve.** NSE rejects Vercel datacenter IPs on its
   cookie-source endpoint (`nse.js:76-83`), and the SWS scrape needs a real browser session. So
   *every* cookie-gated scrape runs locally, writes JSON, and commits. Vercel `/api/cron/*` routes
   may flush in-process caches but must **never** originate NSE/SWS traffic.

3. **Graceful degradation — no keys required to run.** Anthropic / OpenAI / Groq / Gemini keys are
   all optional. Every LLM call falls back: a provider chain, then a deterministic keyword
   heuristic that never throws. The site renders fully with zero keys; keys only raise data fidelity
   during refreshes.

4. **The composite score is deterministic.** The SWS V4 score is pure arithmetic over scraped
   fields — no LLM in the scoring path. LLMs only produce *qualitative* side-signals (earnings
   bias, macro-regime label, risk-text agreement) that are surfaced separately, never folded into
   the headline score. This keeps the score reproducible and backtestable.

5. **Every signal is backtest-gated.** A signal doesn't get to lift confidence or size a position
   until its backtest clears an explicit gate (e.g. the earnings V1 cap-lift gate: ≥30 resolved,
   ≥55% bucket hit-rate, Brier <0.20). Until the gate clears, the signal ships at conservative caps.

6. **Test unproven ideas in isolation, never in-place.** New/experimental signals ship as **new
   files + new tabs** (US/KR/TW picks, Risk Lab, Sector Outlook, 5x Lab, Earnings Edge), importing
   the proven scorer rather than editing it. The India + US pipelines are explicitly *frozen*; KR/TW
   were added as registry config, not forks. This is why the codebase has many parallel tabs.

7. **Honest framing over hype.** Return/strategy surfaces carry base-rate + pre-mortem framing
   (e.g. 5x Lab states a <10% base rate in its own UI copy). Disclaimers live once, site-wide, in
   `#sebiSiteFooter` — don't duplicate them inline.

---

## 3. Runtime topology

| Environment | What runs | Entry point |
|---|---|---|
| **Vercel (prod)** | Express app as a Node.js **Lambda** (not Edge). Serves the SPA + read-only JSON APIs. | `api/index.js` (3 lines: `import app from "../server.js"; export default app;`) |
| **Local dev** | `node server.js` → `app.listen(PORT=3000)`. The `if (!process.env.VERCEL)` block runs NSE warmup + local macro refresh; never reached on Vercel. | `server.js` |
| **Local launchd crons** | The data pipelines (scrape, score, macro, earnings). See §10. | `scripts/sws-nightly.sh`, `scripts/refresh-macro-only.sh` |
| **GitHub Actions** | Backup macro refresh (heuristic-only, no secrets) + CI (smoke + unit + a modal-render e2e job). | `.github/workflows/*.yml` |

`vercel.json` bundles `gated/` and the regional `data/sws-*/deep-*.tar.gz` tarballs into the
function via `includeFiles` so static files and deep briefs are reachable inside the Lambda rather
than only from the CDN edge.

**Production URL:** `https://stock-platform-gamma.vercel.app` (stable Vercel alias). The latest
`stock-platform-<hash>-…vercel.app` deployment URL rotates per push. **`starbhai.com` is NOT this
platform** — it 301s to a separate WordPress site. Always link the `-gamma` alias.

---

## 4. Request lifecycle & middleware stack

The middleware order in `server.js` is canonical — re-ordering it breaks things (e.g. compression
must come first so the ~5 MB `/api/sws-picks` payload fits under Lambda's sync limit).

```
 1. compression()                      gzip everything first (5 MB picks JSON → <1 MB)
 2. NodeCache instances initialised    quote 60s, historical 300s, news 120s, search 300s,
                                        catalyst 7200s, portfolio 30s, analyzer 1800s, macro 7200s
 3. cors()                             allowlist: -gamma, localhost:3000/4011, preview regex
 4. helmet()                           CSP (unsafe-inline for ~28 onclick handlers), frameguard,
                                        HSTS, COOP same-origin-allow-popups (for OAuth popups)
 5. trust proxy = 1                    so rate-limiters see real X-Forwarded-For IPs
 6. requireApiKey  /api/portfolio      X-API-Key vs STARBHAI_API_KEY (no-op if env unset)
 7. requireApiKey  /api/watchlist      same
 8. stockDetailLimiter  /api/stock/    30 req/min, keyed by req.user.sub or IP
 9. auth routes (pre-gate)             /api/auth/google[/callback], /api/auth/me, /api/logout
10. SESSION GATE                       verify HMAC starbhai_session cookie → req.user={sub,ts}
                                        (exempt paths bypass — see §5)
11. apiLimiter  /api/                  60 req/min/user; skipped when NODE_ENV=test
12. express.static("gated/")           SPA files (gated so the CDN doesn't bypass Express)
13. express.static("public/")          login.html only (intentionally CDN-served, pre-session)
14. express.json()                     body parsing
15. route handlers                     ~96 route patterns (see §6)
```

A typical authenticated read:

```mermaid
sequenceDiagram
  participant B as Browser SPA
  participant L as Vercel Lambda
  participant M as Middleware chain
  participant H as Route handler
  participant D as services/swsDal
  participant FS as data/*.json (disk)
  participant Y as Yahoo Finance

  B->>L: GET /api/sws-picks (cookie)
  L->>M: api/index.js → app
  M->>M: compression, cors, helmet
  M->>M: session gate → req.user={sub,ts}
  M->>M: apiLimiter (60/min)
  M->>H: dispatch
  H->>D: getPicksLatest()
  D->>FS: fs.readFileSync(data/sws/picks-latest.json)
  FS-->>D: parsed rows (cached in NodeCache)
  D-->>H: pick rows (V4 scored)
  H->>Y: live-quote enrichment (cached 60s)
  Y-->>H: last price
  H-->>B: gzip(JSON)
  Note over B: loadPicks() → renderSWSPicksSection() → inject HTML
```

**Caching layers (two tiers):**
- *Server-side* `NodeCache` per concern (TTLs above). The `analyzerCache` (30 min) is keyed by the
  `sessionId` returned from `/api/portfolio/analyze`, so `/api/portfolio/optimize` reuses the ~30s
  enrichment pipeline instead of re-running it.
- *Client-side* module-level globals in the SPA (see §7) — these are a frequent source of "stale
  data" surprises.

**Write paths** (user records, watchlist, portfolio, track snapshots) go through `userStorage.js`,
which abstracts the backend: **`@vercel/kv`** in production, a local flat file (`users.json` /
equivalent) in dev. Note the nuance vs principle #1: Vercel KV is dead *for the picks/fundamentals
read path* (#195 ripped it out — reads come from disk JSON), but KV is still the **user-scoped write
store**. "KV is dead" is true only of the data-serving read path.

---

## 5. Auth & access model

`AUTH_ENABLED` is **true iff all four** env vars are set: `STARBHAI_SESSION_SECRET` (≥64 hex chars,
enforced at startup), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`. If any
is missing (local dev / Playwright), the session gate calls `next()` unconditionally — i.e.
`AUTH_ENABLED=false` is the *absence* of config, not a separate flag.

**Session token:** `base64url("sess:" + JSON.stringify({sub, ts})) + "." + sha256-hmac-hex`,
verified with `timingSafeEqual`, 30-day TTL. Cookie `starbhai_session; HttpOnly; SameSite=Lax;
Secure` (Secure on Vercel only). `SameSite=Lax` (not Strict) so Google's OAuth redirect-back keeps
the cookie.

**OAuth flow (PKCE):**
1. `GET /api/auth/google` → generate PKCE verifier/challenge + random `state` → sign both into a
   short-lived (`10 min`) `starbhai_oauth` cookie → redirect to Google consent.
2. `GET /api/auth/google/callback` → verify the `starbhai_oauth` cookie, match `state`, exchange
   `code` with the PKCE verifier, verify the ID token issuer + `email_verified`, upsert the user in
   `userStorage`, set `starbhai_session`, redirect to `returnTo`.

**Access tiers** (this area is in flux — verify in `server.js` before relying on it; see
PROJECT_STATUS):

| Tier | Mechanism | Gates |
|---|---|---|
| **Public** | session-gate exempt list | `/`, `/login.html`, `/healthz`, `/api/auth/*`, `/api/logout`, `/api/macro/regime/health`, all `/api/cron/*`, `/api/track/migrate` + `/api/track/snapshot-sws-now` (own `MACRO_OVERRIDE_TOKEN` gate) |
| **Signed-in** | session gate (any valid Google session) | Everything not listed elsewhere. India SWS Picks, Earnings Watch, Risk Lab, Macro, Sector Outlook, News, Track Record, Portfolio Analyzer. `requireSignedInRead` also guards US/KR/TW read routes (opened from admin-only in the parity work). |
| **Admin** | in-handler `isAdmin` check (reads user record); `ADMIN_EMAILS` env allowlist (#395) | `/api/admin/*`; SWS write/refresh routes via `requireAdminForSwsRefresh` (`/api/sws-refresh/*`, `/api/sws-scan/initial-start`). |
| **Personal** | `createPersonalUseGate` (`services/auth/personalUseGate.js`) — email allowlist | Experimental sleeves: `/api/compounder/*`, `/api/earnings-edge/*`, `/api/multibagger/*`. |

**Rate limiting:** `apiLimiter` (60/min) + `stockDetailLimiter` (30/min), key from
`services/apiLimiterKey.js` (`req.user.sub` → else IP). Both `skip` when `NODE_ENV=test` so the
Playwright harness doesn't trip them.

> **Auth is unsettled.** Two-tier auth shipped in #395 (`ADMIN_EMAILS` live allowlist) but the
> direction has wobbled (a personal-use-gate reversal has been parked uncommitted on the working
> branch at points). Treat the table above as "what the code on this branch currently does" and
> re-read `server.js` + `services/auth/` before changing auth.

---

## 6. HTTP API surface

~96 route patterns in `server.js`, grouped by feature. All are read-only JSON except the handful of
mutation routes noted. Backing modules in the right column.

| Feature area | Representative routes | Backing module(s) |
|---|---|---|
| **Auth** | `GET /api/auth/google[/callback]`, `GET /api/auth/me`, `POST /api/logout` | `google-auth-library`, `userStorage.js` |
| **Stock detail / search** | `GET /api/search`, `GET /api/stock/:symbol` | `stockList.js`, `analysis.js`, `fundamentals.js`, Yahoo chart API |
| **Market data** | `GET /api/market`, `/api/market-calendar`, `/api/market-verdict`, `/api/sector-heatmap`, `/api/fii-dii` | `nse.js`, `fundamentals.js`, `services/externalApiBreaker.js` |
| **News / catalysts** | `GET /api/news/market`, `GET /api/catalysts/today` | `stockNews.js`, `sentiment.js`, `services/catalystsService.js` |
| **Macro regime** | `GET /api/macro/regime`, `/api/macro/regime/health` (public), `/api/macro/override` (token) | `macroRegime.js`, `services/macroRegimeStorage.js` |
| **India SWS Picks** | `GET /api/sws-picks`, `/api/sws-universe`, `/api/sws-stock/:ticker`, `/api/sws-scan/status`, `/api/sws-pdf/latest` | `services/swsDal/`, `data/sws/` |
| **SWS refresh** (admin-write) | `POST /api/sws-refresh/{quick,earnings,full}`, `/api/sws-scan/initial-start` | writes `data/sws/refresh-requested.json`; launchd/skills pick it up |
| **US Picks** | `GET /api/us-picks`, `/api/us-stock/:ticker`, `/api/us-scan/status` | `services/usPicksDal.js`, `data/sws-us/` |
| **Korea Picks** | `GET /api/kr-picks`, `/api/kr-stock/:ticker`, `/api/kr-scan/status` | `services/regionPicksDal.js` (`makeRegionPicksDal("kr")`) |
| **Taiwan Picks** | `GET /api/tw-picks`, `/api/tw-stock/:ticker`, `/api/tw-scan/status` | `services/regionPicksDal.js` (`makeRegionPicksDal("tw")`) |
| **Portfolio Analyzer** | `POST /api/portfolio/analyze` (multer upload), `/analyze/rerun`, `GET /api/portfolio/stance/:symbol`, `POST /api/portfolio/optimize` | `swsPortfolioAggregate.js`, `swsHoldingEngine.js`, `portfolioIntelligence.js`, `xirrOptimizer.js` |
| **Portfolio (basic)** | `GET/POST /api/portfolio`, `GET/POST/DELETE /api/risk-profile` | `portfolioParser.js`, `userStorage.js` |
| **Earnings Watch** | `GET /api/earnings/upcoming[/stats]`, `/api/earnings/:symbol`, `/api/earnings/{calibration,backtest}`, `/api/audit/earnings/:symbol/:date` | `services/earnings/earningsWatchService.js`, `earningsHistoryArchive.js`, `hitRateSummary.js` |
| **Risk Lab** | `GET /api/risk-lab/{picks-adjusted,regime-context,quality-flags[/:ticker],macro-thesis}` | `services/riskLab/*`, `data/risk-lab/` |
| **Track record** | `GET /api/track/{history,stats,sections,calibration,export.csv}`, `POST /api/track/snapshot[-sws-now]`, `/api/track/migrate` | `paperTrades.js`, `services/trackRecord/*` |
| **Compounder Lab** (personal) | `GET /api/compounder/{latest,paper-trades}` | `services/compounder/compounderService.js` |
| **Earnings Edge** (personal) | `GET /api/earnings-edge/{latest,paper-trades}` | `services/earningsEdge/edgeService.js` |
| **5x / Multibagger Lab** (personal) | `GET /api/multibagger/{overview,candidates,portfolio}` | `services/multibagger/*` |
| **Sector Outlook** | `GET /api/sector-outlook/{latest,healthz}` | `data/sectorOutlook/outlook-latest.json` |
| **Surveillance / Governance** | `GET /api/surveillance/{status,list}`, `/api/governance/{status,:symbol}` | `surveillance.js`, `governance.js` |
| **F&O / OI** | `GET /api/fo/oi-screener` | `services/foScreener.js`, `services/foBhavcopyFetcher.js` |
| **Health / admin** | `GET /api/health`, `/healthz` (public), `/api/admin/users[/:sub/portfolio.xlsx]`, `/api/admin/combined-shadow-diff` | file-age checks, `userStorage.js`, `services/combinedScore.js` |
| **Cron / cache flush** | `GET /api/cron/{warm-caches,refresh-surveillance,refresh-governance,refresh-fo-oi,refresh-earnings}` | flush NodeCache only — **never** originate NSE traffic |
| **Misc / legal** | `POST /api/telemetry`, `/legal/grievance`, `/legal/charter`, `/methodology`, `/api/disclosures/holdings` | inline handlers, `gated/*.html` |

---

## 7. Frontend architecture

A **vanilla-JS SPA** with no framework and no build step. `gated/index.html` (~5,275 lines) is one
document embedding every tab panel as a hidden `<div>` (`display:none`, toggled by `switchTab()`).

**Script load order matters** (later scripts depend on globals from earlier ones):

| File | Loading | Role |
|---|---|---|
| `utils/formatIndianNumber.js` | sync | INR formatting |
| `glossary.js` | sync | term definitions |
| `app.js` | **sync, ~13,040 LOC** | the monolith — everything below isn't in a separate file |
| `swsV2Render.js` | sync | augments the SWS picks banner |
| `earnings.js` | defer | Earnings Watch IIFE → `loadEarningsWatch()` |
| `riskLab.js` | defer | Risk Lab IIFE → `loadRiskLab()` |
| `compounderLab.js` | defer | Compounder Lab IIFE → `loadCompounderLab()` |
| `earningsEdge.js` | defer | Earnings Edge IIFE → `loadEarningsEdge()` |
| `multibaggerLab.js` | defer | 5x Lab IIFE → `loadMultibaggerLab()` |
| `sectorOutlook.js` | defer | Sector Outlook IIFE → `loadSectorOutlook()` |
| `keyboard.js` | defer | WAI-ARIA roving-tab keyboard nav |

> **`gated/app.js` is a 13,040-LOC monolith — DO NOT parallelise edits to it.** Concurrent edits
> collide. Edit sequentially, one logical section per commit. Its major sections (marked by
> `// ===`): init+telemetry, auth header menu (`auth.init()` sets `window.__starbhai_isAdmin` /
> `__starbhai_isPersonal`), snapshot/LLM health banners, glossary tooltips, market data, search,
> stock detail, dashboard, tabs (`TAB_CONFIG` + `switchTab()` + `LABS_MENU_TABS` "More" dropdown),
> Users, Portfolio, Market News, Track Record, Watchlist, price chart, Portfolio Analyzer, SWS
> Picks, US Picks, the SWS deep-brief modal, the action-list modal, the universal stock modal, and
> the hash router (`#tab=<name>`).

**Tab visibility:** the tab bar has ~9 markup tabs; privileged tabs (US/KR/TW Picks, 5x Lab,
Compounder, Earnings Edge, Users) are `hidden` and unhidden on boot by `auth.init()` based on
`isAdmin`/`isPersonal`. They live behind a **"More" dropdown** (`LABS_MENU_TABS`, #361). Risk Lab and
Sector Outlook are visible but locally toggleable via `localStorage`.

**Client-side caches (the "why am I seeing stale data" list):**

| Cache | Where | TTL | Gotcha |
|---|---|---|---|
| `_analyzerCache` | `app.js` module-level | 60s | Shared across tab switches; a re-open within 60s re-renders the stale object. Nulled on upload/rerun error. |
| `_newsDigest` | `app.js` module-level | until next `loadMarketNews()` | Filter re-renders use the cached digest, not a fresh fetch. |
| `_earningsSnapshot` / `_earningsStats` | `earnings.js` IIFE | until next `loadEarningsWatch()` | Filter-bar re-renders don't re-fetch; Refresh button clears them. |
| `searchClientCache` | `Map`, FIFO, max 50 | session | Cross-tab; a stale query can persist until evicted by 50 newer queries. |

> **e2e note:** because these caches are module-level globals, Playwright specs that share
> `gotoApp()` state can race. Don't parallelise specs across the *same* tab. Picks-tab currency
> assertions must read `.sws-pick-card` `textContent` (not container `innerText`, which only sees
> accordion chrome).

---

## 8. The SWS scoring engine (V4)

This is the heart of the platform. As of #437 (merged to main, 2026-05), **V4 is the sole composite
score and V3 is deleted.**

- **Canonical math:** `services/swsScoringV4.js` (`computeV4Score`, `_fvCompositeV4`,
  `verdictV4FromScore`). `scripts/swsScoringV4.mjs` is a thin re-export so all four region scorers
  (India/US/KR/TW) and the server share identical arithmetic.
- **Version string:** `sws-v4-100pt-2026-05`.
- **Orchestrator:** `services/swsScoring.js#scoreStock` calls `computeV4Score`; it also still
  computes legacy V1/V2 fields for back-compat, builds the leaderboard, and categorises stocks.

### The 100-point composition

Input is `stock.overview.snowflake` — the SWS "Snowflake," 6 axes each rated 0–6. V4 uses **4 of
the 6** (Management isn't scraped; **Dividends was dropped in V4** — still shown in the UI's
Snowflake/30 total and the `dividend_aristocrats` category, but contributes **0** to the composite).

| Block | Max pts | How |
|---|---|---|
| **Pillars** | **76** | `health/6×22 + future/6×20 + valuation/6×18 + past/6×16` |
| **FV composite** | **12** | coverage-renormalised weighted avg of value sub-signals that are present |
| **Momentum** | **12** | `1Y_pctile×7 + 3M_pctile×3 + 1M_pctile×2` |
| **Risk overlay** | **−15 → 0** | penalties only (never positive) |
| **Final** | **0–100** | `clamp(round(pillars + fv + momentum + overlay, 1), 0, 100)` = `v4_score_100` |

**FV composite detail (`_fvCompositeV4`):** missing sub-signals are *excluded from both numerator
and denominator* (never imputed to zero):
- *Analyst upside* (weight 8): from `overview.upside_pct`, bucketed (≥30%→1.0, ≥15%→0.75, ≥0%→0.5,
  ≥−10%→0.25, else 0). **MAX-inflation haircut:** if `fair_value_inr ≈ fair_value_range.max` with
  ≤5 analysts, dock 0.25 buckets (guards against the analyst-range-max-as-consensus trap).
- *Relative P/E* (weight 4): `multiples.pe / industry_benchmarks.pe` (≤0.8→1.0, ≤1.2→0.5, else 0).
  Only ~9% universe coverage.
- Both absent → neutral **6/12** with `fv_imputed=true` (avoids structurally crushing
  no-coverage small-caps, a V3 failure mode).

**Momentum detail:** percentile ranks against sorted universe distributions in
`data/sws/v3-universe-stats.json` (loaded via `loadV3Universe()` / `dal.getV3UniverseStats()`).
Missing universe → imputed 50th percentile.

**Risk overlay:** NSE GSM −15, ASM-short −12, ASM-long −10; falling-knife (1M < −25% AND health ≤
2/6) −5; catalyst-chase (1M > +30% AND valuation ≤ 2/6) −3; **V4-only value-trap brake** (3M < −20%
AND health ≤ 3/6 AND valuation ≥ 4/6) −4 (skipped if falling-knife already fired).

### Verdicts are ABSOLUTE, not rank-based

This is the central V4 design change. Cutoffs are **frozen percentile snapshots** of the 2026-05
India universe — no runtime band-loading:

| Verdict | Score | ≈ India percentile |
|---|---|---|
| `TOP_PICK` | ≥ 59 | ~92nd |
| `STRONG` | ≥ 47 | ~75th |
| `ACCEPTABLE` | ≥ 37 | ~50th (median) |
| `WATCH` | ≥ 28 | ~25th |
| `AVOID` | < 28 | — |

Why absolute: the holding engine, on-demand `/api/sws-stock`, and `categoriseStock` never load
universe bands. Under the old rank-based scheme they'd silently return null and collapse the action
ladder. (V4 scores run *lower* than V3 — median ≈ 37 — so every downstream gate was remapped.)

**Action ladder (`swsHoldingEngine.js#scoreBandAction`, exact `<` cutoffs — scores round to 1
decimal):** `<18` EXIT · `<28` Reduction-50% · `<37` Reduction-25–33% · `<47` HOLD · `<53`
Top-up-modest · `<59` Top-up · `≥59` STRONG Top-up (top-ups gated on position-weight /
sector-weight / upside guards). The Portfolio Analyzer
(`computeRecommendationV2`) layers hard overrides + a liquidity-tier gate on top of this.

### The retained "v3" names are aliases — they carry V4 data

When you grep, you'll find `v3` everywhere. **This is intentional, not a leftover algorithm.** The
migration kept the field/bus names to avoid churn; they now carry V4 values:

| Surviving name | Reality |
|---|---|
| `signals.v3.{v3_score_100,v3_verdict,v3_breakdown}` (earnings bus) | V4 data; `v3SignalAdapter.js` reads `row.v4_breakdown`/`row.v4_score_100` and returns them under `v3_*` keys |
| `top_ranked_30_v3` (picks-latest section key) | V4-scored rows |
| `data/sws/v3-universe-stats.json` (+ regional) | filename unchanged; holds `{r1m,r3m,r1y}` arrays for **momentum percentiles only** (no longer used for verdicts) |
| `loadV3Universe()` | back-compat alias → `dal.getV3UniverseStats()` |
| `PREDICTOR_VERSION = "earnings-predict-v3-2026-05"` | predictor now runs on V4 inputs |
| `services/trackRecord/calibration.js` V3 anchor table | scores *historical* pre-migration trades only; returns `null` for V4 trades (honest "no estimate yet") |

> **Do not blindly rename `v3`→`v4`.** These are live, load-bearing aliases. Renaming is pure churn
> and risks breaking the earnings bus. Only the *prose* comments calling v3 "the 50%-coverage-gated
> scorecard" are stale.

### Honest caveat (design rationale)

V4's 4-year look-ahead backtest **trails V3** (XIRR ~58% vs 66%, Sharpe ~1.75 vs 2.05). It shipped
anyway because V4 adopts a cleaner relative-FV-upside model and fixes structural V3 failure modes
(coverage compression, the absent-FV trap). **Post-migration weight tuning is the stated path to
recover the gap** — the score is deliberately tunable via `sws-backtest-weight-sweep.mjs` rather
than frozen. The migration also incidentally fixed three latent bugs (a `swsScoring` ReferenceError
on every AVOID stock, a `swsSectorFit` crash in the Analyzer's Sector Gap Spotlight, an empty
multibagger `catalystComposite` stream) and a follow-up (#438) fixed a stock-modal crash from a
leftover `hasV3` reference; #439 added a CI modal-render e2e job to catch such regressions.

---

## 9. Multi-region picks & the region registry

There are four equity-picks markets: **India** (primary), **US**, **Korea**, **Taiwan**. The design
history is a deliberate two-step:

1. **US was a hard fork** (#379/#386). New `data/sws-us/` namespace; US scorer/parser **import** the
   India ones, never edit them; cloned `$`-currency render path.
2. **KR + TW were added via a region registry** (#383) instead of two more forks.

### The registry (`scripts/sws-regions.mjs` + `sws-config-region.mjs`)

`sws-regions.mjs` exports a `REGIONS` map keyed by 2-letter code (`in`/`us`/`kr`/`tw`). Each entry
carries every region-varying fact:

- `sitemapRegion`, `sitemapShardCount`, `sitemapShardUrl(i)` — how to crawl SWS's public sitemap into `universe.json`
- `exchangeTokens`, `excludedExchangeTokens`, `exchangePriority` — which SWS exchange tokens make the market (e.g. KR = `["kose","kosdaq"]`)
- `tickerKey(exch, id)` — the canonical dotted ticker. India/US = bare uppercased ids. **KR** strips SWS's `a`-prefix (`kose-a005930` → `005930.KS`/`.KQ`/`.KN`). **TW** appends `.TW`/`.TWO`. This keeps every key non-pure-numeric so it survives the India BSE filters and matches Yahoo's format.
- `currencyIso`, `currencySymbol`, `currencyDecimals` — stamped on every pick for UI formatting (₹/$/₩/NT$)
- `mcapFloorNative`, `smallcapCeilingNative` — in local currency
- `dataDir`, `profilePrefix`, `routePrefix`, `tabId`, `domPrefix` — namespacing knobs
- `applyBseFilter`, `surveillanceEnabled`, `nseCalendar` — India-only flags, off for KR/TW

`makeRegionConfig(code)` (in `sws-config-region.mjs`) constructs the region's `PATHS`/`UNIVERSE`,
then spreads in India's region-agnostic knobs (timing, rate caps, human-fingerprint, panic signals).

**Crucial:** India + US are **frozen forks**, NOT registry-driven in production (their `REGIONS`
entries are reference-only). **KR + TW are fully registry-driven** — `sws-api-scrape-region.mjs`,
`sws-api-parser-region.mjs`, `sws-scoring-region.mjs`, `sws-refresh-region.sh` are code-identical
across both regions, parameterised by `--region`. The server side mirrors this:
`registerRegionPicksRoutes` factory + `makeRegionPicksDal(code)` + a generic `renderRegionPicks` path
in `app.js`.

**Co-run guard (`sws-corun-guard.sh`):** all four regions share **one SWS account** and one
`cf_clearance` cookie. Running two scrapes concurrently doubles ban exposure and contends on the
Chrome profile lock. India's `sws-refresh-api.sh`, US's `sws-refresh-us.sh`, and the region shells
all source the guard and abort (exit 5) if another market's scraper is live.

**Tarball packing:** each region's `deep/*.json` (thousands of files) is packed into a single
`deep-<code>.tar.gz` for Vercel serving — avoids the platform's ~15k source-file cap (#393).

Markets ship **empty** until scraped. Refresh is manual: `/sws-refresh-kr`, `/sws-refresh-tw`,
`/sws-refresh-us` (skills). Narrate/PDF deferred for non-India regions.

---

## 10. Data ingestion pipelines

**Everything that touches NSE/SWS runs on the local Mac, writes JSON, and commits.** Vercel serves.

### The nightly chain (`scripts/sws-nightly.sh`)

launchd (`com.starbhai.sws-nightly.plist`) fires it twice daily — **02:00 IST** (pre-market) and
**16:30 IST** (post-close). Logs to `data/sws/sws-nightly.log`. Ordered steps (✗ = fatal):

| # | Step | Script | Writes | Gate / timeout |
|---|---|---|---|---|
| 1✗ | Pre-flight | panic-flag, battery, `ping 8.8.8.8` | — | exit 3/4/5 |
| 2✗ | Git sync | `git fetch` + `checkout -B sws-nightly-base origin/main` + autostash | — | exit 5 |
| 3✗ | SWS scrape + score | `sws-refresh-api.sh` (`SWS_AUTO_PR=0`) | `data/sws/{deep/*,picks-latest,last-refresh,sws-scored-universe,v3-universe-stats}.json` | ~1h |
| 3b | News | `sws-news-scrape.mjs` | `data/sws/deep/<T>.json#news[]`, `news-latest.json` | — |
| 3c | Catalysts batch | `refresh-catalysts` · `refresh-nse-corporate` · `refresh-dividends` · `refresh-nse-index-constituents` · `refresh-fo-oi` · `sws-universe-from-sitemap --merge` · macro-freshness check · `refresh-fundamentals` · `refresh-surveillance` · `refresh-governance` | `data/catalysts/*`, `data/nse-fo/oi-deltas-latest.json`, `fundamentals.json`, `surveillance.json`, `governance.json`, universe files | 8h/144h/264h gates; per-step timeouts |
| 3d | Fundamentals history | `refresh-fundamentals-history.mjs` (Yahoo per-quarter EPS) | `fundamentalsHistory.json` | **18h gate**, 2400s |
| 3e | Earnings Watch | `refresh-earnings.mjs` | `earnings-watch-latest.json`, `earnings-watch-stats.json`, `llm-signal-cache.json`, `earnings-history/<date>.json` | 600s |
| 9 | Resolve actuals | `resolve-earnings-actuals.mjs` | `earnings-history/<date>.json#actual_*` | 300s |
| 9a | 5x strategy | `refresh-5x-strategy.mjs` | `data/strategy/multibagger-*.json` | 120s |
| 9b | Risk Lab | `refresh-risk-lab.mjs` | `data/risk-lab/picks-adjusted-latest.json` | 60s |
| 9b2 | Promoter txns (PIT 7(2)) | `refresh-promoter-transactions.mjs` | `data/promoter-transactions/rolling-30d.json` | 120s |
| 9c | Compounder Lab | `refresh-compounder.mjs` | `data/compounder/latest.json` | 120s |
| 9d | Earnings Edge | `refresh-earnings-edge.mjs` | `data/earnings-edge/latest.json` | 120s |
| 9d2/3 | Sector news + outlook | `refresh-sector-news-themes` · `refresh-sector-outlook` | `data/sectorOutlook/*` | 900s (≤400 LLM calls) |
| 9e | Paper-trade reconcile | `paper-trade-reconcile.mjs` | `data/paper-trades-reports/` | 60s |
| 4✗ | Sanity gate | `sws-sanity-gate.mjs` | `data/sws/_sanity/_latest.json` | exit 7 → data-only PR |
| 4b | Coverage drift | `coverage-gap-analysis.mjs --refresh-sme` | `data/coverage/*` | — |
| 5✗ | Commit + push | branch `chore/sws-auto-refresh-<date>-<time>` | — | exit 8 |
| 6✗ | PR + auto-merge | `gh pr create` + `gh pr merge --squash --auto` | — | merges after CI green |

Non-fatal steps log a warning and continue. If the sanity gate fails, SWS picks are held back but
the auxiliary refreshes still ship in a `chore(data): non-SWS refresh …` PR.

**`data/macroRegime.json` is a single-writer exception** — deliberately excluded from the nightly
commit. Its only writers are the standalone `com.starbhai.macro-only` launchd job (every 2h IST) and
the `refresh-macro-regime.yml` GitHub Actions backup (every 4h, heuristic-only). #402 extended this
single-writer rule to `data/macro-headlines/` + `data/macroRegime-history/`.

### Scrape mechanics

- **API scraper** (`sws-api-scrape*.mjs`, current prod path): hits SWS's GraphQL/REST directly,
  ~1h for ~5,500 stocks. The legacy **DOM scraper** (Playwright) took 3+ days.
- **Sharding:** each region's `universe.json` splits by `index % 3` into 3 independent Node
  processes, spawned with a 15s stagger. Per-shard progress persists to `progress-api-<N>.json`
  after every stock → resumable with `SWS_RESUME=1`; up to `SHARD_MAX_RETRIES` (default 2) auto-retries.

### Refresh cadences

| Job | Schedule | Runs |
|---|---|---|
| `com.starbhai.sws-nightly` (launchd) | 02:00 + 16:30 IST | full pipeline above |
| `com.starbhai.macro-only` (launchd) | every 2h IST | `data/macroRegime.json` only |
| `refresh-macro-regime.yml` (GH Actions) | every 4h | heuristic-only backup macro PR (`automation/macro-backup`) |
| `ci.yml` (GH Actions) | on push/PR | smoke + unit + modal-render e2e |

**Auto-refresh PRs flood the repo** — `chore(macro): auto-refresh …` and `chore(sws): auto-refresh
…` open every few hours. They commit data, not code; don't be alarmed by the volume.

There are ~18 `refresh-*.mjs` scripts and ~20 `backtest-*.mjs` scripts; **9 of the backtests are
concentration/horizon forks** (`backtest-top{1,2,3,5}-3yr`, `backtest-concentration-{1,5,10}yr`,
etc.) — forks of one logic, propagate fixes by hand.

---

## 11. Analytical subsystems

### 11.1 Earnings predictor (`services/earnings/*`)

The most complex subsystem. Flow:

```
earningsCalendarBuilder.buildCalendar(events-latest.json)   → IST-dated, deduped, fiscal_quarter-tagged events
  → signalAggregator.aggregateSignals(event, ctx)           → joins SWS deep + V4 breakdown (via v3SignalAdapter)
                                                               + fundamentalsHistory (EPS YoY) + announcements + deals
  → earningsLlmBatcher.batchLlmSignals(events)              → only if V4 score ≥ 47 (floor); else heuristic
                                                               Gemini → Groq → keyword heuristic; hash-cached
  → earningsPredictor.predictCalendar(events)               → 11 component scorers (below) → BEAT/INLINE/MISS + confidence
  → priceBandBuilder (±15% Bull/Base/Bear)
  → earningsRationaleNarrator (3-paragraph deterministic)
  → reactionPlaybook (9-cell verdict × guidance matrix)
  → earningsHistoryArchive.archivePredictions             → data/catalysts/earnings-history/<date>.json (schema v4)
  → earningsHealth.buildHealthSummary                      → data/catalysts/earnings-health.json
```

**11 component scorers** (each returns `{pts, why}`): V4 future+past (±18), V4 valuation (±8), V4
risk overlay (0→−10), pre-result run-up (±15), sector momentum (±10), EPS YoY trajectory (±15),
FV-upside fallback (±8), last-quarter echo (±4), NSE announcements (±10), bulk/block deal flow (±7),
LLM qualitative signal (±10), missing-data penalty (0→−6). Final `score_100 = clamp(50 + Σ, 0, 100)`;
thresholds (frozen): MISS `<34`, BEAT `≥56`, else INLINE; confidence capped 50–65% (V1).

**Backtest loop:** `actualsIngester.js` resolves `actual_*` (SWS news primary, Yahoo fallback,
keyed to fiscal-quarter end to dodge IST/EST off-by-one). `backtest-earnings-predictions.mjs` reports
hit-rate / Brier / the **V1 cap-lift gate** (≥30 resolved + ≥55% bucket hit-rate + Brier <0.20, on
the latest predictor version only). `weightTuner.js` does a multiplier sweep with walk-forward CV
but **never edits the predictor** — it only recommends, and refuses until a stricter gate (≥80
resolved, ≥2 quarters, ≥5 sectors × ≥10 events). LLM untrusted-text passes through
`llmPromptHardener.js` (sanitise + delimiter-wrap).

### 11.2 Risk Lab (`services/riskLab/*`)

`labOrchestrator.buildLabPayload(picks, regime)` runs two independent, defensive lenses per stock,
writing `data/risk-lab/{picks-adjusted,quality-flags}-latest.json`:

- **Macro lens** (`macro/adjustedScorer.js`): stock sector → regime impact (`sectorTemplates.js`);
  multi-sector stocks take worst case; soft delta `impact×2.5×(severity/3)×confidence×0.5` capped
  ±5; **hard veto** when `severity≥4 AND worst_impact≤−3 AND verdict==TOP_PICK`; stale regime
  (>12h) treated as CALM (zero adjustment).
- **Quality lens** (`quality/qualityScorer.js`): 5 null-safe sub-scorers —
  `consecutiveMissDetector` (prior-Q miss regex over `news[]`), `imputationPenalty`
  (`fv_imputed`/`momentum_imputed`), `riskTextClassifier` (`risks[]` vs debt/governance/fraud
  taxonomy), `counterThesisParser` (falsification triggers), `sectorQualityOverlay`. 0 flags = HIGH,
  1–2 = MEDIUM, 3+ = LOW; veto → `QUALITY_HOLD`.

Earnings Watch consumes this read-only via `earningsLabView.js` (attaches `lab_view` to each event).

### 11.3 Macro Thesis (`macroRegime.js` + `services/macroThesis/*`)

`macroRegime.js` classifies into **10 regimes** (WAR_ESCALATION/DE_ESCALATION, OIL_SHOCK,
RATE_HIKE/CUT, CURRENCY_WEAKNESS, POLICY_STIMULUS, REGULATORY_SHOCK, GLOBAL_RISK_OFF, CALM) over **20
canonical sectors**, via Gemini → Groq → keyword-heuristic. Each regime has hardcoded
`sectorImpacts[]` (−4…+4). Output: `data/macroRegime.json`.

`thesisOrchestrator.js` builds the thesis package: current regime + `daysInState` → catalyst
proximity → `scenarioProbabilityEngine` (4 branches: continue/escalate/de-escalate/new-shock, base
probs modulated by severity+daysInState+catalyst, normalised to 1.0) → `historicalAnalogFinder`
(joins live history + backfill seeds → forward-return distributions at +7/14/30/60d, warns when
n<3) → per-branch sector beneficiary/loser ranking → SEBI Reg-16 caveats (n_analogs, indeterminate
flags, 10%-per-thesis cap).

### 11.4 Portfolio Analyzer (`services/swsHoldingEngine.js`, `swsPortfolioHealth.js`)

Upload XLSX (ticker/qty/avgPrice) → per holding: `scoreStock` (V4) → `evaluateHardOverrides`
(GSM=EXIT, position >35%=Reduction-50%, severe FV downside, 2-of-4 weakness stack) → crosscheck +
catalyst + Indian-risk + last-earnings + peer-substitute + audit-trail → `computeRecommendationV2`
(action ladder) → `gateActionByTier` (liquidity gate). **Portfolio Health Score**
(`swsPortfolioHealth.js`): 7 earned-points components (Quality 25 / Valuation 15 / Diversification
15 / Concentration 10 / Risk 15 / Loss-control 10 / Macro 10), HHI for sector diversification, hard
caps for severe concentration/surveillance/pledge, grades A (≥85) → E (<40).

**Dividends to capture** (`services/dividends/swsDividendsExtractor.js` +
`services/portfolio/portfolioDividendService.js`): zero-network — walks `data/sws/deep/*.json` for
`news[].keyDevTypeId ∈ {45,46,47}`, regex-parses DPS/exDate/recordDate/payDate from templated SWS
bodies, joins to holdings, computes hold-by date / ₹ payout / yield-on-cost. Refresh:
`scripts/refresh-dividends.mjs` → `data/catalysts/dividends-upcoming.json`.

### 11.5 Compounder Lab + Earnings Edge (two-sleeve paper-trade book, #337)

Experimental sleeves, personal-use-gated, with a shared paper-trade harness — isolated from the main
picks so their hit-rate is judged separately before any promotion.

- **Compounder Lab (safe sleeve, `services/compounder/`):** Marcellus-style quality screen
  (Snowflake `past≥5`, `health≥4`, `dividend≥4`, mcap ≥ ₹500Cr, no debt/dilution keywords, valid FV)
  → top 20 by upside. Trim signal: HOLD / TRIM_50 / EXIT.
- **Earnings Edge (aggressive sleeve, `services/earningsEdge/`):** requires `actual_verdict==BEAT`,
  then 5 on-disk gates **derived from the KEC false-positive post-mortem** (prior-Q-miss regex,
  `fv_imputed` haircut, forbidden debt keywords, problem-sector watchlist, health/mcap floor).
  Position 0.25% of ADV proxy, ≤ ₹1L/trade, 30-day hold, −8% trailing / −12% hard stop.
- **Harness (`services/compounder/paperTradeLog.js`):** append-only ledger
  `data/paper-trades/<strategy>.json`, idempotent `openTrade` on `(ticker, entry_date)`, atomic
  writes. Strategies must clear a walk-forward gate before being granted real capital.

> No insider scraper exists on disk yet — SWS capture has `is_insider`/`insider_ownership_pct` null
> universe-wide. The NSE PIT 7(2) promoter-transaction feed (`refresh-promoter-transactions.mjs` →
> `data/promoter-transactions/rolling-30d.json`) is the closest signal and feeds Earnings Edge's
> promoter-sell veto.

---

## 12. Data layout (`data/`)

| Path | Holds | Serves |
|---|---|---|
| `data/sws/` | India `picks-latest`, `sws-scored-universe`, `v3-universe-stats`, `deep/*` (~5.5k), `deep.tar.gz`, `universe*`, `news-latest`, `_sanity/` | India Picks (primary) |
| `data/sws-us/` · `data/sws-kr/` · `data/sws-tw/` | per-region `picks-latest`, `deep/*`, `deep-<code>.tar.gz`, `universe`, `<code>-index-constituents` | US / KR / TW Picks |
| `data/catalysts/` | `events-latest`, `nse-announcements-rolling`, `nse-bulk-block-rolling`, `earnings-watch-latest`+`-stats`, `earnings-history/<date>`, `llm-signal-cache`, `dividends-upcoming`, `earnings-health`, `predictor-weights-v1` | Earnings Watch, dividends |
| `data/macroRegime.json` | current regime + severity + provider + `generatedAt` | macro banner (all tabs) |
| `data/macro-headlines/`, `data/macroRegime-history/` | headline archive, regime snapshots | macro history (single-writer) |
| `data/risk-lab/` | `picks-adjusted-latest`, `quality-flags-latest`, `macro-thesis-latest` | Risk Lab |
| `data/strategy/` | `multibagger-scores-latest`, `catalyst-slate-latest`, `multibagger-health-latest` | 5x Lab |
| `data/sectorOutlook/` | `outlook-latest`, `classified-news/*.jsonl`, `llm-theme-cache` | Sector Outlook |
| `data/compounder/`, `data/earnings-edge/` | `latest.json` baskets | Compounder / Earnings Edge |
| `data/paper-trades/`, `data/paper-trades-reports/` | per-sleeve ledgers + mark-to-market reports | paper-trade tracking |
| `data/promoter-transactions/` | `rolling-30d.json` (PIT 7(2)) | Earnings Edge veto |
| `data/nse-fo/` | `oi-deltas-latest`, `bhavcopy/`, `history/<T>` | F&O OI screener |
| `data/coverage/` | coverage-gap audit, ground truth, SME/Emerge | universe coverage QA |
| `fundamentals.json`, `fundamentalsHistory.json`, `surveillance.json`, `governance.json` (repo root) | NSE fundamentals, Yahoo quarterly EPS, ASM/GSM, shareholding | stock modals, predictor trajectory, risk flags |

---

## 13. Testing & CI

- **Unit:** Node's built-in test runner. **153** `test/*.test.mjs` files on disk; `npm test` runs a
  long `&&`-chained list (no glob) + 2 bash tests + 2 scripts-level tests. Self-skip on missing
  fixtures.
  > ⚠️ **Known breakage:** `npm test` references `test/adminGate.test.mjs`, which no longer exists
  > (renamed to `test/personalUseGate.test.mjs`). The `&&` chain fails at that link until the path is
  > corrected in `package.json`.
- **E2E:** Playwright, **100** specs in `test/e2e/`. `npm run test:e2e` pre-builds the analyzer XLSX
  fixture + US/KR/TW picks fixtures, runs on **port 4011** via `webServer`, with `AUTH_ENABLED=false`
  and `NODE_ENV=test` (rate-limits off). Specs self-skip when data preconditions (admin auth, live
  prices, populated paper-trades) aren't met. Spec *ordering* matters where module-level SPA caches
  are shared (see §7).
- **Smoke:** `npm run smoke` → `scripts/smoke-imports.mjs` (ESM-resolution check, no assertions).
- **CI (`ci.yml`):** smoke + unit + a modal-render e2e job (#439, added to catch
  `renderSwsModalCore` regressions after the V4 modal-crash fix #438).
- **Backtests** double as offline correctness gates for every signal (see §10, §11).

---

## 14. Module dependency map

Layers depend downward only. Scripts and the server both read services; services read `data/`; the
SPA only talks to the server's JSON API.

```mermaid
flowchart TD
  subgraph client["Browser SPA (gated/)"]
    APPJS["app.js + tab IIFEs"]
  end
  subgraph server["server.js (Express)"]
    ROUTES["~96 routes + middleware"]
  end
  subgraph svc["services/"]
    SCORE["swsScoringV4.js\n(canonical score)"]
    DAL["swsDal / usPicksDal / regionPicksDal"]
    EARN["earnings/*"]
    RISK["riskLab/*"]
    MACRO["macroThesis/* + macroRegime.js"]
    PORT["swsHoldingEngine / swsPortfolioHealth / dividends"]
    SLEEVE["compounder/* + earningsEdge/*"]
  end
  subgraph scripts["scripts/ (local crons)"]
    NIGHTLY["sws-nightly.sh"]
    REGIONS["sws-regions.mjs + sws-config-region.mjs"]
    REFRESH["refresh-*.mjs"]
    BT["backtest-*.mjs"]
  end
  DATA[("data/*.json\n(the 'database')")]

  APPJS -->|fetch /api/*| ROUTES
  ROUTES --> DAL
  ROUTES --> EARN
  ROUTES --> RISK
  ROUTES --> PORT
  ROUTES --> SLEEVE
  DAL --> DATA
  EARN --> SCORE
  EARN --> DATA
  RISK --> SCORE
  RISK --> MACRO
  PORT --> SCORE
  PORT --> DAL
  SLEEVE --> SCORE
  SCORE -.imported by.-> REGIONS
  NIGHTLY --> REFRESH
  NIGHTLY --> REGIONS
  REFRESH --> SCORE
  REFRESH -->|writes| DATA
  REGIONS -->|writes| DATA
  BT --> DATA
```

**The choke point is `services/swsScoringV4.js`** — server, scripts, all four regions, the earnings
predictor, Risk Lab, the portfolio engine, and the sleeves all funnel through it. Change it and
re-run the V4 unit tests (`test/swsScoringV4.test.mjs`, `test/actionLadder.v4.test.mjs`) plus the
region/backtest paths.

---

## 15. Key design decisions & trade-offs

| Decision | Rationale | Trade-off you live with |
|---|---|---|
| **JSON-on-disk, no DB** | Free Vercel tier; git is the audit log; trivial local edits | 5 MB picks payload needs gzip; "writes" are commits; concurrent cron+session writers can collide (use a worktree for risky changes) |
| **Local scrape → commit → Vercel serve** | NSE blocks datacenter IPs; SWS needs a browser session | Data freshness depends on the Mac being awake; auto-refresh PR noise |
| **Deterministic composite score; LLMs only for side-signals** | Reproducible, backtestable, no API dependency for the headline number | LLM nuance never reaches the score; qualitative signals live in separate surfaces |
| **V4 absolute verdict cutoffs (not rank-based)** | On-demand/holding paths don't load universe bands → no silent null collapse | Cutoffs are frozen 2026-05 India percentiles; universe drift isn't auto-recalibrated |
| **Shipped V4 despite a lower backtest than V3** | Cleaner relative-FV model, fixes coverage/absent-FV traps, tunable | Live XIRR/Sharpe gap until weight tuning recovers it |
| **Kept `v3` field/bus names as V4 aliases** | Renaming 80+ files is pure churn and risks the earnings bus | Grep is misleading; future readers must know the names lie |
| **US = fork, KR/TW = registry** | US proved the shape; registry avoids fork #3/#4; India+US frozen for regression safety | Two code paths (fork vs registry) for the same concept |
| **Experimental signals as new tabs/files** | Validate hit-rate in isolation before touching the proven scorer | Tab sprawl; ~13k-LOC app.js monolith |
| **One shared SWS account + co-run guard** | One subscription; guard prevents ban | Scrapes are serialised across regions — no parallel market refresh |
| **Backtest-gated confidence** | Don't oversell an unproven signal | Earnings confidence capped 50–65% until the gate clears (months) |

---

## 16. Glossary

- **SWS** — Simply Wall St, the upstream fundamentals provider (scraped, not API-partnered).
- **Snowflake** — SWS's 6-axis 0–6 rating (Value, Future, Past, Health, Dividend, Management). V4
  scores 4 of the 6.
- **V4** — the current 100-pt composite score (`swsScoringV4.js`, `sws-v4-100pt-2026-05`). Replaced
  V3 in #437. Pillars 76 + FV 12 + momentum 12 − overlay ≤15.
- **FV** — fair value. `upside_pct` = (FV − price)/price. Beware: `fair_value_inr` is sometimes the
  analyst-range *max*, not consensus — V4 applies a haircut; cross-check the deep brief.
- **Verdict** — TOP_PICK / STRONG / ACCEPTABLE / WATCH / AVOID, by absolute V4 cutoff.
- **Action ladder** — EXIT → Reduction → HOLD → Top-up → STRONG Top-up, keyed to V4 score bands.
- **Cap-lift gate** — the bar an earnings backtest must clear before confidence caps rise (≥30
  resolved, ≥55% bucket hit-rate, Brier <0.20).
- **Deep brief** — `data/sws/deep/<TICKER>.json`: the full SWS payload (snowflake, news[], risks[],
  rewards[], fiscal history, FV). The richest per-stock source on disk.
- **Region registry** — `sws-regions.mjs` config map that parameterises the KR/TW pipelines by
  2-letter code instead of forking.
- **Co-run guard** — `sws-corun-guard.sh`, prevents two region scrapes from sharing the one SWS
  account concurrently.
- **The nightly chain** — `sws-nightly.sh`, the launchd-driven scrape→score→refresh→PR pipeline.
