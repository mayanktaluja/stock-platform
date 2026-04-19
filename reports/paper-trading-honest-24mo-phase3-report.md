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
| Honest — fixed target exit | fixed | 0.5% | yes | 720 | 37.4% | -0.65% | -3.9% | 5.3% | -9.3% |
| Honest — trailing stop exit | trailing | 0.5% | yes | 720 | 37.8% | -0.54% | -2.5% | 5.3% | -7.8% |
| Legacy-parity (adjClose, no friction) | fixed | 0% | yes | 720 | 39.0% | -0.15% | -0.1% | 5.3% | -5.4% |

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
| Avg return per trade | -0.65% |
| Avg win | 10.82% |
| Avg loss | -7.49% |
| Payoff (avgWin/|avgLoss|) | 1.44 |
| Expectancy per trade | -0.65% |
| Portfolio XIRR | -3.9% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-9.3%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 324 | 45.0% |
| Target hit | 71 | 9.9% |
| Time exit | 325 | 45.1% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 31.7% | -1.20% |
| MID_TERM | 240 | 44.6% | 0.23% |
| FUNDAMENTAL | 240 | 35.8% | -0.99% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 108 | 36.1% | -0.53% |
| IT | 105 | 41.9% | 0.19% |
| FMCG | 74 | 33.8% | -0.87% |
| Finance | 72 | 45.8% | 0.76% |
| Real Estate | 67 | 28.4% | -2.24% |
| Auto | 50 | 28.0% | -2.77% |
| Defence | 45 | 33.3% | -0.49% |
| Insurance | 39 | 23.1% | -4.47% |
| Capital Goods | 31 | 38.7% | 0.89% |
| Consumer | 25 | 52.0% | -0.48% |

### Per-signal attribution (Phase 3)

*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*

| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |
|---|---|---|---|---|---|
| rsiOversold | 13 | 53.8% | 3.92% | -1.49% | **+5.42%** |
| fundQualityGrowth | 47 | 51.1% | 2.28% | -2.05% | **+4.33%** |
| stochOversold | 21 | 42.9% | 1.89% | -1.50% | **+3.38%** |
| bolNearLower | 31 | 41.9% | 1.15% | -1.55% | **+2.70%** |
| volumeMajorSpike | 19 | 42.1% | 0.68% | -1.36% | **+2.04%** |
| rsiOverbought | 21 | 38.1% | -0.10% | -1.31% | **+1.21%** |
| trendStrongBear | 35 | 34.3% | -0.41% | -1.34% | **+0.93%** |
| trendStrongBull | 128 | 34.4% | -0.94% | -1.50% | **+0.56%** |
| stochOverbought | 44 | 34.1% | -0.91% | -1.26% | +0.35% |
| macdBullCross | 0 | 0.0% | 0.00% | 0.00% | +0.00% |
| macdBearCross | 0 | 0.0% | 0.00% | 0.00% | +0.00% |
| volumeSpike | 67 | 31.3% | -1.78% | -0.97% | **-0.81%** |
| bolNearUpper | 75 | 28.0% | -2.18% | -0.76% | **-1.42%** |
| fundDeepValue | 193 | 26.9% | -2.05% | 2.28% | **-4.33%** |

---

## Scenario: Honest — trailing stop exit

- **Exit mode:** trailing stop (ATR × 3), hard-SL safety net, target fill on intraday high
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 720 |
| Win / Loss | 272 / 448 |
| Win rate | 37.8% |
| Avg return per trade | -0.54% |
| Avg win | 10.29% |
| Avg loss | -7.12% |
| Payoff (avgWin/|avgLoss|) | 1.45 |
| Expectancy per trade | -0.54% |
| Portfolio XIRR | -2.5% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-7.8%** |
| Avg holding days | 40 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 295 | 41.0% |
| Target hit | 65 | 9.0% |
| Trailing stop | 69 | 9.6% |
| Time exit | 291 | 40.4% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.9% | -0.87% |
| MID_TERM | 240 | 44.6% | 0.23% |
| FUNDAMENTAL | 240 | 35.8% | -0.99% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 108 | 37.0% | -0.51% |
| IT | 105 | 44.8% | 0.32% |
| FMCG | 74 | 32.4% | -0.86% |
| Finance | 72 | 45.8% | 1.21% |
| Real Estate | 67 | 31.3% | -1.34% |
| Auto | 50 | 30.0% | -2.70% |
| Defence | 45 | 33.3% | -0.52% |
| Insurance | 39 | 23.1% | -4.24% |
| Capital Goods | 31 | 38.7% | 0.89% |
| Consumer | 25 | 48.0% | -0.66% |

### Per-signal attribution (Phase 3)

*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*

| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |
|---|---|---|---|---|---|
| rsiOversold | 13 | 61.5% | 5.99% | -1.26% | **+7.25%** |
| stochOversold | 21 | 52.4% | 3.46% | -1.29% | **+4.75%** |
| bolNearLower | 31 | 51.6% | 2.77% | -1.41% | **+4.18%** |
| trendStrongBear | 35 | 40.0% | 1.23% | -1.23% | **+2.46%** |
| fundQualityGrowth | 47 | 44.7% | 0.72% | -1.26% | **+1.97%** |
| macdBullCross | 0 | 0.0% | 0.00% | 0.00% | +0.00% |
| macdBearCross | 0 | 0.0% | 0.00% | 0.00% | +0.00% |
| volumeMajorSpike | 19 | 31.6% | -1.16% | -0.85% | -0.31% |
| trendStrongBull | 128 | 33.6% | -1.07% | -0.64% | -0.43% |
| stochOverbought | 44 | 34.1% | -1.22% | -0.79% | -0.43% |
| rsiOverbought | 21 | 23.8% | -2.58% | -0.71% | **-1.87%** |
| volumeSpike | 67 | 26.9% | -2.23% | -0.35% | **-1.88%** |
| fundDeepValue | 193 | 30.1% | -1.26% | 0.72% | **-1.97%** |
| bolNearUpper | 75 | 28.0% | -2.58% | -0.09% | **-2.49%** |

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
| Avg return per trade | -0.15% |
| Avg win | 10.84% |
| Avg loss | -7.19% |
| Payoff (avgWin/|avgLoss|) | 1.51 |
| Expectancy per trade | -0.15% |
| Portfolio XIRR | -0.1% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-5.4%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 324 | 45.0% |
| Target hit | 71 | 9.9% |
| Time exit | 325 | 45.1% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.1% | -0.70% |
| MID_TERM | 240 | 47.5% | 0.73% |
| FUNDAMENTAL | 240 | 37.5% | -0.49% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 108 | 39.8% | -0.03% |
| IT | 105 | 41.9% | 0.69% |
| FMCG | 74 | 36.5% | -0.37% |
| Finance | 72 | 45.8% | 1.26% |
| Real Estate | 67 | 28.4% | -1.74% |
| Auto | 50 | 30.0% | -2.27% |
| Defence | 45 | 35.6% | 0.01% |
| Insurance | 39 | 28.2% | -3.97% |
| Capital Goods | 31 | 38.7% | 1.39% |
| Consumer | 25 | 52.0% | 0.02% |

### Per-signal attribution (Phase 3)

*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*

| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |
|---|---|---|---|---|---|
| rsiOversold | 13 | 53.8% | 4.42% | -0.99% | **+5.42%** |
| fundQualityGrowth | 47 | 51.1% | 2.78% | -1.55% | **+4.33%** |
| stochOversold | 21 | 42.9% | 2.39% | -1.00% | **+3.38%** |
| bolNearLower | 31 | 41.9% | 1.65% | -1.05% | **+2.70%** |
| volumeMajorSpike | 19 | 42.1% | 1.18% | -0.86% | **+2.04%** |
| rsiOverbought | 21 | 38.1% | 0.40% | -0.81% | **+1.21%** |
| trendStrongBear | 35 | 34.3% | 0.09% | -0.84% | **+0.93%** |
| trendStrongBull | 128 | 34.4% | -0.44% | -1.00% | **+0.56%** |
| stochOverbought | 44 | 34.1% | -0.41% | -0.76% | +0.35% |
| macdBullCross | 0 | 0.0% | 0.00% | 0.00% | +0.00% |
| macdBearCross | 0 | 0.0% | 0.00% | 0.00% | +0.00% |
| volumeSpike | 67 | 31.3% | -1.28% | -0.47% | **-0.81%** |
| bolNearUpper | 75 | 28.0% | -1.68% | -0.26% | **-1.42%** |
| fundDeepValue | 193 | 27.5% | -1.55% | 2.78% | **-4.33%** |

---

## Verdict

After corporate-action adjustment and 0.5% friction, the best honest scenario (Honest — trailing stop exit) gives **-7.8% alpha vs Nifty 50** on a 24-month window. Phase 1 target: close this gap by at least 100 bps via SL/target rebalance + sentiment weight tuning + sector neutralisation.

---

## Disclaimer

1. Fundamentals are the current (Apr 2026) snapshot — the legacy 5-year report called out that this introduces look-ahead. On a 24-month window, the bias is materially smaller but non-zero.
2. Universe is survivorship-biased to today's Nifty 100. Phase 2 adds Nifty 500 + liquidity-filtered NSE names.
3. No regime-aware position sizing yet (Phase 2 P2.7). All trades are equal-weighted.
4. SL/target fills assume exact level; a real market order would slip. The 0.5% friction is a proxy but doesn't capture gap-fill loss.

---

*Generated on 2026-04-19T22:31:55.362Z by paper-trade-honest.mjs*
