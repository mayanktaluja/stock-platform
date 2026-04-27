# SWS — Tech-weight sweep backtest

**Generated:** 2026-04-27T23:21:54.025Z

**Window:** 4-year (2022-04-27 → 2026-04-27), quarterly rebalance (16 rebalance events)
**Hold:** Top 30 from a candidate pool of 57 (mcap ≥ ₹500cr, sorted by SWS v1 fundamentals)
**Capital:** ₹10L initial, fully invested, no friction in this script

## Headline result

| Tech weight | XIRR | Total return | Max drawdown | Monthly Sharpe (annlsd) | Turnover % / rebal |
|---:|---:|---:|---:|---:|---:|
| 0% | 32.09% | 203.55% | 27.52% | 1.32 | 7.04% |
| 15% | 37.75% | 258.81% | 25.71% | 1.52 | 45.19% |
| 30% | 39.42% | 276.50% | 24.66% | 1.56 | 84.12% |
| 45% | 38.93% | 271.29% | 24.68% | 1.54 | 101.40% |
| 60% | 38.00% | 261.46% | 24.22% | 1.50 | 103.15% |
| **Nifty 50 (BAH)** | 8.52% | 38.58% | 15.77% | 0.68 | — |

## Winners

- **Best XIRR:** 30% tech weight → 39.42%
- **Best Sharpe (annualised):** 30% tech weight → 1.56
- **Lowest max drawdown:** 60% tech weight → 24.22%

## Methodology + caveats — read before acting on this

**What this backtest does:**
1. Loads all SWS-scored stocks with mcap ≥ ₹500cr from the current `picks-latest.json`.
2. Sorts by SWS v1 fundamentals score, takes the top 57 as the candidate pool.
3. At each quarterly rebalance date during the 4-year window:
   - Computes a point-in-time technical score for each candidate from Yahoo OHLC up to that date (RSI, MACD, trend, volume, OBV, etc. — same engine used in production at `/api/stock`).
   - Blends `v1 * (1 - w) + tech * w` and ranks. Picks top 30, equal-weighted.
   - Holds until next rebalance.
4. Marks-to-market daily; computes XIRR + drawdown + Sharpe + turnover.

**Honest limitations** (will overstate XIRR vs reality):
- **Look-ahead bias on fundamentals.** SWS v1 score is today's snapshot, applied as a constant across all past rebalance dates. A name whose fundamentals improved during the window gets credited in earlier dates as if those improvements already existed. Subtract roughly **100-200 bps** from each XIRR for a realistic estimate.
- **Survivorship.** Universe = stocks SWS covers TODAY. Names that delisted, were acquired, or fell out of coverage during the window are absent — those are precisely the worst performers, so the survivor universe overstates the rising tide.
- **No friction.** No brokerage, slippage, STT, or impact cost. Subtract another **50-100 bps** for real-money execution.
- **Equal-weighted, fully invested.** Real portfolios use position sizing, cash buffers, and stop-losses — none of which are simulated here.
- **Single regime.** 4 years includes one full mood (post-2022 bull leg in IN equities). The optimal weight may shift in a sustained drawdown regime.

**What this backtest is good for:** picking the *relative* winner among the weight points. Since all five weights face the same biases, the **delta** between them is informative even though the absolute XIRR is overstated.

## SEBI-strategist read

The sweep peaks in the **15-30% tech weight** range — consistent with the practitioner consensus on hybrid composites. The drop-off above 30% suggests technicals add value as a *filter* against momentum-broken stocks but become noisy as a primary score driver.

## Re-run

```
# Override defaults to stress-test sensitivity:
node scripts/sws-backtest-weight-sweep.mjs --years 4
node scripts/sws-backtest-weight-sweep.mjs --years 2 --hold 20
node scripts/sws-backtest-weight-sweep.mjs --weights 0,10,20,30,40,50
```
