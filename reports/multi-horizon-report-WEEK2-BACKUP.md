# Multi-Horizon Paper Trading Report with Market Mood Filter

**Generated:** 2026-04-17  
**Data Period:** Oct 2020 - Apr 2026 (5.5 years of OHLCV)  
**Horizons Tested:** 1yr, 2yr, 3yr, 4yr, 5yr  
**Universe:** Nifty 100 stocks  
**Engine:** StarBhai production scoring engine  

---

## Part 1: Cross-Horizon Comparison

| Horizon | Trades (Filtered) | Win Rate | Avg Return | XIRR | Nifty XIRR | Alpha | Months Skipped | XIRR (No Filter) | Filter Value |
|---------|-------------------|----------|------------|------|------------|-------|----------------|-------------------|--------------|
| 1 Year | 152 | 40.1% | -0.23% | -1.4% | 9.5% | -10.9% | 5 | 13.3% | -14.7pp |
| 2 Years | 373 | 38.3% | -0.71% | -4.6% | 5.3% | -9.9% | 6 | 1.3% | -5.9pp |
| 3 Years | 663 | 52.2% | 2.98% | 24.9% | 13.1% | +11.9% | 6 | 24.4% | +0.6pp |
| 4 Years | 818 | 52.2% | 3.11% | 24.1% | 8.5% | +15.5% | 9 | 20.8% | +3.2pp |
| 5 Years | 903 | 52.2% | 2.96% | 24.0% | 11.0% | +12.9% | 11 | 21.7% | +2.3pp |

**Key Observations:**

- Best absolute XIRR: **3 Years** at 24.9%
- Best alpha: **4 Years** at +15.5%
- Average filter value across all horizons: -2.9pp

### Portfolio by Category vs Nifty 50

Per-category XIRR across 1-4 year horizons (the window with 100% point-in-time fundamentals coverage). Alpha is category XIRR minus Nifty XIRR over the same window. All results use the market-mood-filtered variant.

| Horizon | Category | Trades | Win Rate | Avg Return | Portfolio XIRR | Nifty 50 XIRR | Alpha |
|---------|----------|-------:|---------:|-----------:|---------------:|--------------:|------:|
| 1 Year | Buy Now | 36 | 41.7% | -0.99% | -6.3% | 9.5% | -15.8% |
| 1 Year | Mid-Term | 58 | 43.1% | -0.45% | -6.0% | 9.5% | -15.5% |
| 1 Year | Quality Growth | 18 | 22.2% | -4.56% | -26.2% | 9.5% | -35.6% |
| 1 Year | Deep Value | 40 | 42.5% | 2.73% | 9.3% | 9.5% | -0.1% |
| 1 Year | All combined | 152 | 40.1% | -0.23% | -1.4% | 9.5% | -10.9% |
| 2 Years | Buy Now | 91 | 35.2% | -2.37% | -15.7% | 5.3% | -21.1% |
| 2 Years | Mid-Term | 141 | 46.1% | -0.63% | -9.5% | 5.3% | -14.9% |
| 2 Years | Quality Growth | 30 | 30.0% | -3.07% | -15.1% | 5.3% | -20.5% |
| 2 Years | Deep Value | 111 | 33.3% | 1.17% | 4.5% | 5.3% | -0.8% |
| 2 Years | All combined | 373 | 38.3% | -0.71% | -4.6% | 5.3% | -9.9% |
| 3 Years | Buy Now | 177 | 53.7% | 1.40% | 15.0% | 13.1% | +1.9% |
| 3 Years | Mid-Term | 243 | 55.6% | 1.19% | 26.6% | 13.1% | +13.6% |
| 3 Years | Quality Growth | 37 | 56.8% | 4.66% | 25.8% | 13.1% | +12.7% |
| 3 Years | Deep Value | 206 | 46.1% | 6.14% | 28.1% | 13.1% | +15.0% |
| 3 Years | All combined | 663 | 52.2% | 2.98% | 24.9% | 13.1% | +11.9% |
| 4 Years | Buy Now | 221 | 57.9% | 2.15% | 23.8% | 8.5% | +15.2% |
| 4 Years | Mid-Term | 306 | 52.0% | 0.77% | 14.0% | 8.5% | +5.4% |
| 4 Years | Quality Growth | 29 | 44.8% | 0.84% | 4.6% | 8.5% | -4.0% |
| 4 Years | Deep Value | 262 | 48.5% | 6.89% | 28.6% | 8.5% | +20.0% |
| 4 Years | All combined | 818 | 52.2% | 3.11% | 24.1% | 8.5% | +15.5% |

