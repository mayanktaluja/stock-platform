# Paper Trading — Honest Backtest Report

**Generated:** 2026-04-19  
**Period:** 2024-04-30 → 2026-03-30 (24 monthly scans)  
**Universe:** Nifty 100 stocks  
**Engine:** StarBhai production scoring engine  
**Adjustment:** Split/bonus/dividend adjusted prices (Yahoo adjclose)  
**Friction:** 0.5% round-trip on every trade  

---

## Phase 0 Fix Summary

Three things changed vs the legacy 5-year backtest:

1. **Corporate actions** — all prices adjusted via Yahoo adjclose + proportional high/low. Splits (IRCTC, BAJAJ-AUTO) and bonuses (RELIANCE Oct 2024, LODHA Nov 2024) no longer appear as 50% drawdowns.
2. **Friction** — 0.5% round-trip subtracted from every trade's return. Breakdown: STT 0.1%, exchange+SEBI+GST 0.1%, slippage 0.25%, brokerage 0.05%. Conservative.
3. **Window** — 24-month window to avoid pre-2024 data quality issues (stale fundamentals, thin midcap histories). Legacy 5yr report archived alongside.

A fourth change: **trailing stop is now actually executed in the backtest.** Until now it only appeared in the UI as advisory text.

---

## Headline Numbers — Scenario Comparison

| Scenario | Exit mode | Friction | adjClose | Trades | Win rate | Avg return | Portfolio XIRR | Nifty XIRR | Alpha |
|----------|-----------|----------|----------|--------|----------|------------|----------------|------------|-------|
| Honest — fixed target exit | fixed | 0.5% | yes | 720 | 37.4% | -0.62% | -1.7% | 5.3% | -7.1% |
| Honest — trailing stop exit | trailing | 0.5% | yes | 720 | 37.5% | -0.62% | -1.9% | 5.3% | -7.2% |
| Legacy-parity (adjClose, no friction) | fixed | 0% | yes | 720 | 39.0% | -0.12% | 2.2% | 5.3% | -3.1% |

---

## Scenario: Honest — fixed target exit

- **Exit mode:** fixed SL + fixed target + time exit
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 720 |
| Win / Loss | 269 / 451 |
| Win rate | 37.4% |
| Avg return per trade | -0.62% |
| Avg win | 10.73% |
| Avg loss | -7.39% |
| Payoff (avgWin/|avgLoss|) | 1.45 |
| Expectancy per trade | -0.62% |
| Portfolio XIRR | -1.7% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-7.1%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 318 | 44.2% |
| Target hit | 73 | 10.1% |
| Time exit | 329 | 45.7% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.1% | -0.76% |
| MID_TERM | 240 | 44.2% | -0.11% |
| FUNDAMENTAL | 240 | 35.8% | -0.99% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 110 | 35.5% | -0.65% |
| IT | 107 | 43.0% | 0.81% |
| FMCG | 73 | 37.0% | -0.23% |
| Finance | 72 | 45.8% | 0.86% |
| Real Estate | 69 | 30.4% | -1.49% |
| Auto | 52 | 26.9% | -2.70% |
| Defence | 41 | 31.7% | -0.99% |
| Insurance | 40 | 22.5% | -4.37% |
| Capital Goods | 31 | 38.7% | 0.24% |
| Consumer | 23 | 43.5% | -3.07% |

### Per-signal attribution (Phase 3)

*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*

| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |
|---|---|---|---|---|---|
| stochOversold | 23 | 56.5% | 6.15% | -1.50% | **+7.65%** |
| rsiOversold | 10 | 40.0% | 3.85% | -0.97% | **+4.82%** |
| fundQualityGrowth | 46 | 52.2% | 2.73% | -1.59% | **+4.33%** |
| trendStrongBear | 33 | 42.4% | 2.80% | -1.33% | **+4.13%** |
| macdBearCross | 32 | 43.8% | 2.59% | -1.28% | **+3.88%** |
| bolNearLower | 31 | 45.2% | 2.48% | -1.25% | **+3.73%** |
| volumeMajorSpike | 20 | 35.0% | 0.35% | -0.87% | **+1.21%** |
| rsiOverbought | 20 | 35.0% | -0.70% | -0.77% | +0.07% |
| stochOverbought | 43 | 34.9% | -0.80% | -0.76% | -0.04% |
| volumeSpike | 71 | 31.0% | -1.25% | -0.56% | **-0.69%** |
| trendStrongBull | 120 | 32.5% | -1.31% | -0.21% | **-1.10%** |
| bolNearUpper | 75 | 28.0% | -2.06% | -0.18% | **-1.88%** |
| macdBullCross | 90 | 25.6% | -2.59% | 0.33% | **-2.92%** |
| fundDeepValue | 194 | 27.3% | -1.59% | 2.73% | **-4.33%** |

---

## Scenario: Honest — trailing stop exit

- **Exit mode:** trailing stop (ATR × 3), hard-SL safety net, target fill on intraday high
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 720 |
| Win / Loss | 270 / 450 |
| Win rate | 37.5% |
| Avg return per trade | -0.62% |
| Avg win | 10.11% |
| Avg loss | -7.07% |
| Payoff (avgWin/|avgLoss|) | 1.43 |
| Expectancy per trade | -0.62% |
| Portfolio XIRR | -1.9% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-7.2%** |
| Avg holding days | 41 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 292 | 40.6% |
| Target hit | 65 | 9.0% |
| Trailing stop | 69 | 9.6% |
| Time exit | 294 | 40.8% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.5% | -0.77% |
| MID_TERM | 240 | 44.2% | -0.11% |
| FUNDAMENTAL | 240 | 35.8% | -0.99% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 110 | 36.4% | -0.59% |
| IT | 107 | 43.9% | 0.67% |
| FMCG | 73 | 35.6% | -0.27% |
| Finance | 72 | 45.8% | 0.98% |
| Real Estate | 69 | 31.9% | -1.10% |
| Auto | 52 | 30.8% | -2.66% |
| Defence | 41 | 31.7% | -1.03% |
| Insurance | 40 | 22.5% | -4.03% |
| Capital Goods | 31 | 38.7% | 0.24% |
| Consumer | 23 | 39.1% | -3.26% |

