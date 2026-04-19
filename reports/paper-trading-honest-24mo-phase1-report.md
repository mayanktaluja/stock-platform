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
| Honest — fixed target exit | fixed | 0.5% | yes | 713 | 37.2% | -0.96% | -5.4% | 5.3% | -10.7% |
| Honest — trailing stop exit | trailing | 0.5% | yes | 713 | 37.3% | -0.89% | -4.7% | 5.3% | -10.1% |
| Legacy-parity (adjClose, no friction) | fixed | 0% | yes | 713 | 38.8% | -0.46% | -1.2% | 5.3% | -6.6% |

---

## Scenario: Honest — fixed target exit

- **Exit mode:** fixed SL + fixed target + time exit
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 713 |
| Win / Loss | 265 / 448 |
| Win rate | 37.2% |
| Avg return per trade | -0.96% |
| Avg win | 9.29% |
| Avg loss | -7.02% |
| Payoff (avgWin/|avgLoss|) | 1.32 |
| Expectancy per trade | -0.96% |
| Portfolio XIRR | -5.4% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-10.7%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 333 | 46.7% |
| Target hit | 65 | 9.1% |
| Time exit | 315 | 44.2% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 30.8% | -1.25% |
| MID_TERM | 233 | 44.6% | -0.51% |
| FUNDAMENTAL | 240 | 36.3% | -1.11% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 102 | 34.3% | -1.17% |
| IT | 98 | 46.9% | 0.89% |
| FMCG | 86 | 33.7% | -0.91% |
| Real Estate | 65 | 26.2% | -2.30% |
| Auto | 55 | 38.2% | -1.74% |
| Finance | 55 | 36.4% | -0.93% |
| Defence | 51 | 35.3% | 0.10% |
| Insurance | 45 | 24.4% | -4.30% |
| Energy | 30 | 46.7% | -0.42% |
| Power | 19 | 36.8% | -1.35% |

---

## Scenario: Honest — trailing stop exit

- **Exit mode:** trailing stop (ATR × 3), hard-SL safety net, target fill on intraday high
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 713 |
| Win / Loss | 266 / 447 |
| Win rate | 37.3% |
| Avg return per trade | -0.89% |
| Avg win | 8.76% |
| Avg loss | -6.63% |
| Payoff (avgWin/|avgLoss|) | 1.32 |
| Expectancy per trade | -0.89% |
| Portfolio XIRR | -4.7% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-10.1%** |
| Avg holding days | 40 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 304 | 42.6% |
| Target hit | 58 | 8.1% |
| Trailing stop | 70 | 9.8% |
| Time exit | 281 | 39.4% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 31.3% | -1.03% |
| MID_TERM | 233 | 44.6% | -0.51% |
| FUNDAMENTAL | 240 | 36.3% | -1.11% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 102 | 35.3% | -1.14% |
| IT | 98 | 49.0% | 0.95% |
| FMCG | 86 | 32.6% | -0.90% |
| Real Estate | 65 | 29.2% | -1.37% |
| Auto | 55 | 40.0% | -1.92% |
| Finance | 55 | 36.4% | -0.34% |
| Defence | 51 | 35.3% | 0.22% |
| Insurance | 45 | 24.4% | -4.11% |
| Energy | 30 | 40.0% | -1.17% |
| Power | 19 | 36.8% | -1.35% |

---

## Scenario: Legacy-parity (adjClose, no friction)

- **Exit mode:** fixed SL + fixed target + time exit
- **Friction:** 0% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 713 |
| Win / Loss | 277 / 436 |
| Win rate | 38.8% |
| Avg return per trade | -0.46% |
| Avg win | 9.37% |
| Avg loss | -6.71% |
| Payoff (avgWin/|avgLoss|) | 1.40 |
| Expectancy per trade | -0.46% |
| Portfolio XIRR | -1.2% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-6.6%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 333 | 46.7% |
| Target hit | 65 | 9.1% |
| Time exit | 315 | 44.2% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 31.3% | -0.75% |
| MID_TERM | 233 | 48.1% | -0.01% |
| FUNDAMENTAL | 240 | 37.5% | -0.61% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 102 | 38.2% | -0.67% |
| IT | 98 | 46.9% | 1.39% |
| FMCG | 86 | 37.2% | -0.41% |
| Real Estate | 65 | 26.2% | -1.80% |
| Auto | 55 | 38.2% | -1.24% |
| Finance | 55 | 36.4% | -0.43% |
| Defence | 51 | 37.3% | 0.60% |
| Insurance | 45 | 28.9% | -3.80% |
| Energy | 30 | 46.7% | 0.08% |
| Power | 19 | 42.1% | -0.85% |

---

## Verdict

After corporate-action adjustment and 0.5% friction, the best honest scenario (Honest — trailing stop exit) gives **-10.1% alpha vs Nifty 50** on a 24-month window. Phase 1 target: close this gap by at least 100 bps via SL/target rebalance + sentiment weight tuning + sector neutralisation.

---

## Disclaimer

1. Fundamentals are the current (Apr 2026) snapshot — the legacy 5-year report called out that this introduces look-ahead. On a 24-month window, the bias is materially smaller but non-zero.
2. Universe is survivorship-biased to today's Nifty 100. Phase 2 adds Nifty 500 + liquidity-filtered NSE names.
3. No regime-aware position sizing yet (Phase 2 P2.7). All trades are equal-weighted.
4. SL/target fills assume exact level; a real market order would slip. The 0.5% friction is a proxy but doesn't capture gap-fill loss.

---

*Generated on 2026-04-19T22:19:44.961Z by paper-trade-honest.mjs*
