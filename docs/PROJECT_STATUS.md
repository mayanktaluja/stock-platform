# PROJECT_STATUS.md — stock-platform

**Last updated: 2026-05-21**

Living snapshot of where the project is right now. Update this file whenever
you ship a meaningful PR or change direction. The point is that a fresh AI
assistant (Codex, Cursor, Claude in a new conversation, etc.) — or a human
reviewer — can read this and `[AGENTS.md](../AGENTS.md)` and have full
context in under 5 minutes.

If this file goes stale, it is **worse than not having it.** Don't let it
drift more than one major PR behind.

---

## Where we are right now

The platform is **in production**, live at
[stock-platform-gamma.vercel.app](https://stock-platform-gamma.vercel.app),
serving a single-tenant Indian equity research workflow. Auth, the SWS picks
pipeline, portfolio analyzer, earnings watch, risk lab, and macro thesis are
all shipped. The current investment is in **signal quality and back-testing
discipline** — making sure every recommendation the platform makes is
something we can prove worked historically.

Two-sleeve trading book ("Compounder Lab" + "Earnings Edge" + paper-trade
harness) shipped in #337 — a separate experimental surface from the main
portfolio analyzer.

## Recently shipped (last ~10 commits, themed)

### US Picks tab (May 2026)
- **#379** — Admin-only **US Picks** tab: an SWS-sourced US-equity leaderboard
  (NASDAQ/NYSE/NYSEMKT, ~5,448 liquid names), mirroring the SWS Picks tab. Built
  as a **fully isolated fork** — new `data/sws-us/` namespace, US scorer/parser
  IMPORT the India ones (never edit them), new `requireAdminRead`-gated
  `/api/us-picks` routes, cloned US render path ($ not ₹). Manual
  `/sws-refresh-us` refresh with a co-run guard (won't scrape while India is).
  Ships **empty** — needs a scrape to populate. PDF export deferred.

### Alpha-strategy two-sleeve book (May 2026)
- **#337** — Compounder Lab + Earnings Edge + paper-trade harness + NSE PIT
  scraper. Experimental trading book sleeve, isolated from the main picks.

### Risk Lab + UX polish (May 2026)
- **#336** — Risk Lab hover tooltips for every term.
- **#333** — Total Returns strip switched from {1M,3M,1Y,3Y,5Y} to {1D,7D,1M,3M,1Y}.
- **#207** (52 PRs prior) — Progressive-disclosure UX overhaul.

### Earnings Watch pipeline (Apr–May 2026)
- **#217** — Daily pipeline health summary + provider monitoring.
- **#216** — Surface V3 breakdown + LLM signal + audit trail on card.
- **#215** — Weight-tuning sweep harness (gated on resolved actuals).
- **#214** — LLM qualitative signal as predictor component 9 (Groq → Gemini → heuristic).
- **#213** — Wire SWS V3 100-pt breakdown into the predictor.
- **#212** — Quota-aware nightly refresh of `fundamentalsHistory.json`.
- **#211** — Resolve post-result actuals (SWS news → Yahoo fallback) so backtest can score.
- **#209** — Earnings Watch open to all signed-in users (was admin-only).
- **#208** — Default to 30-day window + collapsible per-date sections.

### Macro regime (May 2026)
- **#335, #334, #205, #201** — Auto-refresh fixes + `.env` loading in cron.
  Macro banner now stays fresh; dead refresh paths removed.

### SWS picks polish (May 2026)
- **#206, #197, #194** — Auto-refresh runs (data, not code).
- **#204** — Restore Newly Added / Trending badges (async stamper).
- **#202** — Off-section search hits now render score, verdict, valuation chip.
- **#200** — Skeleton placeholder while credibility loads.
- **#198** — Credibility ribbon on landing — top 5/section vs Nifty.

### Reliability / infra (May 2026)
- **#219, #218** — sws-nightly resilience (worktree-safe sync, no `--delete-branch`).
- **#210** — Cooldown gate wired into Tier A (stops trimmed stocks re-flagging).
- **#199** — Portable timeout wrapper so earnings chain runs on macOS.
- **#195** — Rip out dead Vercel KV path so prod reads fresh disk.
- **#196** — Cooldown gate to stop duplicate trim recommendations.

## Active themes / what's in flight

- **Earnings predictor validation.** Backtest is wired (`scripts/backtest-earnings-predictions.mjs`)
  but the V1 cap-lift gate (≥30 resolved + ≥55% bucket hit-rate + Brier <0.20)
  is still warming up. Predictions are versioned; weight tuning won't run
  until the gate clears (≥80 resolved across ≥2 quarters, ≥5 sectors with
  ≥10 events). Expected to clear over the next 2–3 months of results seasons.
- **Risk Lab refinement.** Recent KEC false positive (predictor scored BEAT,
  actual MISS, stock -11%) prompted a structural-not-LLM fix path: prior-Q-miss
  regex, `fv_imputed` haircut, `risks[]` keyword, sector watchlist. Documented
  in project memory; some pieces shipped, others pending.
- **Two-sleeve trading book.** Compounder Lab + Earnings Edge launched as an
  experimental sleeve in #337. Paper-trade harness scoring its own performance
  separate from the main picks. Whether to promote this to a first-class
  surface depends on hit-rate over the next 1–2 quarters.

## Known production gotchas (also in AGENTS.md, repeated here for emphasis)

- **`gated/app.js` is 11,700 LOC.** Concurrent edits collide.
- **NSE cookie-gated endpoints fail on Vercel datacenter IPs.** Run locally, commit JSON.
- **Vercel KV is dead.** Reads now come from disk JSON. If you see new KV code, it's wrong.
- **9× backtest scripts are forks**, not a shared library — propagating a fix means editing each by hand.
- **Auto-refresh PRs flood the repo** — `chore(macro): auto-refresh ...` and `chore(sws): auto-refresh ...`
  open PRs every few hours. They commit data files, not code.
- **`starbhai.com` is NOT this platform** — it 301s to a separate WordPress
  site. Always link the `-gamma.vercel.app` alias.

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
  (`is_insider` + `insider_ownership_pct` are null universe-wide). Started
  in #337 as part of Earnings Edge.

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
