# PROJECT_STATUS.md — stock-platform

**Last updated: 2026-05-24**

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
[stock-platform-gamma.vercel.app](https://stock-platform-gamma.vercel.app),
serving a single-tenant Indian equity research workflow. Auth, the SWS picks
pipeline, portfolio analyzer, earnings watch, risk lab, and macro thesis are
all shipped — plus US / Korea / Taiwan picks tabs, Sector Outlook, a 5x Lab,
and the Compounder + Earnings Edge paper-trade sleeves.

The headline scoring engine is now **V4** (`swsScoringV4.js`) — V3 was deleted
in #437. The current investment is in **signal quality and back-testing
discipline**: V4 shipped with a deliberately *lower* historical backtest than
V3 (cleaner FV model, fixed coverage traps), so the active work is recovering
that gap through weight tuning rather than chasing new features.

Two-sleeve trading book ("Compounder Lab" + "Earnings Edge" + paper-trade
harness) shipped in #337 — a separate experimental surface from the main
portfolio analyzer.

## Recently shipped (themed, newest first — rolling ~4–6 week window; `git log` is the archive)

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

### Multi-region Picks (May 2026)
- **#379 / #386** — US Picks tab + first full US scrape (~5,448 names), as a
  fully isolated `data/sws-us/` fork (US scorer/parser import India's, never edit).
- **#383 / #391 / #408** — **Region registry** (`scripts/sws-regions.mjs`):
  config/universe/scrape/parse/score/DAL + `registerRegionPicksRoutes` factory +
  generic `renderRegionPicks`, keyed by region code. Korea (~2,590) + Taiwan
  (~2,339) scraped and live, in ₩ / NT$. **KR/TW are registry config, not forks;
  India + US pipelines frozen.** Numeric tickers dot-suffixed (005930.KS /
  2330.TW); 4-market co-run guard on the one shared SWS account.
- **#390** — US/KR/TW Picks at 1:1 parity with India (rich modal, dropdown,
  collapse). **#393** — bundle regional deep tarballs into the Vercel function
  (Vercel ~15k file cap). **#404** — card fallback for region modal header/snowflake.

### New experimental surfaces (May 2026)
- **#347** — Sector Outlook tab (SWS news themes × macro regime; no named picks v1).
- **#348 / #354** — 5x Lab (concentrated multibagger, personal-use) + per-pick
  Strategy & Reasoning with a live pre-mortem. **#350** — prod gate/data fix.
- **#337** — Compounder Lab + Earnings Edge two-sleeve paper-trade book + NSE PIT
  promoter-transaction feed.

### Auth & navigation (May 2026)
- **This PR** — Flatten privileged navigation: US/KR/TW Picks, Risk Lab, and
  Sector Outlook stay visible in the main tab bar for signed-in users; only
  Users remains owner-admin-only. Admin authority is now hard-coded to
  `mthaluja11@gmail.com` via `computeIsAdmin()` rather than `ADMIN_EMAILS`.
- **#395** — Two-tier access: `ADMIN_EMAILS` live allowlist; personal-use folded
  into the admin tier. (Direction still settling — see Active themes.)
- **#361** — "More" dropdown for privileged tabs. **#370** — Avoid List section
  removed from Picks. **#360** — density toggle removed. **#380** — mobile
  info-icon sizing fix.

### Pipeline / infra reliability (May 2026)
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
  centralized in `computeIsAdmin()` as `mthaluja11@gmail.com` while public
  research tabs stay visible to signed-in users. Per-user data namespacing
  remains the eventual goal. **Verify `server.js` + `services/auth/` before
  touching auth.**
- **Earnings predictor validation.** Backtest wired
  (`scripts/backtest-earnings-predictions.mjs`); the V1 cap-lift gate (≥30
  resolved + ≥55% bucket hit-rate + Brier <0.20) is still warming up. Weight
  tuning won't run until ≥80 resolved across ≥2 quarters, ≥5 sectors with ≥10
  events. The KEC false-positive post-mortem (BEAT predicted, −11% actual) is now
  baked into Earnings Edge's 5 on-disk gates rather than an LLM fix.
- **Two-sleeve trading book.** Compounder Lab + Earnings Edge (#337) accrue
  walk-forward paper-trade performance separate from the main picks. Promotion to
  a first-class surface depends on hit-rate over the next 1–2 quarters.

## Known production gotchas (also in AGENTS.md / ARCHITECTURE.md, repeated for emphasis)

- **`gated/app.js` is ~13,040 LOC.** Concurrent edits collide — edit sequentially.
- **NSE cookie-gated endpoints fail on Vercel datacenter IPs.** Run locally, commit JSON.
- **`v3` names are V4 aliases, not leftovers.** `signals.v3.*`, `top_ranked_30_v3`,
  `v3-universe-stats.json`, `v3SignalAdapter.js` all carry V4 data by design — don't
  blind find-replace.
- **V4 verdicts are absolute cutoffs** (≥59 / ≥47 / ≥37 / ≥28), not rank-based — no
  universe band is loaded at runtime.
- **Vercel KV is dead for the picks/fundamentals READ path** (#195) but still backs
  user-scoped *writes* (watchlist, portfolio, track) via `userStorage.js`.
- **Regional deep briefs ship as `deep-{us,kr,tw}.tar.gz`** (#393) — Vercel ~15k file cap.
- **9× backtest scripts are forks**, not a shared library — propagate fixes by hand.
- **Auto-refresh PRs flood the repo** — `chore(macro|sws): auto-refresh ...` open every
  few hours. They commit data files, not code.
- **`starbhai.com` is NOT this platform** — it 301s to a separate WordPress site. Always
  link the `-gamma.vercel.app` alias.

## Roadmap items (not yet started)

- **Per-user portfolio namespacing.** Currently every signed-in user sees
  the same global portfolio. Next iteration of the auth shipped in early May.
- **Mobile layout pass.** SPA is desktop-first; mobile is tolerable but not
  loved.
- **Custom domain.** Either map `starbhai.com` to Vercel (breaks the WordPress
  site) or buy a new domain. Currently using `-gamma.vercel.app`.
- **Screener.in ingestion** for 10y fundamentals. SWS only exposes 5 rows
  of `fiscal.yearly_history` and no ROCE — any Marcellus-replica-style
  10y-quality filter blocks on this.
- **NSE PIT (insider) 7(2) scraper.** SWS capture has no insider data
  (`is_insider` + `insider_ownership_pct` are null universe-wide). **Partially
  shipped:** `refresh-promoter-transactions.mjs` → `data/promoter-transactions/
  rolling-30d.json` now feeds Earnings Edge's promoter-sell veto; broader
  insider-signal surfacing still pending.

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