### Per-signal attribution (Phase 3)

*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*

| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |
|---|---|---|---|---|---|
| stochOversold | 23 | 52.2% | 4.78% | -1.36% | **+6.14%** |
| macdBearCross | 32 | 46.9% | 3.15% | -1.37% | **+4.52%** |
| bolNearLower | 31 | 48.4% | 2.63% | -1.27% | **+3.90%** |
| trendStrongBear | 33 | 39.4% | 2.14% | -1.23% | **+3.37%** |
| rsiOversold | 10 | 30.0% | 1.98% | -0.89% | **+2.87%** |
| fundQualityGrowth | 46 | 45.7% | 0.59% | -1.09% | **+1.69%** |
| volumeMajorSpike | 20 | 35.0% | -0.14% | -0.83% | **+0.69%** |
| stochOverbought | 43 | 34.9% | -1.09% | -0.70% | -0.39% |
| trendStrongBull | 120 | 33.3% | -1.34% | -0.20% | **-1.14%** |
| volumeSpike | 71 | 28.2% | -1.76% | -0.36% | **-1.40%** |
| fundDeepValue | 194 | 29.4% | -1.09% | 0.59% | **-1.69%** |
| rsiOverbought | 20 | 25.0% | -2.63% | -0.60% | **-2.03%** |
| bolNearUpper | 75 | 28.0% | -2.59% | 0.06% | **-2.65%** |
| macdBullCross | 90 | 24.4% | -2.50% | 0.27% | **-2.77%** |

---

## Scenario: Legacy-parity (adjClose, no friction)

- **Exit mode:** fixed SL + fixed target + time exit
- **Friction:** 0% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 720 |
| Win / Loss | 281 / 439 |
| Win rate | 39.0% |
| Avg return per trade | -0.12% |
| Avg win | 10.76% |
| Avg loss | -7.09% |
| Payoff (avgWin/|avgLoss|) | 1.52 |
| Expectancy per trade | -0.12% |
| Portfolio XIRR | 2.2% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-3.1%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 318 | 44.2% |
| Target hit | 73 | 10.1% |
| Time exit | 329 | 45.7% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.5% | -0.26% |
| MID_TERM | 240 | 47.1% | 0.39% |
| FUNDAMENTAL | 240 | 37.5% | -0.49% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 110 | 39.1% | -0.15% |
| IT | 107 | 43.0% | 1.31% |
| FMCG | 73 | 39.7% | 0.27% |
| Finance | 72 | 45.8% | 1.36% |
| Real Estate | 69 | 30.4% | -0.99% |
| Auto | 52 | 28.8% | -2.20% |
| Defence | 41 | 34.1% | -0.49% |
| Insurance | 40 | 27.5% | -3.87% |
| Capital Goods | 31 | 38.7% | 0.74% |
| Consumer | 23 | 43.5% | -2.57% |

### Per-signal attribution (Phase 3)

*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*

| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |
|---|---|---|---|---|---|
| stochOversold | 23 | 56.5% | 6.65% | -1.00% | **+7.65%** |
| rsiOversold | 10 | 40.0% | 4.35% | -0.47% | **+4.82%** |
| fundQualityGrowth | 46 | 52.2% | 3.23% | -1.09% | **+4.33%** |
| trendStrongBear | 33 | 42.4% | 3.30% | -0.83% | **+4.13%** |
| macdBearCross | 32 | 43.8% | 3.09% | -0.78% | **+3.88%** |
| bolNearLower | 31 | 45.2% | 2.98% | -0.75% | **+3.73%** |
| volumeMajorSpike | 20 | 35.0% | 0.85% | -0.37% | **+1.21%** |
| rsiOverbought | 20 | 35.0% | -0.20% | -0.27% | +0.07% |
| stochOverbought | 43 | 34.9% | -0.30% | -0.26% | -0.04% |
| volumeSpike | 71 | 31.0% | -0.75% | -0.06% | **-0.69%** |
| trendStrongBull | 120 | 32.5% | -0.81% | 0.29% | **-1.10%** |
| bolNearUpper | 75 | 28.0% | -1.56% | 0.32% | **-1.88%** |
| macdBullCross | 90 | 25.6% | -2.09% | 0.83% | **-2.92%** |
| fundDeepValue | 194 | 27.8% | -1.09% | 3.23% | **-4.33%** |

---

## Verdict

After corporate-action adjustment and 0.5% friction, the best honest scenario (Honest — fixed target exit) gives **-7.1% alpha vs Nifty 50** on a 24-month window. Phase 1 target: close this gap by at least 100 bps via SL/target rebalance + sentiment weight tuning + sector neutralisation.

---

## Disclaimer

1. Fundamentals are the current (Apr 2026) snapshot — the legacy 5-year report called out that this introduces look-ahead. On a 24-month window, the bias is materially smaller but non-zero.
2. Universe is survivorship-biased to today's Nifty 100. Phase 2 adds Nifty 500 + liquidity-filtered NSE names.
3. No regime-aware position sizing yet (Phase 2 P2.7). All trades are equal-weighted.
4. SL/target fills assume exact level; a real market order would slip. The 0.5% friction is a proxy but doesn't capture gap-fill loss.

---

*Generated on 2026-04-19T22:43:10.218Z by paper-trade-honest.mjs*
