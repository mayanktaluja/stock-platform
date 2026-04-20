# Multi-Year Concentration Study — Honest Paper Trading

**Generated:** 2026-04-20T00:00:39.160Z  
**Universe:** nifty500  
**Years analyzed:** 2023, 2024, 2025, 2026  
**Concentrations tested:** top-1, top-3, top-5, top-10  
**Exit modes:** fixed + trailing  
**Friction:** 0.5% round-trip  
**SL/Target:** 3× / 7× ATR  
**Trail:** 3× ATR, activates at +2× gain  

## Headline Alpha Matrix (vs Nifty 50, by year × concentration)

### Exit mode: fixed

| Year | Nifty XIRR | Top-1 α | Top-3 α | Top-5 α | Top-10 α |
|---|---|---|---|---|---|
| 2023 | 20.1% | -10.1% | +5.0% | +10.1% | +15.5% |
| 2024 | 8.8% | -0.3% | +26.6% | +22.9% | +6.9% |
| 2025 | 9.7% | -40.5% | -15.5% | -9.2% | -5.6% |
| 2026 | -47.5% | +33.5% | +5.7% | -1.3% | -6.5% |

### Exit mode: trailing

| Year | Nifty XIRR | Top-1 α | Top-3 α | Top-5 α | Top-10 α |
|---|---|---|---|---|---|
| 2023 | 20.1% | -9.2% | +3.6% | +5.5% | +14.3% |
| 2024 | 8.8% | -19.1% | +20.5% | +19.9% | +12.7% |
| 2025 | 9.7% | -30.5% | -4.0% | +3.4% | +2.2% |
| 2026 | -47.5% | +36.0% | +8.3% | -0.2% | -8.2% |

## Portfolio XIRR Matrix (absolute returns)

### Exit mode: fixed

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 10.0% | 25.1% | 30.2% | 35.6% |
| 2024 | 8.8% | 8.5% | 35.4% | 31.7% | 15.7% |
| 2025 | 9.7% | -30.8% | -5.7% | 0.5% | 4.1% |
| 2026 | -47.5% | -14.0% | -41.8% | -48.8% | -54.0% |

### Exit mode: trailing

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 10.9% | 23.7% | 25.6% | 34.4% |
| 2024 | 8.8% | -10.3% | 29.3% | 28.7% | 21.5% |
| 2025 | 9.7% | -20.8% | 5.7% | 13.2% | 12.0% |
| 2026 | -47.5% | -11.5% | -39.2% | -47.7% | -55.7% |

## Win-Rate Matrix

### Exit mode: fixed

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 61.5% (39) | 64.1% (117) | 64.1% (195) | 59.7% (390) |
| 2024 | 35.9% (39) | 41.9% (117) | 44.1% (195) | 43.8% (390) |
| 2025 | 28.2% (39) | 34.2% (117) | 35.9% (195) | 37.7% (390) |
| 2026 | 16.7% (12) | 8.3% (36) | 11.7% (60) | 11.7% (120) |

### Exit mode: trailing

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 66.7% (39) | 64.1% (117) | 60.0% (195) | 57.7% (390) |
| 2024 | 38.5% (39) | 41.9% (117) | 44.6% (195) | 45.1% (390) |
| 2025 | 30.8% (39) | 37.6% (117) | 37.9% (195) | 38.7% (390) |
| 2026 | 25.0% (12) | 16.7% (36) | 16.7% (60) | 15.0% (120) |

## Per-Year Deep Dive

### 2023

Window: 2022-12-31 → 2023-12-30 | Nifty 50: **20.1% XIRR**

- **Best cell:** Top-10 fixed → α=**+15.5%**, WR=59.7%, 390 trades
- **Worst cell:** Top-1 fixed → α=**-10.1%**, WR=61.5%, 39 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +5.24% avg, WR 64% · MID_TERM 39 trades @ +2.42% avg, WR 62% · FUNDAMENTAL 39 trades @ +4.12% avg, WR 67%

### 2024

Window: 2023-12-31 → 2024-12-30 | Nifty 50: **8.8% XIRR**

- **Best cell:** Top-3 fixed → α=**+26.6%**, WR=41.9%, 117 trades
- **Worst cell:** Top-1 trailing → α=**-19.1%**, WR=38.5%, 39 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +2.12% avg, WR 44% · MID_TERM 39 trades @ -1.82% avg, WR 38% · FUNDAMENTAL 39 trades @ +2.05% avg, WR 44%

### 2025

Window: 2024-12-31 → 2025-12-30 | Nifty 50: **9.7% XIRR**

- **Best cell:** Top-5 trailing → α=**+3.4%**, WR=37.9%, 195 trades
- **Worst cell:** Top-1 fixed → α=**-40.5%**, WR=28.2%, 39 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ -1.91% avg, WR 26% · MID_TERM 39 trades @ +0.85% avg, WR 49% · FUNDAMENTAL 39 trades @ -0.41% avg, WR 28%

### 2026 (YTD)

