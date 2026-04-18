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
| 1 Year | 154 | 38.3% | -1.35% | -10.4% | 9.5% | -19.9% | 5 | 8.7% | -19.1pp |
| 2 Years | 378 | 38.6% | -1.12% | -9.4% | 5.3% | -14.8% | 6 | -0.8% | -8.6pp |
| 3 Years | 669 | 52.0% | 1.83% | 20.9% | 13.1% | +7.8% | 6 | 22.8% | -1.9pp |
| 4 Years | 830 | 52.5% | 1.96% | 20.6% | 8.5% | +12.1% | 9 | 19.9% | +0.7pp |
| 5 Years | 909 | 51.9% | 1.85% | 19.7% | 11.0% | +8.6% | 11 | 19.4% | +0.3pp |

**Key Observations:**

- Best absolute XIRR: **3 Years** at 20.9%
- Best alpha: **4 Years** at +12.1%
- Average filter value across all horizons: -5.7pp

### Portfolio by Category vs Nifty 50

Per-category XIRR across 1-4 year horizons (the window with 100% point-in-time fundamentals coverage). Alpha is category XIRR minus Nifty XIRR over the same window. All results use the market-mood-filtered variant.

| Horizon | Category | Trades | Win Rate | Avg Return | Portfolio XIRR | Nifty 50 XIRR | Alpha |
|---------|----------|-------:|---------:|-----------:|---------------:|--------------:|------:|
| 1 Year | Buy Now | 38 | 42.1% | -0.85% | -5.7% | 9.5% | -15.2% |
| 1 Year | Mid-Term | 58 | 41.4% | -0.60% | -8.0% | 9.5% | -17.5% |
| 1 Year | Quality Growth | 16 | 37.5% | -2.86% | -20.1% | 9.5% | -29.6% |
| 1 Year | Deep Value | 42 | 31.0% | -2.26% | -12.2% | 9.5% | -21.6% |
| 1 Year | All combined | 154 | 38.3% | -1.35% | -10.4% | 9.5% | -19.9% |
| 2 Years | Buy Now | 96 | 34.4% | -2.41% | -16.1% | 5.3% | -21.5% |
| 2 Years | Mid-Term | 141 | 46.1% | -0.63% | -9.5% | 5.3% | -14.9% |
| 2 Years | Quality Growth | 26 | 42.3% | 0.39% | 3.4% | 5.3% | -2.0% |
| 2 Years | Deep Value | 115 | 32.2% | -0.98% | -6.2% | 5.3% | -11.5% |
| 2 Years | All combined | 378 | 38.6% | -1.12% | -9.4% | 5.3% | -14.8% |
| 3 Years | Buy Now | 183 | 54.1% | 1.44% | 15.4% | 13.1% | +2.4% |
| 3 Years | Mid-Term | 243 | 55.6% | 1.17% | 26.0% | 13.1% | +12.9% |
| 3 Years | Quality Growth | 33 | 54.5% | 1.56% | 15.1% | 13.1% | +2.1% |
| 3 Years | Deep Value | 210 | 45.7% | 2.97% | 22.9% | 13.1% | +9.8% |
| 3 Years | All combined | 669 | 52.0% | 1.83% | 20.9% | 13.1% | +7.8% |
| 4 Years | Buy Now | 233 | 58.4% | 2.17% | 23.5% | 8.5% | +15.0% |
| 4 Years | Mid-Term | 306 | 52.9% | 0.87% | 16.0% | 8.5% | +7.5% |
| 4 Years | Quality Growth | 25 | 40.0% | -1.29% | -10.1% | 8.5% | -18.6% |
| 4 Years | Deep Value | 266 | 48.1% | 3.35% | 23.4% | 8.5% | +14.8% |
| 4 Years | All combined | 830 | 52.5% | 1.96% | 20.6% | 8.5% | +12.1% |

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
| Buy Now | **11.2% (+1.8)** | -17.8% (-27.3) | -23.4% (-32.9) | -13.2% (-22.7) | -5.7% (-15.2) |
| Mid-Term | **57.2% (+47.8)** | 15.7% (+6.2) | 19.6% (+10.1) | -1.1% (-10.6) | -8.0% (-17.5) |
| Quality Growth | -45.7% (-55.1) | -30.2% (-39.7) | -23.3% (-32.7) | -23.7% (-33.1) | **-20.1% (-29.6)** |
| Deep Value | **-7.1% (-16.6)** | -12.0% (-21.5) | -16.7% (-26.2) | -10.0% (-19.5) | -12.2% (-21.6) |

