# Multi-Year Concentration Study — Point-in-Time (Honest)

**Generated:** 2026-04-20T07:36:09.433Z  
**Universe:** nifty100  
**Fundamentals:** **point-in-time** (90-day reporting lag, no look-ahead)  
**Years analyzed:** 2023, 2024, 2025, 2026  
**Concentrations tested:** top-1, top-3, top-5, top-10  
**Exit modes:** fixed + trailing  
**Friction:** 0.5% round-trip  
**SL/Target:** 4× / 6× ATR  
**Trail:** 3× ATR, activates at +2× gain  

## Headline Alpha Matrix (vs Nifty 50, by year × concentration)

### Exit mode: fixed

| Year | Nifty XIRR | Top-1 α | Top-3 α | Top-5 α | Top-10 α |
|---|---|---|---|---|---|
| 2023 | 20.1% | +47.5% | +26.3% | +21.3% | +7.9% |
| 2024 | 8.8% | +69.3% | +24.1% | +29.3% | +16.0% |
| 2025 | 9.7% | +8.6% | -12.7% | +5.8% | +0.9% |
| 2026 | -47.5% | +23.2% | +30.0% | +14.4% | +24.1% |

### Exit mode: trailing

| Year | Nifty XIRR | Top-1 α | Top-3 α | Top-5 α | Top-10 α |
|---|---|---|---|---|---|
| 2023 | 20.1% | +45.9% | +25.5% | +21.8% | +7.7% |
| 2024 | 8.8% | +72.8% | +30.9% | +39.5% | +17.8% |
| 2025 | 9.7% | +15.7% | -10.5% | +6.3% | +0.5% |
| 2026 | -47.5% | +22.4% | +29.2% | +13.5% | +21.1% |

## Portfolio XIRR Matrix (absolute returns)

### Exit mode: fixed

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 67.6% | 46.4% | 41.4% | 28.0% |
| 2024 | 8.8% | 78.1% | 32.9% | 38.2% | 24.8% |
| 2025 | 9.7% | 18.4% | -3.0% | 15.5% | 10.7% |
| 2026 | -47.5% | -24.3% | -17.5% | -33.1% | -23.4% |

### Exit mode: trailing

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 66.0% | 45.6% | 41.9% | 27.8% |
| 2024 | 8.8% | 81.6% | 39.7% | 48.3% | 26.6% |
| 2025 | 9.7% | 25.4% | -0.8% | 16.0% | 10.2% |
| 2026 | -47.5% | -25.1% | -18.4% | -34.0% | -26.4% |

## Win-Rate Matrix

### Exit mode: fixed

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 87.2% (39) | 73.5% (117) | 69.7% (195) | 68.0% (369) |
| 2024 | 61.5% (39) | 52.1% (117) | 50.3% (195) | 50.5% (374) |
| 2025 | 51.3% (39) | 53.0% (117) | 52.8% (195) | 49.5% (386) |
| 2026 | 25.0% (12) | 25.0% (36) | 30.0% (60) | 34.5% (119) |

### Exit mode: trailing

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 82.1% (39) | 68.4% (117) | 65.1% (195) | 61.7% (373) |
| 2024 | 64.1% (39) | 53.8% (117) | 50.8% (195) | 49.7% (378) |
| 2025 | 48.7% (39) | 48.7% (117) | 50.3% (195) | 46.8% (387) |
| 2026 | 25.0% (12) | 27.8% (36) | 26.7% (60) | 34.5% (119) |

## Per-Year Deep Dive

### 2023

Window: 2022-12-31 → 2023-12-30 | Nifty 50: **20.1% XIRR**

- **Best cell:** Top-1 fixed → α=**+47.5%**, WR=87.2%, 39 trades
- **Worst cell:** Top-10 trailing → α=**+7.7%**, WR=61.7%, 373 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +6.50% avg, WR 79% · MID_TERM 39 trades @ +2.24% avg, WR 59% · FUNDAMENTAL 39 trades @ +7.06% avg, WR 82%

### 2024

Window: 2023-12-31 → 2024-12-30 | Nifty 50: **8.8% XIRR**

- **Best cell:** Top-1 trailing → α=**+72.8%**, WR=64.1%, 39 trades
- **Worst cell:** Top-10 fixed → α=**+16.0%**, WR=50.5%, 374 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +0.81% avg, WR 46% · MID_TERM 39 trades @ +0.72% avg, WR 56% · FUNDAMENTAL 39 trades @ +1.52% avg, WR 54%

### 2025

Window: 2024-12-31 → 2025-12-30 | Nifty 50: **9.7% XIRR**

- **Best cell:** Top-1 trailing → α=**+15.7%**, WR=48.7%, 39 trades
- **Worst cell:** Top-3 fixed → α=**-12.7%**, WR=53.0%, 117 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +1.67% avg, WR 49% · MID_TERM 39 trades @ -1.03% avg, WR 44% · FUNDAMENTAL 39 trades @ +4.62% avg, WR 67%

### 2026 (YTD)

Window: 2025-12-31 → 2026-03-30 | Nifty 50: **-47.5% XIRR**

- **Best cell:** Top-3 fixed → α=**+30.0%**, WR=25.0%, 36 trades
- **Worst cell:** Top-5 trailing → α=**+13.5%**, WR=26.7%, 60 trades
- **Category mix (top-3 fixed):** BUY_NOW 12 trades @ -2.68% avg, WR 25% · MID_TERM 12 trades @ -0.73% avg, WR 33% · FUNDAMENTAL 12 trades @ -5.78% avg, WR 17%

## Top Insights

1. Concentration sweet spot (avg alpha across years, fixed exit): **top-1 delivers +37.2% alpha**, top-10 delivers +12.2%. Signal is strongest at the TOP of the ranking — adding lower-ranked picks dilutes alpha.
2. Alpha generation is regime-dependent: engine beat Nifty in **4/4 years** (2023, 2024, 2025, 2026).
3. Trailing stop vs fixed target (avg across all cells): trailing adds **1.49 pp alpha**. Clear win for trailing — the activation gate is doing what it should.
4. Category contribution at top-3 fixed (avg return across years): **FUNDAMENTAL: +1.86%** · **BUY_NOW: +1.57%** · **MID_TERM: +0.30%**
5. Lowest avg max-drawdown: **top-10 at 15.9%**. Concentration and drawdown move together — denser portfolios amplify both good and bad months.

## Action Items for Engine Improvement

### P1: Max drawdown exceeded 20% in 2026 (top-5) — add regime overlay

Peak drawdown: 35.2%. Action: port the Phase 2 Kelly-lite regime sizing out of the mock backtest and onto real historical macro regimes. A FILTER (not just a sizer) that STOPS taking picks during identified risk-off regimes would bound downside. Rough eval: would the worst months have been skippable based on pre-month signals (Nifty 20-day MA break, VIX spike, global risk-off)?

### P2: Top-1 has meaningfully higher win rate than top-10 — ranking is directionally correct, diversify cautiously

Top-1 WR: 56.3% vs top-10 WR: 50.6%. The ranking DOES identify quality — just running top-1 only gives up too much diversification benefit. Action: build a 'top-3-with-size-weighting' mode where pick #1 gets 50%, #2 gets 30%, #3 gets 20%. That captures ranking signal without concentrating single-stock risk.

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
*Generated by scripts/multi-year-concentration.mjs on 2026-04-20T07:36:09.434Z*
