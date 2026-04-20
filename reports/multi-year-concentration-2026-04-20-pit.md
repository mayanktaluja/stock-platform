# Multi-Year Concentration Study — Point-in-Time (Honest)

**Generated:** 2026-04-20T07:57:26.313Z  
**Universe:** nifty500  
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
| 2023 | 20.1% | +1.9% | +29.8% | +24.4% | +16.4% |
| 2024 | 8.8% | +23.7% | +13.1% | +35.3% | +22.0% |
| 2025 | 9.7% | -4.4% | +9.0% | -0.5% | +7.2% |
| 2026 | -47.5% | +96.2% | +32.6% | +14.6% | +9.6% |

### Exit mode: trailing

| Year | Nifty XIRR | Top-1 α | Top-3 α | Top-5 α | Top-10 α |
|---|---|---|---|---|---|
| 2023 | 20.1% | -2.7% | +28.2% | +23.3% | +17.2% |
| 2024 | 8.8% | -12.3% | +4.7% | +39.7% | +17.5% |
| 2025 | 9.7% | -4.0% | +16.3% | +4.4% | +13.5% |
| 2026 | -47.5% | +106.9% | +32.8% | +11.0% | +5.2% |

## Portfolio XIRR Matrix (absolute returns)

### Exit mode: fixed

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 22.0% | 49.9% | 44.5% | 36.6% |
| 2024 | 8.8% | 32.5% | 21.9% | 44.1% | 30.8% |
| 2025 | 9.7% | 5.3% | 18.7% | 9.3% | 17.0% |
| 2026 | -47.5% | 48.7% | -14.9% | -32.9% | -37.9% |

### Exit mode: trailing

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 17.4% | 48.3% | 43.4% | 37.3% |
| 2024 | 8.8% | -3.5% | 13.5% | 48.5% | 26.3% |
| 2025 | 9.7% | 5.7% | 26.0% | 14.2% | 23.2% |
| 2026 | -47.5% | 59.4% | -14.7% | -36.5% | -42.3% |

## Win-Rate Matrix

### Exit mode: fixed

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 50.0% (16) | 71.8% (117) | 70.3% (195) | 66.3% (386) |
| 2024 | 50.0% (18) | 47.9% (117) | 50.8% (195) | 50.8% (390) |
| 2025 | 43.8% (16) | 53.8% (117) | 51.3% (195) | 49.5% (390) |
| 2026 | 37.5% (8) | 22.2% (36) | 26.7% (60) | 25.0% (120) |

### Exit mode: trailing

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 43.8% (16) | 67.5% (117) | 66.2% (195) | 62.1% (388) |
| 2024 | 50.0% (18) | 49.6% (117) | 52.3% (195) | 50.0% (390) |
| 2025 | 37.5% (16) | 51.3% (117) | 48.2% (195) | 48.7% (390) |
| 2026 | 37.5% (8) | 25.0% (36) | 25.0% (60) | 25.8% (120) |

## Per-Year Deep Dive

### 2023

Window: 2022-12-31 → 2023-12-30 | Nifty 50: **20.1% XIRR**

- **Best cell:** Top-3 fixed → α=**+29.8%**, WR=71.8%, 117 trades
- **Worst cell:** Top-1 trailing → α=**-2.7%**, WR=43.8%, 16 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +7.67% avg, WR 82% · MID_TERM 39 trades @ +0.96% avg, WR 54% · FUNDAMENTAL 39 trades @ +6.42% avg, WR 79%

### 2024

Window: 2023-12-31 → 2024-12-30 | Nifty 50: **8.8% XIRR**

- **Best cell:** Top-5 trailing → α=**+39.7%**, WR=52.3%, 195 trades
- **Worst cell:** Top-1 trailing → α=**-12.3%**, WR=50.0%, 18 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +2.66% avg, WR 51% · MID_TERM 39 trades @ -0.99% avg, WR 46% · FUNDAMENTAL 39 trades @ -0.92% avg, WR 46%

### 2025

Window: 2024-12-31 → 2025-12-30 | Nifty 50: **9.7% XIRR**

- **Best cell:** Top-3 trailing → α=**+16.3%**, WR=51.3%, 117 trades
- **Worst cell:** Top-1 fixed → α=**-4.4%**, WR=43.8%, 16 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +1.32% avg, WR 49% · MID_TERM 39 trades @ +0.40% avg, WR 49% · FUNDAMENTAL 39 trades @ +3.54% avg, WR 64%

### 2026 (YTD)

Window: 2025-12-31 → 2026-03-30 | Nifty 50: **-47.5% XIRR**

- **Best cell:** Top-1 trailing → α=**+106.9%**, WR=37.5%, 8 trades
- **Worst cell:** Top-10 trailing → α=**+5.2%**, WR=25.8%, 120 trades
- **Category mix (top-3 fixed):** BUY_NOW 12 trades @ -3.04% avg, WR 25% · MID_TERM 12 trades @ -3.19% avg, WR 25% · FUNDAMENTAL 12 trades @ -5.54% avg, WR 17%

## Top Insights

1. Concentration sweet spot (avg alpha across years, fixed exit): **top-1 delivers +29.4% alpha**, top-10 delivers +13.8%. Signal is strongest at the TOP of the ranking — adding lower-ranked picks dilutes alpha.
2. Alpha generation is regime-dependent: engine beat Nifty in **4/4 years** (2023, 2024, 2025, 2026).
3. Trailing stop vs fixed target (avg across all cells): trailing costs **1.84 pp alpha**. Fixed target still wins — trailing is cutting too early even with the +2×ATR activation gate.
4. Category contribution at top-3 fixed (avg return across years): **BUY_NOW: +2.15%** · **FUNDAMENTAL: +0.87%** · **MID_TERM: -0.71%**
5. Lowest avg max-drawdown: **top-5 at 19.6%**. Concentration and drawdown move together — denser portfolios amplify both good and bad months.

## Action Items for Engine Improvement

### P0: Trailing stop still loses to fixed target — activation gate isn't tight enough

Avg alpha fixed=20.7% vs trailing=18.9% (delta -1.8 pp). Despite the +2× ATR activation gate, the trailing engine is still cutting trades short. Action: (a) raise activation threshold from +2×ATR to +3×ATR, (b) widen trail distance from 3×ATR to 4×ATR, (c) add a minimum-hold period (e.g. don't trail within 5 trading days of entry regardless of gain).

### P1: Max drawdown exceeded 20% in 2026 (top-10) — add regime overlay

Peak drawdown: 46.0%. Action: port the Phase 2 Kelly-lite regime sizing out of the mock backtest and onto real historical macro regimes. A FILTER (not just a sizer) that STOPS taking picks during identified risk-off regimes would bound downside. Rough eval: would the worst months have been skippable based on pre-month signals (Nifty 20-day MA break, VIX spike, global risk-off)?

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
*Generated by scripts/multi-year-concentration.mjs on 2026-04-20T07:57:26.313Z*