**2 Years** (Nifty XIRR: 5.3%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **-8.9% (-14.2)** | -14.7% (-20.1) | -24.6% (-29.9) | -19.9% (-25.3) | -16.1% (-21.5) |
| Mid-Term | **4.0% (-1.4)** | -1.5% (-6.9) | -9.5% (-14.9) | -11.3% (-16.7) | -9.5% (-14.9) |
| Quality Growth | -23.7% (-29.0) | 3.6% (-1.8) | **5.0% (-0.3)** | 1.3% (-4.1) | 3.4% (-2.0) |
| Deep Value | **8.5% (+3.2)** | 0.9% (-4.4) | 1.4% (-4.0) | 3.1% (-2.3) | -6.2% (-11.5) |

**3 Years** (Nifty XIRR: 13.1%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **64.2% (+51.1)** | 32.3% (+19.2) | 18.3% (+5.3) | 15.7% (+2.6) | 15.4% (+2.4) |
| Mid-Term | 37.5% (+24.4) | **45.9% (+32.8)** | 33.8% (+20.7) | 24.5% (+11.4) | 26.0% (+12.9) |
| Quality Growth | -8.9% (-21.9) | 10.5% (-2.6) | 12.8% (-0.2) | 13.2% (+0.1) | **15.1% (+2.1)** |
| Deep Value | 34.6% (+21.6) | 38.9% (+25.9) | **45.4% (+32.4)** | 37.3% (+24.3) | 22.9% (+9.8) |

**4 Years** (Nifty XIRR: 8.5%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **63.0% (+54.5)** | 40.8% (+32.3) | 25.9% (+17.4) | 26.6% (+18.0) | 23.5% (+15.0) |
| Mid-Term | **36.7% (+28.2)** | 19.7% (+11.2) | 14.1% (+5.6) | 8.1% (-0.5) | 16.0% (+7.5) |
| Quality Growth | -18.9% (-27.4) | -14.5% (-23.0) | -11.8% (-20.3) | **-10.1% (-18.6)** | -10.1% (-18.6) |
| Deep Value | 30.8% (+22.3) | **32.5% (+23.9)** | 31.2% (+22.7) | 30.6% (+22.0) | 23.4% (+14.8) |


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
| Total Trades | 154 |
| Wins / Losses | 59 / 95 |
| Win Rate | 38.3% |
| Avg Return/Trade | -1.35% |
| XIRR (Filtered) | -10.4% |
| XIRR (No Filter) | 8.7% |
| Nifty XIRR | 9.5% |
| Alpha | -19.9% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.17% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.58% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -2.98% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -9.62% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 25 | -1.18% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.53% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | 1.68% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 38 | 42.1% | -0.85% | 15 (39%) | 10 (26%) | 13 (34%) |
| Mid-Term | 58 | 41.4% | -0.60% | 7 (12%) | 2 (3%) | 49 (84%) |
| Fundamental | 58 | 32.8% | -2.43% | 24 (41%) | 3 (5%) | 31 (53%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 25 | 32% | -3.62% |
| Capital Goods | 15 | 7% | -7.75% |
| Pharma | 14 | 71% | 3.14% |
| IT | 13 | 46% | -0.70% |
| FMCG | 11 | 55% | 2.56% |
| Finance | 10 | 0% | -5.99% |
| Auto | 8 | 75% | 2.97% |
| Tourism | 8 | 0% | -6.04% |
| Insurance | 7 | 43% | -1.38% |
| Defence | 6 | 33% | -1.67% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 68 | 35.3% | -1.48% |
| QUALITY_GROWTH | 28 | 39.3% | -2.58% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 378 |
| Wins / Losses | 146 / 232 |
| Win Rate | 38.6% |
| Avg Return/Trade | -1.12% |
| XIRR (Filtered) | -9.4% |
| XIRR (No Filter) | -0.8% |
| Nifty XIRR | 5.3% |
| Alpha | -14.8% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2024 | STRONG_BUY_DAY | 27 | 3.83% | -0.2% |
| May 2024 | BUY_DAY | 14 | -3.81% | 0.2% |
| Jun 2024 | BUY_DAY | 18 | 2.43% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 9.27% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 25 | 0.57% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 1.24% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -5.02% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.89% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -10.92% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -9.00% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.17% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.88% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.42% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -9.62% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 25 | -1.18% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.53% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | 1.68% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 96 | 34.4% | -2.41% | 51 (53%) | 21 (22%) | 24 (25%) |
| Mid-Term | 141 | 46.1% | -0.63% | 28 (20%) | 11 (8%) | 102 (72%) |
| Fundamental | 141 | 34.0% | -0.73% | 62 (44%) | 10 (7%) | 69 (49%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 80 | 24% | -4.54% |
| Pharma | 42 | 40% | -1.37% |
| IT | 37 | 70% | 6.08% |
| FMCG | 34 | 41% | 0.19% |
| Auto | 24 | 46% | 0.47% |
| Power | 24 | 54% | 0.49% |
| Finance | 21 | 52% | 0.97% |
| Capital Goods | 16 | 13% | -6.11% |
| Mining | 12 | 42% | 1.35% |
| Tourism | 12 | 0% | -7.46% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 189 | 33.3% | -1.45% |
| QUALITY_GROWTH | 48 | 37.5% | -1.25% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 669 |
| Wins / Losses | 348 / 321 |
| Win Rate | 52.0% |
| Avg Return/Trade | 1.83% |
| XIRR (Filtered) | 20.9% |
| XIRR (No Filter) | 22.8% |
| Nifty XIRR | 13.1% |
| Alpha | +7.8% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2023 | BUY_DAY | 21 | 0.37% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 25 | 5.60% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 24 | 4.47% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 7.31% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 4.46% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 7.54% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -3.36% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 12.10% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 29 | 9.53% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 8.52% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 10.39% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 21 | 2.09% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 26 | 3.17% | -0.2% |
| May 2024 | BUY_DAY | 20 | -2.77% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | 0.49% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 27 | 8.56% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 27 | 0.90% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 2.49% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.40% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -4.08% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.89% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -10.92% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -9.00% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.17% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.88% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.42% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -9.62% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.16% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.71% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | 1.62% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 183 | 54.1% | 1.44% | 71 (39%) | 80 (44%) | 32 (17%) |
| Mid-Term | 243 | 55.6% | 1.17% | 36 (15%) | 37 (15%) | 170 (70%) |
| Fundamental | 243 | 46.9% | 2.77% | 91 (37%) | 30 (12%) | 122 (50%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 93 | 32% | -2.30% |
| IT | 85 | 66% | 5.27% |
| FMCG | 65 | 45% | 0.46% |
| Pharma | 64 | 52% | 1.31% |
| Auto | 52 | 62% | 3.64% |
| Finance | 42 | 62% | 3.34% |
| Power | 37 | 54% | 0.39% |
| Mining | 36 | 69% | 7.23% |
| Energy | 25 | 68% | 5.67% |
| Capital Goods | 22 | 27% | -3.24% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 343 | 48.7% | 2.31% |
| QUALITY_GROWTH | 83 | 55.4% | 1.75% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 830 |
| Wins / Losses | 436 / 394 |
| Win Rate | 52.5% |
| Avg Return/Trade | 1.96% |
| XIRR (Filtered) | 20.6% |
| XIRR (No Filter) | 19.9% |
| Nifty XIRR | 8.5% |
| Alpha | +12.1% |
| Months Skipped | 9 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2022 | STRONG_BUY_DAY | 14 | 1.59% | -5.5% |
| May 2022 | SELECTIVE | 5 | -3.91% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -2.22% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.43% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 27 | 5.34% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 2.23% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -2.99% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -0.99% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 2.62% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 0.37% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 5.61% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.73% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.68% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 27 | 8.34% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 8.09% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -3.13% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 12.58% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 29 | 9.34% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 9.18% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 10.23% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 21 | 2.09% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 26 | 3.17% | -0.2% |
| May 2024 | BUY_DAY | 20 | -2.77% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | 0.49% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 27 | 8.56% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 27 | 0.90% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 2.49% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.40% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -4.08% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.89% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -10.92% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -9.00% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.17% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.88% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.42% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -9.62% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.16% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.71% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | 1.62% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 233 | 58.4% | 2.17% | 80 (34%) | 110 (47%) | 43 (18%) |
| Mid-Term | 306 | 52.9% | 0.87% | 46 (15%) | 45 (15%) | 215 (70%) |
| Fundamental | 291 | 47.4% | 2.95% | 105 (36%) | 27 (9%) | 159 (55%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 106 | 61% | 4.27% |
| Banking | 97 | 33% | -2.26% |
| Pharma | 81 | 52% | 1.24% |
| FMCG | 78 | 46% | 1.05% |
| Auto | 61 | 64% | 3.85% |
| Finance | 49 | 57% | 2.30% |
| Mining | 45 | 67% | 6.30% |
| Power | 41 | 54% | 0.86% |
| Energy | 38 | 66% | 5.63% |
| Insurance | 28 | 54% | 3.61% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 445 | 52.6% | 2.92% |
| QUALITY_GROWTH | 79 | 50.6% | 0.84% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 909 |
| Wins / Losses | 472 / 437 |
| Win Rate | 51.9% |
| Avg Return/Trade | 1.85% |
| XIRR (Filtered) | 19.7% |
| XIRR (No Filter) | 19.4% |
| Nifty XIRR | 11.0% |
| Alpha | +8.6% |
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
| May 2022 | SELECTIVE | 7 | -4.99% | -2.6% |
| Jun 2022 | BUY_DAY | 10 | -2.22% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.43% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 28 | 5.34% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 1.91% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -0.48% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -0.03% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 2.62% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 0.37% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 5.61% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.73% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.68% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 28 | 8.25% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 8.21% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -3.08% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 12.58% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 29 | 9.79% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 9.18% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 10.23% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 21 | 2.09% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 27 | 3.17% | -0.2% |
| May 2024 | BUY_DAY | 20 | -3.28% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | 0.49% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 27 | 8.80% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 27 | 0.90% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 28 | 2.49% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.40% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -4.08% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.89% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -10.92% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -9.00% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.17% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.88% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.42% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -9.62% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.16% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -4.71% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | 1.62% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 236 | 58.5% | 2.20% | 81 (34%) | 111 (47%) | 44 (19%) |
| Mid-Term | 379 | 51.5% | 0.78% | 58 (15%) | 57 (15%) | 264 (70%) |
| Fundamental | 294 | 47.3% | 2.94% | 108 (37%) | 27 (9%) | 159 (54%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 117 | 62% | 4.15% |
| Banking | 110 | 33% | -1.97% |
| FMCG | 82 | 46% | 0.89% |
| Pharma | 81 | 52% | 1.24% |
| Auto | 65 | 65% | 3.91% |
| Finance | 53 | 55% | 2.12% |
| Mining | 47 | 66% | 6.11% |
| Power | 45 | 53% | 1.29% |
| Energy | 38 | 66% | 5.68% |
| Metals | 36 | 78% | 6.75% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 450 | 52.7% | 2.95% |
| QUALITY_GROWTH | 80 | 50.0% | 0.73% |

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
| 1 Year | -10.4% | 8.7% | -19.1pp | 5 |
| 2 Years | -9.4% | -0.8% | -8.6pp | 6 |
| 3 Years | 20.9% | 22.8% | -1.9pp | 6 |
| 4 Years | 20.6% | 19.9% | +0.7pp | 9 |
| 5 Years | 19.7% | 19.4% | +0.3pp | 11 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| M&M | 5 | 100% | 11.38% | 4 |
| HINDPETRO | 9 | 78% | 11.36% | 3 |
| ONGC | 50 | 80% | 9.91% | 5 |
| HINDALCO | 10 | 100% | 9.82% | 4 |
| HEROMOTOCO | 52 | 77% | 8.55% | 5 |
| HCLTECH | 82 | 80% | 8.25% | 5 |
| HDFCLIFE | 12 | 100% | 8.22% | 5 |
| JINDALSTEL | 25 | 96% | 7.90% | 5 |
| OFSS | 70 | 76% | 7.88% | 5 |
| LODHA | 8 | 63% | 6.25% | 3 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| ABB | 52 | 10% | -6.98% | 5 |
| CHOLAFIN | 14 | 14% | -6.82% | 5 |
| KOTAKBANK | 7 | 0% | -5.96% | 5 |
| SIEMENS | 31 | 16% | -5.82% | 5 |
| IOC | 10 | 0% | -5.78% | 5 |
| INDUSINDBK | 62 | 5% | -5.24% | 5 |
| MARUTI | 23 | 30% | -4.48% | 4 |
| TRENT | 28 | 14% | -4.47% | 5 |
| POWERGRID | 15 | 20% | -4.33% | 4 |
| CANBK | 81 | 25% | -3.97% | 5 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 68 | 35.3% | -1.48% | 28 | 39.3% | -2.58% |
| 2 Years | 189 | 33.3% | -1.45% | 48 | 37.5% | -1.25% |
| 3 Years | 343 | 48.7% | 2.31% | 83 | 55.4% | 1.75% |
| 4 Years | 445 | 52.6% | 2.92% | 79 | 50.6% | 0.84% |
| 5 Years | 450 | 52.7% | 2.95% | 80 | 50.0% | 0.73% |

**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in 4/5 horizons. Consider overweighting DEEP_VALUE picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Mining | 142 | 65% | 5.97% | OVERWEIGHT |
| Metals | 84 | 80% | 5.83% | OVERWEIGHT |
| Internet | 33 | 61% | 5.16% | OVERWEIGHT |
| Energy | 114 | 64% | 4.95% | OVERWEIGHT |
| IT | 358 | 63% | 4.47% | OVERWEIGHT |
| Hospitality | 18 | 83% | 4.33% | OVERWEIGHT |
| Auto | 210 | 62% | 3.40% | OVERWEIGHT |
| Insurance | 92 | 55% | 3.04% | OVERWEIGHT |
| Infrastructure | 43 | 53% | 2.16% | MAINTAIN |
| Diversified | 12 | 42% | 2.10% | NEUTRAL |
| Real Estate | 20 | 45% | 1.94% | NEUTRAL |
| Finance | 175 | 54% | 1.86% | MAINTAIN |
| Defence | 67 | 58% | 1.67% | MAINTAIN |
| Pharma | 282 | 51% | 0.96% | MAINTAIN |
| Power | 152 | 54% | 0.88% | MAINTAIN |
| FMCG | 270 | 46% | 0.81% | NEUTRAL |
| Chemicals | 51 | 37% | 0.46% | UNDERWEIGHT / EXCLUDE |
| Consumer Durables | 11 | 45% | 0.15% | NEUTRAL |
| Auto Components | 51 | 51% | -0.62% | NEUTRAL |
| Cement | 68 | 25% | -1.62% | UNDERWEIGHT / EXCLUDE |
| Consumer | 33 | 48% | -1.82% | NEUTRAL |
| Renewable Energy | 20 | 35% | -2.18% | UNDERWEIGHT / EXCLUDE |
| Tourism | 83 | 25% | -2.35% | UNDERWEIGHT / EXCLUDE |
| Banking | 405 | 31% | -2.72% | UNDERWEIGHT / EXCLUDE |
| Retail | 33 | 21% | -3.29% | UNDERWEIGHT / EXCLUDE |
| Capital Goods | 104 | 22% | -4.26% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 46 (30%) | 15 (10%) | 93 (60%) | 0 (0%) |
| 2 Years | 141 (37%) | 42 (11%) | 195 (52%) | 0 (0%) |
| 3 Years | 198 (30%) | 147 (22%) | 324 (48%) | 0 (0%) |
| 4 Years | 231 (28%) | 182 (22%) | 417 (50%) | 0 (0%) |
| 5 Years | 247 (27%) | 195 (21%) | 467 (51%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 30%
- Target Hit Rate: 17%
- Time Exit Rate: 52%

- **Targets Too Ambitious:** Only 17% of trades hit target. Consider reducing ATR target multiplier from 6x to 4.5x or 5x.
- **Holding Period Issue:** 52% time exits. Either extend holding periods or tighten targets to be more achievable.

### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Remove market mood filter | Costs 5.7pp on average; filter is reducing returns | -5.7pp |
| P1 | Widen stop loss from ATR x3 to ATR x4 | SL hit rate of 30% is excessive across all horizons | +2-5pp est. |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 17% target hits; more achievable targets improve realized gains | +1-3pp est. |
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

*Report generated on 2026-04-17T09:58:43.868Z by StarBhai Multi-Horizon Paper Trading Engine*