**Reading this table:**
- *Buy Now* — combined 50/50 technical+fundamental score ≥ 65, fund verdict is DEEP_VALUE or QUALITY_GROWTH, recommendation is not HOLD. Held up to 3 months with ATR×3 SL / ATR×5 target.
- *Mid-Term* — pure technical score ≥ 58. Held up to 20 trading days.
- *Quality Growth* — fundamental verdict QUALITY_GROWTH (score 58-71). Held up to 3 months with 20% trailing stop.
- *Deep Value* — fundamental verdict DEEP_VALUE (score ≥ 72). Held up to 3 months with 20% trailing stop.
- *All combined* — every trade the strategy produced across all three categories.

### Top-K Concentration Analysis

For each category, what if we only kept the top K highest-scoring picks per scan month? Lower K = more concentrated, fewer but higher-conviction trades. Cell format: `XIRR% (alpha)` where alpha = category XIRR − Nifty XIRR. Bold is the best K for that row.

**1 Year** (Nifty XIRR: 9.5%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **-0.3% (-9.8)** | -26.9% (-36.4) | -14.3% (-23.7) | -14.6% (-24.1) | -6.3% (-15.8) |
| Mid-Term | **57.2% (+47.8)** | 15.7% (+6.2) | 19.6% (+10.1) | -1.8% (-11.3) | -6.0% (-15.5) |
| Quality Growth | -27.8% (-37.3) | **-20.4% (-29.8)** | -25.6% (-35.1) | -29.2% (-38.7) | -26.2% (-35.6) |
| Deep Value | **24.3% (+14.9)** | 1.0% (-8.5) | -1.0% (-10.5) | 9.0% (-0.5) | 9.3% (-0.1) |

**2 Years** (Nifty XIRR: 5.3%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **-13.9% (-19.2)** | -19.9% (-25.3) | -27.2% (-32.5) | -19.8% (-25.1) | -15.7% (-21.1) |
| Mid-Term | **4.0% (-1.4)** | -1.5% (-6.9) | -9.5% (-14.9) | -11.3% (-16.7) | -9.5% (-14.9) |
| Quality Growth | -28.4% (-33.7) | -20.1% (-25.4) | -18.5% (-23.8) | -16.6% (-21.9) | **-15.1% (-20.5)** |
| Deep Value | **19.1% (+13.7)** | 18.6% (+13.3) | 15.0% (+9.7) | 13.5% (+8.1) | 4.5% (-0.8) |

**3 Years** (Nifty XIRR: 13.1%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **44.8% (+31.8)** | 36.7% (+23.7) | 16.8% (+3.8) | 15.4% (+2.3) | 15.0% (+1.9) |
| Mid-Term | 39.3% (+26.2) | **50.8% (+37.8)** | 30.4% (+17.3) | 23.3% (+10.2) | 26.6% (+13.6) |
| Quality Growth | 6.3% (-6.7) | 19.5% (+6.4) | **27.4% (+14.3)** | 24.6% (+11.6) | 25.8% (+12.7) |
| Deep Value | 23.3% (+10.3) | 37.0% (+23.9) | **42.4% (+29.4)** | 39.2% (+26.1) | 28.1% (+15.0) |

**4 Years** (Nifty XIRR: 8.5%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **63.0% (+54.5)** | 39.7% (+31.2) | 21.6% (+13.0) | 29.3% (+20.7) | 23.8% (+15.2) |
| Mid-Term | **37.8% (+29.2)** | 21.6% (+13.0) | 13.2% (+4.7) | 7.9% (-0.6) | 14.0% (+5.4) |
| Quality Growth | 5.1% (-3.4) | **10.4% (+1.8)** | 5.7% (-2.8) | 4.6% (-4.0) | 4.6% (-4.0) |
| Deep Value | 32.8% (+24.3) | **34.9% (+26.4)** | 33.6% (+25.1) | 34.5% (+26.0) | 28.6% (+20.0) |


### Fundamentals Coverage

Stock×scanDate pairs where historical fundamentals were available as-of the scan date. Pairs without historical data skip fundamental-gated trades (they don't fall back to the current snapshot).

| Horizon | With Fundamentals | Without Fundamentals | Coverage % |
|---------|-------------------|----------------------|------------|
| 1 Year | 693 | 0 | 100.0% |
| 2 Years | 1782 | 0 | 100.0% |
| 3 Years | 2964 | 6 | 99.8% |
| 4 Years | 3543 | 314 | 91.9% |
| 5 Years | 3543 | 1290 | 73.3% |

---

## Part 2: Individual Horizon Analysis

### 1 Year Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 152 |
| Wins / Losses | 61 / 91 |
| Win Rate | 40.1% |
| Avg Return/Trade | -0.23% |
| XIRR (Filtered) | -1.4% |
| XIRR (No Filter) | 13.3% |
| Nifty XIRR | 9.5% |
| Alpha | -10.9% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.17% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.58% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.71% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | 1.93% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 24 | -0.33% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.40% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -3.46% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 36 | 41.7% | -0.99% | 14 (39%) | 9 (25%) | 13 (36%) |
| Mid-Term | 58 | 43.1% | -0.45% | 7 (12%) | 2 (3%) | 49 (84%) |
| Fundamental | 58 | 36.2% | 0.47% | 29 (50%) | 6 (10%) | 23 (40%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 26 | 38% | -0.99% |
| Pharma | 15 | 67% | 3.20% |
| Capital Goods | 15 | 13% | -6.56% |
| IT | 12 | 33% | -2.93% |
| FMCG | 11 | 55% | 2.65% |
| Finance | 11 | 0% | -6.72% |
| Auto | 9 | 78% | 7.56% |
| Insurance | 7 | 57% | -0.12% |
| Defence | 6 | 33% | 0.99% |
| Tourism | 6 | 0% | -7.08% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 64 | 42.2% | 1.55% |
| QUALITY_GROWTH | 30 | 30.0% | -3.58% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 373 |
| Wins / Losses | 143 / 230 |
| Win Rate | 38.3% |
| Avg Return/Trade | -0.71% |
| XIRR (Filtered) | -4.6% |
| XIRR (No Filter) | 1.3% |
| Nifty XIRR | 5.3% |
| Alpha | -9.9% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2024 | STRONG_BUY_DAY | 27 | 3.83% | -0.2% |
| May 2024 | BUY_DAY | 14 | -3.81% | 0.2% |
| Jun 2024 | BUY_DAY | 18 | 2.43% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 8.58% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 24 | 0.03% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 27 | 4.57% | 2.2% |
| Oct 2024 | BUY_DAY | 19 | -4.95% | -5.8% |
| Nov 2024 | SELECTIVE | 11 | -6.90% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.05% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -8.35% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -10.25% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 1.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.66% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -2.60% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 25 | -1.92% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.53% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -4.14% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 91 | 35.2% | -2.37% | 48 (53%) | 20 (22%) | 23 (25%) |
| Mid-Term | 141 | 46.1% | -0.63% | 28 (20%) | 11 (8%) | 102 (72%) |
| Fundamental | 141 | 32.6% | 0.27% | 78 (55%) | 21 (15%) | 42 (30%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 81 | 26% | -3.62% |
| IT | 39 | 54% | 3.97% |
| Pharma | 39 | 41% | -1.67% |
| FMCG | 30 | 47% | 1.05% |
| Auto | 28 | 50% | 3.20% |
| Power | 22 | 59% | 5.17% |
| Finance | 19 | 47% | 0.74% |
| Capital Goods | 16 | 19% | -5.02% |
| Tourism | 13 | 0% | -9.77% |
| Mining | 12 | 58% | 2.63% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 180 | 34.4% | -0.09% |
| QUALITY_GROWTH | 52 | 30.8% | -3.13% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 663 |
| Wins / Losses | 346 / 317 |
| Win Rate | 52.2% |
| Avg Return/Trade | 2.98% |
| XIRR (Filtered) | 24.9% |
| XIRR (No Filter) | 24.4% |
| Nifty XIRR | 13.1% |
| Alpha | +11.9% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2023 | BUY_DAY | 21 | 0.37% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 25 | 5.60% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 24 | 4.47% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.47% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 25 | 5.34% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 29 | 9.03% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.77% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.36% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 14.55% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 11.60% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.20% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 21 | -0.25% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 26 | 4.00% | -0.2% |
| May 2024 | BUY_DAY | 19 | 2.58% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | 1.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 27 | 8.63% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 27 | 2.33% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 8.84% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.13% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -8.73% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 5.05% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.43% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.09% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 1.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.66% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -2.60% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.88% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.71% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -3.17% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 177 | 53.7% | 1.40% | 69 (39%) | 77 (44%) | 31 (18%) |
| Mid-Term | 243 | 55.6% | 1.19% | 37 (15%) | 37 (15%) | 169 (70%) |
| Fundamental | 243 | 47.7% | 5.91% | 108 (44%) | 64 (26%) | 71 (29%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 93 | 33% | -0.88% |
| IT | 90 | 63% | 6.71% |
| FMCG | 61 | 44% | 0.48% |
| Pharma | 61 | 49% | 0.65% |
| Auto | 53 | 62% | 6.93% |
| Finance | 44 | 66% | 6.59% |
| Power | 38 | 55% | 2.37% |
| Mining | 31 | 68% | 7.06% |
| Energy | 25 | 76% | 9.15% |
| Capital Goods | 22 | 32% | -2.45% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 333 | 48.6% | 4.26% |
| QUALITY_GROWTH | 87 | 56.3% | 3.06% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 818 |
| Wins / Losses | 427 / 391 |
| Win Rate | 52.2% |
| Avg Return/Trade | 3.11% |
| XIRR (Filtered) | 24.1% |
| XIRR (No Filter) | 20.8% |
| Nifty XIRR | 8.5% |
| Alpha | +15.5% |
| Months Skipped | 9 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2022 | STRONG_BUY_DAY | 14 | 1.59% | -5.5% |
| May 2022 | SELECTIVE | 5 | -3.91% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -2.22% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 6.05% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 26 | 5.63% | 1.2% |
| Sep 2022 | SELECTIVE | 11 | 4.62% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 28 | -2.72% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 28 | 2.19% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 5.08% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.99% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 8.40% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.73% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 7.60% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 27 | 7.51% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 9.08% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -2.85% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 15.08% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 13.31% | 6.2% |
| Jan 2024 | BUY_DAY | 20 | 12.05% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 26 | 7.85% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 21 | -0.25% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 26 | 3.99% | -0.2% |
| May 2024 | BUY_DAY | 19 | 2.58% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | 1.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 27 | 8.37% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 27 | 2.19% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 8.84% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.13% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -8.73% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 5.05% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.43% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.09% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 1.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.66% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -2.60% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.88% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.71% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -3.17% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 221 | 57.9% | 2.15% | 76 (34%) | 104 (47%) | 41 (19%) |
| Mid-Term | 306 | 52.0% | 0.77% | 48 (16%) | 45 (15%) | 213 (70%) |
| Fundamental | 291 | 48.1% | 6.29% | 128 (44%) | 64 (22%) | 99 (34%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 113 | 58% | 5.53% |
| Banking | 96 | 33% | -1.33% |
| FMCG | 76 | 49% | 1.82% |
| Pharma | 72 | 47% | 0.63% |
| Auto | 63 | 63% | 6.07% |
| Finance | 50 | 60% | 4.37% |
| Mining | 42 | 69% | 7.87% |
| Power | 41 | 54% | 2.55% |
| Energy | 38 | 74% | 8.38% |
| Insurance | 29 | 52% | 3.08% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 432 | 52.5% | 5.07% |
| QUALITY_GROWTH | 80 | 51.2% | 1.44% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 903 |
| Wins / Losses | 471 / 432 |
| Win Rate | 52.2% |
| Avg Return/Trade | 2.96% |
| XIRR (Filtered) | 24.0% |
| XIRR (No Filter) | 21.7% |
| Nifty XIRR | 11.0% |
| Alpha | +12.9% |
| Months Skipped | 11 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2021 | STRONG_BUY_DAY | 10 | 5.91% | -1.6% |
| May 2021 | BUY_DAY | 7 | 1.56% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 10 | -1.06% | 0.7% |
| Jul 2021 | SELECTIVE | 4 | 3.19% | 0.5% |
| Aug 2021 | SELECTIVE | 4 | 2.16% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 10 | 4.75% | 2.7% |
| Oct 2021 | SELECTIVE | 4 | 12.00% | 1.7% |
| Nov 2021 | SELECTIVE | 4 | 0.00% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -4.81% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -11.65% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 14 | 1.59% | -5.5% |
| May 2022 | SELECTIVE | 6 | -3.85% | -2.6% |
| Jun 2022 | BUY_DAY | 10 | -2.22% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 6.05% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 28 | 5.63% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 5.43% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | 0.29% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | 2.39% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 7.53% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.99% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 8.23% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.73% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 7.60% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 28 | 7.39% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 9.19% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -2.76% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 15.08% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 27 | 13.71% | 6.2% |
| Jan 2024 | BUY_DAY | 20 | 13.19% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 26 | 7.85% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 21 | -0.25% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 27 | 3.99% | -0.2% |
| May 2024 | BUY_DAY | 20 | 0.78% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | 1.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 27 | 8.37% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 27 | 2.19% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 8.39% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.50% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -8.73% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 5.05% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.43% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.09% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 1.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.66% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -2.60% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.88% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.71% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -3.17% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 231 | 58.4% | 2.22% | 79 (34%) | 109 (47%) | 43 (19%) |
| Mid-Term | 379 | 51.5% | 0.78% | 58 (15%) | 57 (15%) | 264 (70%) |
| Fundamental | 293 | 48.1% | 6.35% | 130 (44%) | 66 (23%) | 97 (33%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 123 | 59% | 5.32% |
| Banking | 111 | 34% | -0.83% |
| FMCG | 79 | 49% | 1.63% |
| Pharma | 71 | 48% | 0.77% |
| Auto | 66 | 65% | 6.12% |
| Finance | 54 | 57% | 4.04% |
| Mining | 47 | 68% | 6.99% |
| Power | 45 | 53% | 2.83% |
| Energy | 37 | 70% | 7.52% |
| Metals | 36 | 78% | 8.50% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 441 | 52.8% | 5.09% |
| QUALITY_GROWTH | 83 | 51.8% | 1.59% |

---

## Part 3: Market Mood Filter Deep-Dive

### STAY_OUT Months Validation

The mood filter signals STAY_OUT when all 3 indicators (5-day return, above SMA20, above SMA50) are negative.

| Month | Nifty Monthly Return | Filter Correct? |
|-------|---------------------|------------------|
| Dec 2021 | 2.7% | NO (Nifty rose) |
| Mar 2022 | 8.7% | NO (Nifty rose) |
| Oct 2022 | 5.6% | NO (Nifty rose) |
| Feb 2023 | -1.6% | YES (Nifty fell) |
| Mar 2023 | 0.4% | NO (Nifty rose) |
| Mar 2025 | 3.5% | NO (Nifty rose) |
| Apr 2025 | 6.3% | NO (Nifty rose) |
| Aug 2025 | 0.2% | NO (Nifty rose) |
| Sep 2025 | 0.9% | NO (Nifty rose) |
| Oct 2025 | 3.7% | NO (Nifty rose) |
| Mar 2026 | N/A | N/A |

**Filter Accuracy (True Positive Rate):** 1/10 = 10%  
This means 10% of months the filter told us to stay out, Nifty actually declined.

### Mood Distribution (5-Year Horizon)

| Mood | Count | % of Months |
|------|-------|-------------|
| STRONG_BUY_DAY | 25 | 42% |
| SELECTIVE | 13 | 22% |
| BUY_DAY | 11 | 18% |
| STAY_OUT | 11 | 18% |

### XIRR Improvement from Filter per Horizon

| Horizon | XIRR (With Filter) | XIRR (No Filter) | Improvement | Months Skipped |
|---------|--------------------|--------------------|-------------|----------------|
| 1 Year | -1.4% | 13.3% | -14.7pp | 5 |
| 2 Years | -4.6% | 1.3% | -5.9pp | 6 |
| 3 Years | 24.9% | 24.4% | +0.6pp | 6 |
| 4 Years | 24.1% | 20.8% | +3.2pp | 9 |
| 5 Years | 24.0% | 21.7% | +2.3pp | 11 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| ONGC | 51 | 88% | 13.22% | 5 |
| HEROMOTOCO | 52 | 77% | 13.13% | 5 |
| HINDALCO | 10 | 100% | 11.68% | 4 |
| HINDPETRO | 9 | 78% | 11.36% | 3 |
| JINDALSTEL | 25 | 96% | 10.20% | 5 |
| OFSS | 71 | 70% | 9.62% | 5 |
| HCLTECH | 86 | 80% | 9.21% | 5 |
| M&M | 6 | 83% | 9.08% | 4 |
| HDFCLIFE | 12 | 100% | 8.22% | 5 |
| BAJAJHLDNG | 91 | 65% | 7.96% | 5 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| ABB | 52 | 10% | -7.01% | 5 |
| CHOLAFIN | 14 | 14% | -6.82% | 5 |
| KOTAKBANK | 7 | 0% | -5.96% | 5 |
| IOC | 10 | 0% | -5.78% | 5 |
| INDUSINDBK | 63 | 11% | -5.21% | 5 |
| MARUTI | 24 | 29% | -4.55% | 4 |
| TRENT | 28 | 14% | -4.47% | 5 |
| POWERGRID | 15 | 20% | -4.33% | 4 |
| TATACONSUM | 14 | 29% | -3.95% | 5 |
| TCS | 22 | 23% | -3.93% | 5 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 64 | 42.2% | 1.55% | 30 | 30.0% | -3.58% |
| 2 Years | 180 | 34.4% | -0.09% | 52 | 30.8% | -3.13% |
| 3 Years | 333 | 48.6% | 4.26% | 87 | 56.3% | 3.06% |
| 4 Years | 432 | 52.5% | 5.07% | 80 | 51.2% | 1.44% |
| 5 Years | 441 | 52.8% | 5.09% | 83 | 51.8% | 1.59% |

**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in 5/5 horizons. Consider overweighting DEEP_VALUE picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Metals | 80 | 80% | 7.69% | OVERWEIGHT |
| Energy | 111 | 71% | 7.54% | OVERWEIGHT |
| Mining | 134 | 68% | 6.82% | OVERWEIGHT |
| Auto | 219 | 63% | 5.99% | OVERWEIGHT |
| Internet | 33 | 61% | 5.43% | OVERWEIGHT |
| IT | 377 | 58% | 5.31% | OVERWEIGHT |
| Hospitality | 18 | 83% | 4.33% | OVERWEIGHT |
| Finance | 178 | 56% | 3.75% | OVERWEIGHT |
| Defence | 65 | 60% | 3.35% | OVERWEIGHT |
| Power | 151 | 55% | 3.20% | MAINTAIN |
| Insurance | 92 | 55% | 2.87% | OVERWEIGHT |
| Infrastructure | 43 | 53% | 2.16% | MAINTAIN |
| Diversified | 12 | 42% | 2.10% | NEUTRAL |
| Real Estate | 20 | 45% | 1.94% | NEUTRAL |
| FMCG | 257 | 48% | 1.39% | NEUTRAL |
| Chemicals | 51 | 37% | 0.92% | UNDERWEIGHT / EXCLUDE |
| Pharma | 258 | 48% | 0.47% | NEUTRAL |
| Consumer Durables | 11 | 45% | 0.15% | NEUTRAL |
| Cement | 66 | 23% | -0.16% | UNDERWEIGHT / EXCLUDE |
| Tourism | 79 | 24% | -0.93% | UNDERWEIGHT / EXCLUDE |
| Auto Components | 50 | 40% | -1.48% | NEUTRAL |
| Banking | 407 | 32% | -1.52% | UNDERWEIGHT / EXCLUDE |
| Renewable Energy | 20 | 35% | -2.18% | UNDERWEIGHT / EXCLUDE |
| Consumer | 31 | 39% | -2.97% | UNDERWEIGHT / EXCLUDE |
| Retail | 33 | 21% | -3.29% | UNDERWEIGHT / EXCLUDE |
| Capital Goods | 104 | 27% | -3.42% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 50 (33%) | 17 (11%) | 85 (56%) | 0 (0%) |
| 2 Years | 154 (41%) | 52 (14%) | 167 (45%) | 0 (0%) |
| 3 Years | 214 (32%) | 178 (27%) | 271 (41%) | 0 (0%) |
| 4 Years | 252 (31%) | 213 (26%) | 353 (43%) | 0 (0%) |
| 5 Years | 267 (30%) | 232 (26%) | 404 (45%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 33%
- Target Hit Rate: 21%
- Time Exit Rate: 46%

- **Holding Period Issue:** 46% time exits. Either extend holding periods or tighten targets to be more achievable.

### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Remove market mood filter | Costs 2.9pp on average; filter is reducing returns | -2.9pp |
| P1 | Widen stop loss from ATR x3 to ATR x4 | SL hit rate of 33% is excessive across all horizons | +2-5pp est. |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 21% target hits; more achievable targets improve realized gains | +1-3pp est. |
| P3 | Exclude consistent losers: ABB, CHOLAFIN, KOTAKBANK | These stocks lose money across 3+ horizons with <35% win rate | +1-2pp est. |
| P4 | Underweight sectors: Chemicals, Cement | Win rate below 40% consistently; these sectors drag portfolio returns | +1-3pp est. |
| P5 | Add trailing stop mechanism | Reduce time-exit losses; lock in gains on trending moves | +2-4pp est. |
| P6 | Earnings calendar filter | Avoid binary event risk; reduce SL exits near earnings dates | +1-2pp est. |

---

## Disclaimer

This multi-horizon paper trading simulation has the following limitations:

1. **Point-in-time fundamentals (fixed Apr 2026):** The simulation now uses historical annual/quarterly financial statements from Yahoo Finance, matched to each scan date with a 90-day filing lag for annuals and 45 days for quarterlies. Scan dates with no historical data available (pre ~2022-06 for most stocks) skip fundamental-gated trades rather than fall back to the current snapshot. See the `Fundamentals Coverage` table below.
2. **No transaction costs:** Real trading involves brokerage, STT, GST, SEBI charges, and slippage. For Nifty 100 stocks, estimate 0.05-0.10% round-trip costs per trade.
3. **Survivorship bias:** The Nifty 100 constituent list used is the current composition. Stocks that were removed from the index during the test period (due to poor performance) are not represented.
4. **No position sizing:** All trades are treated equally with fixed capital allocation. In practice, position sizing based on conviction, volatility, and portfolio risk would significantly affect returns.
5. **Execution assumption:** Trades are assumed to execute at the closing price on the scan date. In practice, orders may fill at different prices.
6. **SL/Target fill assumption:** When price gaps through SL or target, the simulation assumes fills at the exact SL/target level. In reality, gap fills would be worse.
7. **Market mood filter uses Nifty 50 index only.** A more sophisticated regime filter could incorporate VIX, yield curves, FII flows, and global market signals.

---

*Report generated on 2026-04-17T10:14:05.592Z by StarBhai Multi-Horizon Paper Trading Engine*
