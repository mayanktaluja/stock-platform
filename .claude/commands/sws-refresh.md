---
description: Run the FULL SWS India nightly pipeline on demand (identical to the 00:30 IST cron — scrape → all aux data → gates → PR → auto-merge to prod).
allowed-tools: Bash
---

# /sws-refresh — run the nightly SWS pipeline on demand

Fires `scripts/sws-nightly-isolated.sh` — **the exact same entry point the 00:30 IST
launchd cron uses**. This is true 1:1 parity: whatever the nightly does, this does,
including shipping to production.

> Replaces the retired legacy Playwright path (`scripts/sws-refresh.sh {quick|earnings|full}`).
> That script still exists on disk as a manual fallback (see `scripts/SWS_API_PIPELINE.md`)
> but `/sws-refresh` no longer invokes it.

## What this does (same as the cron)

1. Isolated worktree reset to `origin/main` (keeps the publisher out of your working checkout).
2. Pre-flight (panic flag, network reachability, git sync).
3. **SWS primary branch**: `sws-refresh-api.sh` (API scrape → Groww/Refinitiv cache **forced fresh** → parse → seed score → sector outlook → final score → earnings-beat → narrate → stamp → chronos → input-diff → discovery feed → inline sanity gate → PDF) + market news (in/us/kr/tw).
4. **Auxiliary data** (parallel): NSE catalysts, corporate announcements, bulk/block deals, dividends, index constituents, F&O OI, universe rebuild, macro calendar, fundamentals, surveillance, governance, fundamentals-history, earnings watch, actuals, health summary, multibagger, risk lab, macro thesis.
5. **Gates** (hard): health-critical snapshot freshness, full sanity gate, deep-tarball pack, packed-price freshness, section-performance snapshot.
6. **Ship**: branch → commit → push → `gh pr create` → `gh pr merge --squash --auto` (auto-merge ON by default, `SWS_NIGHTLY_AUTO_MERGE:-1`) → completion email.

Runtime: ~2.5 hours (full universe). It self-detaches the heavy work; the isolated
worktree means it will not disturb whatever branch your main checkout is on.

## Guard rails

- **Single-instance lock**: if the cron nightly (or a prior `/sws-refresh`) is already
  running, this exits immediately with a skip message — it will NOT reset the shared
  worktree out from under the in-flight run. Check `/sws-status` and re-run when it finishes.
- Groww is **freshness-driven** now (no wall-clock gate); the nightly path exports
  `SWS_GROWW_FORCE_REFRESH=1` so every publish fetches a fresh cache.

## Usage

Argument: `$ARGUMENTS`. Pass `--dry-run` to run pre-flight + git-sync only (no scrape, no ship).

Run:

```bash
cd /Users/mayanktaluja/code/stock-platform && bash scripts/sws-nightly-isolated.sh ${ARGUMENTS}
```

After it exits:
- Surface a one-line summary from `data/sws/last-refresh.json` (mode, scored_count, shards_failed, duration).
- If the run opened a PR, report the PR URL and its merge state (`gh pr view --json url,state,mergedAt`).
- Exit 0 with a "skipping — another nightly running" message means the guard fired; report that and tell the user to retry after the current run finishes.
- If exit code is 3 (`panic-stop` set), DO NOT clear the flag automatically — surface `data/sws/panic-stop.flag` and ask whether to resume.