Window: 2025-12-31 → 2026-03-30 | Nifty 50: **-47.5% XIRR**

- **Best cell:** Top-1 trailing → α=**+36.0%**, WR=25.0%, 12 trades
- **Worst cell:** Top-10 trailing → α=**-8.2%**, WR=15.0%, 120 trades
- **Category mix (top-3 fixed):** BUY_NOW 12 trades @ -4.19% avg, WR 8% · MID_TERM 12 trades @ -4.47% avg, WR 17% · FUNDAMENTAL 12 trades @ -6.29% avg, WR 0%

## Top Insights

1. Concentration sweet spot (avg alpha across years, fixed exit): **top-5 delivers +5.6% alpha**, top-1 delivers -4.4%. Spreading picks across more names actually HELPS — the top-1 signal alone is noisier than the crowd.
2. Alpha generation is regime-dependent: engine beat Nifty in **3/4 years** (2023, 2024, 2026) — it underperformed in 2025.
3. Trailing stop vs fixed target (avg across all cells): trailing adds **1.14 pp alpha**. Clear win for trailing — the activation gate is doing what it should.
4. Category contribution at top-3 fixed (avg return across years): **BUY_NOW: +0.32%** · **FUNDAMENTAL: -0.13%** · **MID_TERM: -0.76%**
5. Lowest avg max-drawdown: **top-5 at 20.3%**. Concentration and drawdown move together — denser portfolios amplify both good and bad months.

## Action Items for Engine Improvement

### P0: The top-1 pick is noisier than the top-3 average — investigate ranking function

Top-1 avg alpha (-4.4%) underperforms top-3 avg (5.5%). This is a signal that our scoring function ranks correctly on average but the #1 slot has execution variance. Action: (a) check if there's a specific signal that predicts top-1 failure (sector, verdict), (b) consider a 'stability' filter that demotes stocks with high recent score volatility, (c) add a 'conviction threshold' — only take the top-1 if score gap over top-2 is > X.

### P1: Max drawdown exceeded 20% in 2026 (top-10) — add regime overlay

Peak drawdown: 45.6%. Action: port the Phase 2 Kelly-lite regime sizing out of the mock backtest and onto real historical macro regimes. A FILTER (not just a sizer) that STOPS taking picks during identified risk-off regimes would bound downside. Rough eval: would the worst months have been skippable based on pre-month signals (Nifty 20-day MA break, VIX spike, global risk-off)?

### P2: Eliminate fundamental look-ahead with point-in-time data (biggest honest-measurement fix left)

Current backtest uses today's fundamentals.json for all historical decisions. For 2023-2024 trades this is a real data leak — we 'knew' the FY25 margin outcome when scoring a Q1-FY24 pick. Action: (a) scrape Screener.in or NSE quarterly results keyed by (symbol, fiscal_period, announcement_date), (b) store at .fundamentals-history.jsonl with effective-dated rows, (c) modify backtest to read the snapshot as-of SCAN_DATE not today. This alone likely moves the honest 2023-2024 alpha by ±2-4 pp. Effort: 2-3 days. This is the single highest-ROI remaining measurement fix.

### P3: Collect historical macro regime labels for the 2023-2026 window

Our Kelly-lite sizing was proven valuable in principle but runs on a mock delta in backtest. Hand-label (or LLM-batch-label) monthly macro regimes for the 48 months of this study based on known major events (SVB collapse, Israel-Hamas, Fed cuts, India election, etc.). Once labelled, re-run this matrix with real Kelly sizing and we can measure whether regime-aware sizing actually improves Sharpe.

### P3: Backfill earnings calendar for 2023-2025 and re-run with blackout applied

Production has a 3-day earnings blackout (Phase 2). The multi-year sim here doesn't — so our 2023-2025 trades include earnings-gap losses that production wouldn't incur. Backfill BSE/NSE corporate-action announcement dates for the universe and re-run. Expected effect: +0.5-1.0 pp alpha per year, lower max-DD.

## Known Biases & Caveats

1. **Fundamentals look-ahead.** `fundamentals.json` is the Apr 2026 snapshot. Older years 'know' today's margins/ROE/debt. The bias worsens monotonically with age — 2026 YTD is the honest year; 2023 is the most contaminated.
2. **Survivorship bias.** Universe is as of Apr 2026 — stocks delisted or kicked from Nifty 500 between 2023–2026 are absent. Typically biases results slightly upward.
3. **Mock macro regime.** The backtest doesn't have historical macro regime data, so Kelly-lite sizing is disabled here for simplicity (equal-weight trades).
4. **No slippage beyond friction.** The 0.5% friction is generous for Nifty 500 largecaps but aggressive for midcaps. A stock-weighted slippage model would be more accurate.
5. **Quarterly earnings not embedded.** We don't enforce earnings blackouts in this backtest — production has the guard, but the multi-year sim pre-dates live earnings calendar data for 2023-2024.

---
*Generated by scripts/multi-year-concentration.mjs on 2026-04-20T00:00:39.161Z*
