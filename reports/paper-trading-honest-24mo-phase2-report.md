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
| Honest — fixed target exit | fixed | 0.5% | yes | 720 | 37.4% | -0.65% | -4.0% | 5.3% | -9.3% |
| Honest — trailing stop exit | trailing | 0.5% | yes | 720 | 37.8% | -0.54% | -2.5% | 5.3% | -7.9% |
| Legacy-parity (adjClose, no friction) | fixed | 0% | yes | 720 | 39.0% | -0.15% | -0.1% | 5.3% | -5.5% |

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
| Portfolio XIRR | -4.0% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-9.3%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 323 | 44.9% |
| Target hit | 71 | 9.9% |
| Time exit | 326 | 45.3% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 31.7% | -1.20% |
| MID_TERM | 240 | 44.6% | 0.24% |
| FUNDAMENTAL | 240 | 35.8% | -0.99% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 108 | 36.1% | -0.53% |
| IT | 105 | 41.9% | 0.19% |
| FMCG | 74 | 33.8% | -0.82% |
| Finance | 72 | 45.8% | 0.76% |
| Real Estate | 67 | 28.4% | -2.24% |
| Auto | 49 | 28.6% | -2.61% |
| Defence | 45 | 33.3% | -0.49% |
| Insurance | 39 | 23.1% | -4.47% |
| Capital Goods | 32 | 37.5% | 0.45% |
| Consumer | 25 | 52.0% | -0.48% |

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
| Avg loss | -7.11% |
| Payoff (avgWin/|avgLoss|) | 1.45 |
| Expectancy per trade | -0.54% |
| Portfolio XIRR | -2.5% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-7.9%** |
| Avg holding days | 40 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 294 | 40.8% |
| Target hit | 65 | 9.0% |
| Trailing stop | 69 | 9.6% |
| Time exit | 292 | 40.6% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.9% | -0.87% |
| MID_TERM | 240 | 44.6% | 0.24% |
| FUNDAMENTAL | 240 | 35.8% | -0.99% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 108 | 37.0% | -0.51% |
| IT | 105 | 44.8% | 0.32% |
| FMCG | 74 | 32.4% | -0.81% |
| Finance | 72 | 45.8% | 1.21% |
| Real Estate | 67 | 31.3% | -1.34% |
| Auto | 49 | 30.6% | -2.55% |
| Defence | 45 | 33.3% | -0.52% |
| Insurance | 39 | 23.1% | -4.24% |
| Capital Goods | 32 | 37.5% | 0.45% |
| Consumer | 25 | 48.0% | -0.66% |

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
| **Alpha** | **-5.5%** |
| Avg holding days | 43 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 323 | 44.9% |
| Target hit | 71 | 9.9% |
| Time exit | 326 | 45.3% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 32.1% | -0.70% |
| MID_TERM | 240 | 47.5% | 0.74% |
| FUNDAMENTAL | 240 | 37.5% | -0.49% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| Pharma | 108 | 39.8% | -0.03% |
| IT | 105 | 41.9% | 0.69% |
| FMCG | 74 | 36.5% | -0.32% |
| Finance | 72 | 45.8% | 1.26% |
| Real Estate | 67 | 28.4% | -1.74% |
| Auto | 49 | 30.6% | -2.11% |
| Defence | 45 | 35.6% | 0.01% |
| Insurance | 39 | 28.2% | -3.97% |
| Capital Goods | 32 | 37.5% | 0.95% |
| Consumer | 25 | 52.0% | 0.02% |

---

## Verdict

After corporate-action adjustment and 0.5% friction, the best honest scenario (Honest — trailing stop exit) gives **-7.9% alpha vs Nifty 50** on a 24-month window. Phase 1 target: close this gap by at least 100 bps via SL/target rebalance + sentiment weight tuning + sector neutralisation.

---

## Disclaimer

1. Fundamentals are the current (Apr 2026) snapshot — the legacy 5-year report called out that this introduces look-ahead. On a 24-month window, the bias is materially smaller but non-zero.
2. Universe is survivorship-biased to today's Nifty 100. Phase 2 adds Nifty 500 + liquidity-filtered NSE names.
3. No regime-aware position sizing yet (Phase 2 P2.7). All trades are equal-weighted.
4. SL/target fills assume exact level; a real market order would slip. The 0.5% friction is a proxy but doesn't capture gap-fill loss.

---

*Generated on 2026-04-19T22:28:58.461Z by paper-trade-honest.mjs*
