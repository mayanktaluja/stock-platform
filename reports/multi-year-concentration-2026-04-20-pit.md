# Multi-Year Concentration Study — Point-in-Time (Honest)

**Generated:** 2026-04-20T07:18:14.630Z  
**Universe:** nifty100  
**Fundamentals:** **point-in-time** (90-day reporting lag, no look-ahead)  
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
| 2023 | 20.1% | +43.2% | +36.0% | +30.6% | +15.2% |
| 2024 | 8.8% | +88.3% | +14.1% | +32.5% | +20.4% |
| 2025 | 9.7% | -1.4% | -18.2% | -10.1% | -3.5% |
| 2026 | -47.5% | +1.2% | +29.0% | +29.5% | +25.5% |

### Exit mode: trailing

| Year | Nifty XIRR | Top-1 α | Top-3 α | Top-5 α | Top-10 α |
|---|---|---|---|---|---|
| 2023 | 20.1% | +29.6% | +36.2% | +30.0% | +13.0% |
| 2024 | 8.8% | +55.2% | +12.7% | +31.4% | +23.9% |
| 2025 | 9.7% | +3.3% | -19.9% | -11.8% | -3.7% |
| 2026 | -47.5% | -1.6% | +34.1% | +33.3% | +18.8% |

## Portfolio XIRR Matrix (absolute returns)

### Exit mode: fixed

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 63.3% | 56.1% | 50.7% | 35.3% |
| 2024 | 8.8% | 97.1% | 22.9% | 41.3% | 29.2% |
| 2025 | 9.7% | 8.3% | -8.4% | -0.4% | 6.3% |
| 2026 | -47.5% | -46.3% | -18.5% | -18.0% | -22.0% |

### Exit mode: trailing

| Year | Nifty | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|---|
| 2023 | 20.1% | 49.7% | 56.3% | 50.1% | 33.1% |
| 2024 | 8.8% | 64.0% | 21.5% | 40.2% | 32.7% |
| 2025 | 9.7% | 13.0% | -10.2% | -2.1% | 6.0% |
| 2026 | -47.5% | -49.2% | -13.4% | -14.2% | -28.7% |

## Win-Rate Matrix

### Exit mode: fixed

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 82.1% (39) | 73.5% (117) | 68.7% (195) | 63.5% (378) |
| 2024 | 48.7% (39) | 44.4% (117) | 47.2% (195) | 45.0% (382) |
| 2025 | 43.6% (39) | 45.3% (117) | 44.6% (195) | 41.9% (387) |
| 2026 | 8.3% (12) | 16.7% (36) | 20.0% (60) | 24.2% (120) |

### Exit mode: trailing

| Year | Top-1 | Top-3 | Top-5 | Top-10 |
|---|---|---|---|---|
| 2023 | 84.6% (39) | 70.9% (117) | 66.7% (195) | 59.4% (379) |
| 2024 | 51.3% (39) | 45.3% (117) | 47.2% (195) | 45.5% (382) |
| 2025 | 43.6% (39) | 44.4% (117) | 45.1% (195) | 42.6% (387) |
| 2026 | 8.3% (12) | 25.0% (36) | 26.7% (60) | 26.7% (120) |

## Per-Year Deep Dive

### 2023

Window: 2022-12-31 → 2023-12-30 | Nifty 50: **20.1% XIRR**

- **Best cell:** Top-1 fixed → α=**+43.2%**, WR=82.1%, 39 trades
- **Worst cell:** Top-10 trailing → α=**+13.0%**, WR=59.4%, 379 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +7.59% avg, WR 77% · MID_TERM 39 trades @ +2.02% avg, WR 62% · FUNDAMENTAL 39 trades @ +8.49% avg, WR 82%

### 2024

Window: 2023-12-31 → 2024-12-30 | Nifty 50: **8.8% XIRR**

- **Best cell:** Top-1 fixed → α=**+88.3%**, WR=48.7%, 39 trades
- **Worst cell:** Top-3 trailing → α=**+12.7%**, WR=45.3%, 117 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ +0.28% avg, WR 38% · MID_TERM 39 trades @ -0.20% avg, WR 49% · FUNDAMENTAL 39 trades @ +0.73% avg, WR 46%

### 2025

Window: 2024-12-31 → 2025-12-30 | Nifty 50: **9.7% XIRR**

- **Best cell:** Top-1 trailing → α=**+3.3%**, WR=43.6%, 39 trades
- **Worst cell:** Top-3 trailing → α=**-19.9%**, WR=44.4%, 117 trades
- **Category mix (top-3 fixed):** BUY_NOW 39 trades @ -0.45% avg, WR 44% · MID_TERM 39 trades @ -0.97% avg, WR 44% · FUNDAMENTAL 39 trades @ +1.27% avg, WR 49%

### 2026 (YTD)

Window: 2025-12-31 → 2026-03-30 | Nifty 50: **-47.5% XIRR**

- **Best cell:** Top-3 trailing → α=**+34.1%**, WR=25.0%, 36 trades
- **Worst cell:** Top-1 trailing → α=**-1.6%**, WR=8.3%, 12 trades
- **Category mix (top-3 fixed):** BUY_NOW 12 trades @ -4.03% avg, WR 8% · MID_TERM 12 trades @ -1.09% avg, WR 33% · FUNDAMENTAL 12 trades @ -4.87% avg, WR 8%

## Top Insights

1. Concentration sweet spot (avg alpha across years, fixed exit): **top-1 delivers +32.8% alpha**, top-10 delivers +14.4%. Signal is strongest at the TOP of the ranking — adding lower-ranked picks dilutes alpha.
2. Alpha generation is regime-dependent: engine beat Nifty in **3/4 years** (2023, 2024, 2026) — it underperformed in 2025.
3. Trailing stop vs fixed target (avg across all cells): trailing costs **3.00 pp alpha**. Fixed target still wins — trailing is cutting too early even with the +2×ATR activation gate.
4. Category contribution at top-3 fixed (avg return across years): **FUNDAMENTAL: +1.41%** · **BUY_NOW: +0.85%** · **MID_TERM: -0.06%**
5. Lowest avg max-drawdown: **top-10 at 16.4%**. Concentration and drawdown move together — denser portfolios amplify both good and bad months.

## Action Items for Engine Improvement

### P0: Trailing stop still loses to fixed target — activation gate isn't tight enough

Avg alpha fixed=20.8% vs trailing=17.8% (delta -3.0 pp). Despite the +2× ATR activation gate, the trailing engine is still cutting trades short. Action: (a) raise activation threshold from +2×ATR to +3×ATR, (b) widen trail distance from 3×ATR to 4×ATR, (c) add a minimum-hold period (e.g. don't trail within 5 trading days of entry regardless of gain).

### P1: Max drawdown exceeded 20% in 2026 (top-1) — add regime overlay

Peak drawdown: 40.0%. Action: port the Phase 2 Kelly-lite regime sizing out of the mock backtest and onto real historical macro regimes. A FILTER (not just a sizer) that STOPS taking picks during identified risk-off regimes would bound downside. Rough eval: would the worst months have been skippable based on pre-month signals (Nifty 20-day MA break, VIX spike, global risk-off)?

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
*Generated by scripts/multi-year-concentration.mjs on 2026-04-20T07:18:14.631Z*
