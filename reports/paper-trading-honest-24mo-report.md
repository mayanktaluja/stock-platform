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
| Honest — fixed target exit | fixed | 0.5% | yes | 719 | 37.1% | -1.65% | -9.4% | 5.3% | -14.7% |
| Honest — trailing stop exit | trailing | 0.5% | yes | 719 | 32.4% | -1.39% | -11.8% | 5.3% | -17.1% |
| Legacy-parity (adjClose, no friction) | fixed | 0% | yes | 719 | 39.6% | -1.15% | -5.4% | 5.3% | -10.8% |

---

## Scenario: Honest — fixed target exit

- **Exit mode:** fixed SL + fixed target + time exit
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 719 |
| Win / Loss | 267 / 452 |
| Win rate | 37.1% |
| Avg return per trade | -1.65% |
| Avg win | 8.40% |
| Avg loss | -7.59% |
| Payoff (avgWin/|avgLoss|) | 1.11 |
| Expectancy per trade | -1.65% |
| Portfolio XIRR | -9.4% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-14.7%** |
| Avg holding days | 44 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 284 | 39.5% |
| Target hit | 94 | 13.1% |
| Time exit | 341 | 47.4% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 33.8% | -2.50% |
| MID_TERM | 239 | 44.8% | -0.91% |
| FUNDAMENTAL | 240 | 32.9% | -1.55% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| IT | 121 | 46.3% | 0.34% |
| Banking | 106 | 34.9% | -2.75% |
| FMCG | 79 | 30.4% | -2.23% |
| Pharma | 67 | 38.8% | -0.94% |
| Finance | 52 | 44.2% | -0.64% |
| Defence | 44 | 36.4% | -0.83% |
| Tourism | 36 | 5.6% | -6.35% |
| Insurance | 36 | 25.0% | -4.08% |
| Auto | 27 | 59.3% | 1.98% |
| Cement | 23 | 0.0% | -8.03% |

---

## Scenario: Honest — trailing stop exit

- **Exit mode:** trailing stop (ATR × 3), hard-SL safety net, target fill on intraday high
- **Friction:** 0.5% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 719 |
| Win / Loss | 233 / 486 |
| Win rate | 32.4% |
| Avg return per trade | -1.39% |
| Avg win | 8.25% |
| Avg loss | -6.02% |
| Payoff (avgWin/|avgLoss|) | 1.37 |
| Expectancy per trade | -1.39% |
| Portfolio XIRR | -11.8% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-17.1%** |
| Avg holding days | 32 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 158 | 22.0% |
| Target hit | 84 | 11.7% |
| Trailing stop | 305 | 42.4% |
| Time exit | 172 | 23.9% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 27.1% | -2.04% |
| MID_TERM | 239 | 41.8% | -1.11% |
| FUNDAMENTAL | 240 | 28.3% | -1.03% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| IT | 121 | 45.5% | 1.19% |
| Banking | 105 | 25.7% | -3.41% |
| FMCG | 74 | 20.3% | -2.95% |
| Pharma | 68 | 32.4% | -0.76% |
| Finance | 51 | 37.3% | -0.53% |
| Defence | 44 | 29.5% | -1.05% |
| Tourism | 37 | 8.1% | -4.58% |
| Insurance | 37 | 24.3% | -2.67% |
| Auto | 32 | 50.0% | 1.97% |
| Cement | 23 | 4.3% | -6.22% |

---

## Scenario: Legacy-parity (adjClose, no friction)

- **Exit mode:** fixed SL + fixed target + time exit
- **Friction:** 0% round-trip
- **Adjusted prices:** yes

### Summary

| Metric | Value |
|---|---|
| Total trades | 719 |
| Win / Loss | 285 / 434 |
| Win rate | 39.6% |
| Avg return per trade | -1.15% |
| Avg win | 8.35% |
| Avg loss | -7.39% |
| Payoff (avgWin/|avgLoss|) | 1.13 |
| Expectancy per trade | -1.15% |
| Portfolio XIRR | -5.4% |
| Nifty 50 XIRR (same window) | 5.3% |
| **Alpha** | **-10.8%** |
| Avg holding days | 44 |

### Exit breakdown

| Exit reason | Count | % of trades |
|---|---|---|
| SL hit | 284 | 39.5% |
| Target hit | 94 | 13.1% |
| Time exit | 341 | 47.4% |

### By category

| Category | Trades | Win rate | Avg return |
|---|---|---|---|
| BUY_NOW | 240 | 35.4% | -2.00% |
| MID_TERM | 239 | 49.0% | -0.41% |
| FUNDAMENTAL | 240 | 34.6% | -1.05% |

### By sector (top 10 by count)

| Sector | Trades | Win rate | Avg return |
|---|---|---|---|
| IT | 121 | 46.3% | 0.84% |
| Banking | 106 | 39.6% | -2.25% |
| FMCG | 79 | 34.2% | -1.73% |
| Pharma | 67 | 43.3% | -0.44% |
| Finance | 52 | 44.2% | -0.14% |
| Defence | 44 | 38.6% | -0.33% |
| Tourism | 36 | 11.1% | -5.85% |
| Insurance | 36 | 33.3% | -3.58% |
| Auto | 27 | 59.3% | 2.48% |
| Cement | 23 | 0.0% | -7.53% |

---

## Verdict

After corporate-action adjustment and 0.5% friction, the best honest scenario (Honest — fixed target exit) gives **-14.7% alpha vs Nifty 50** on a 24-month window. Phase 1 target: close this gap by at least 100 bps via SL/target rebalance + sentiment weight tuning + sector neutralisation.

---

## Disclaimer

1. Fundamentals are the current (Apr 2026) snapshot — the legacy 5-year report called out that this introduces look-ahead. On a 24-month window, the bias is materially smaller but non-zero.
2. Universe is survivorship-biased to today's Nifty 100. Phase 2 adds Nifty 500 + liquidity-filtered NSE names.
3. No regime-aware position sizing yet (Phase 2 P2.7). All trades are equal-weighted.
4. SL/target fills assume exact level; a real market order would slip. The 0.5% friction is a proxy but doesn't capture gap-fill loss.

---

*Generated on 2026-04-19T22:13:11.415Z by paper-trade-honest.mjs*
