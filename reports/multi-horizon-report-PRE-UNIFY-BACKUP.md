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
| 1 Year | 149 | 34.9% | -1.61% | -12.6% | 9.5% | -22.0% | 5 | 4.4% | -17.0pp |
| 2 Years | 365 | 35.3% | -1.22% | -10.8% | 5.3% | -16.1% | 6 | -3.6% | -7.1pp |
| 3 Years | 644 | 48.4% | 1.61% | 18.6% | 13.1% | +5.5% | 6 | 18.8% | -0.2pp |
| 4 Years | 804 | 48.8% | 1.72% | 18.2% | 8.5% | +9.7% | 9 | 17.6% | +0.6pp |
| 5 Years | 883 | 48.2% | 1.59% | 17.0% | 11.0% | +5.9% | 11 | 17.1% | -0.1pp |

**Key Observations:**

- Best absolute XIRR: **3 Years** at 18.6%
- Best alpha: **4 Years** at +9.7%
- Average filter value across all horizons: -4.8pp

### Portfolio by Category vs Nifty 50

Per-category XIRR across 1-4 year horizons (the window with 100% point-in-time fundamentals coverage). Alpha is category XIRR minus Nifty XIRR over the same window. All results use the market-mood-filtered variant.

| Horizon | Category | Trades | Win Rate | Avg Return | Portfolio XIRR | Nifty 50 XIRR | Alpha |
|---------|----------|-------:|---------:|-----------:|---------------:|--------------:|------:|
| 1 Year | Buy Now | 33 | 33.3% | -1.09% | -7.1% | 9.5% | -16.6% |
| 1 Year | Mid-Term | 58 | 37.9% | -0.77% | -10.7% | 9.5% | -20.2% |
| 1 Year | Quality Growth | 14 | 42.9% | -2.74% | -22.1% | 9.5% | -31.6% |
| 1 Year | Deep Value | 44 | 29.5% | -2.75% | -14.6% | 9.5% | -24.1% |
| 1 Year | All combined | 149 | 34.9% | -1.61% | -12.6% | 9.5% | -22.0% |
| 2 Years | Buy Now | 83 | 26.5% | -2.40% | -17.5% | 5.3% | -22.9% |
| 2 Years | Mid-Term | 141 | 41.8% | -0.97% | -15.4% | 5.3% | -20.7% |
| 2 Years | Quality Growth | 23 | 43.5% | -0.29% | -2.5% | 5.3% | -7.8% |
| 2 Years | Deep Value | 118 | 32.2% | -0.87% | -5.6% | 5.3% | -10.9% |
| 2 Years | All combined | 365 | 35.3% | -1.22% | -10.8% | 5.3% | -16.1% |
| 3 Years | Buy Now | 158 | 45.6% | 1.37% | 15.2% | 13.1% | +2.2% |
| 3 Years | Mid-Term | 243 | 52.3% | 0.64% | 14.4% | 13.1% | +1.4% |
| 3 Years | Quality Growth | 34 | 52.9% | 1.51% | 14.0% | 13.1% | +0.9% |
| 3 Years | Deep Value | 209 | 45.5% | 2.94% | 22.6% | 13.1% | +9.5% |
| 3 Years | All combined | 644 | 48.4% | 1.61% | 18.6% | 13.1% | +5.5% |
| 4 Years | Buy Now | 209 | 49.3% | 1.90% | 20.1% | 8.5% | +11.6% |
| 4 Years | Mid-Term | 306 | 49.7% | 0.42% | 8.1% | 8.5% | -0.4% |
| 4 Years | Quality Growth | 23 | 34.8% | -1.93% | -14.2% | 8.5% | -22.8% |
| 4 Years | Deep Value | 266 | 48.5% | 3.40% | 23.8% | 8.5% | +15.3% |
| 4 Years | All combined | 804 | 48.8% | 1.72% | 18.2% | 8.5% | +9.7% |

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
| Buy Now | **2.7% (-6.8)** | 1.1% (-8.3) | 2.1% (-7.4) | -8.1% (-17.6) | -7.1% (-16.6) |
| Mid-Term | **60.5% (+51.0)** | 17.0% (+7.5) | 15.1% (+5.6) | -7.2% (-16.7) | -10.7% (-20.2) |
| Quality Growth | -63.3% (-72.8) | -37.4% (-46.8) | -15.9% (-25.3) | **-15.1% (-24.6)** | -22.1% (-31.6) |
| Deep Value | **-11.6% (-21.0)** | -14.3% (-23.8) | -15.9% (-25.4) | -17.1% (-26.5) | -14.6% (-24.1) |

**2 Years** (Nifty XIRR: 5.3%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **4.9% (-0.5)** | -7.4% (-12.7) | -12.4% (-17.8) | -12.6% (-17.9) | -17.5% (-22.9) |
| Mid-Term | **5.8% (+0.4)** | -14.1% (-19.4) | -20.1% (-25.5) | -19.6% (-24.9) | -15.4% (-20.7) |
| Quality Growth | -25.8% (-31.2) | -2.7% (-8.1) | **-1.6% (-7.0)** | -5.0% (-10.4) | -2.5% (-7.8) |
| Deep Value | -1.9% (-7.3) | -3.8% (-9.2) | -2.1% (-7.5) | **3.9% (-1.4)** | -5.6% (-10.9) |

**3 Years** (Nifty XIRR: 13.1%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **39.9% (+26.9)** | 19.9% (+6.8) | 25.5% (+12.5) | 19.0% (+6.0) | 15.2% (+2.2) |
| Mid-Term | **33.3% (+20.2)** | 24.5% (+11.4) | 19.7% (+6.6) | 13.1% (+0.0) | 14.4% (+1.4) |
| Quality Growth | -8.9% (-21.9) | 10.5% (-2.6) | 12.8% (-0.2) | 13.2% (+0.1) | **14.0% (+0.9)** |
| Deep Value | 35.2% (+22.1) | 38.0% (+25.0) | **43.5% (+30.5)** | 36.9% (+23.8) | 22.6% (+9.5) |

**4 Years** (Nifty XIRR: 8.5%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **43.0% (+34.4)** | 23.3% (+14.8) | 27.4% (+18.9) | 23.7% (+15.2) | 20.1% (+11.6) |
| Mid-Term | **30.0% (+21.4)** | 8.0% (-0.6) | 8.3% (-0.3) | 2.9% (-5.6) | 8.1% (-0.4) |
| Quality Growth | -20.9% (-29.4) | -20.4% (-28.9) | -16.5% (-25.0) | **-14.2% (-22.8)** | -14.2% (-22.8) |
| Deep Value | 31.3% (+22.8) | **34.3% (+25.8)** | 32.3% (+23.7) | 31.3% (+22.8) | 23.8% (+15.3) |


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
| Total Trades | 149 |
| Wins / Losses | 52 / 97 |
| Win Rate | 34.9% |
| Avg Return/Trade | -1.61% |
| XIRR (Filtered) | -12.6% |
| XIRR (No Filter) | 4.4% |
| Nifty XIRR | 9.5% |
| Alpha | -22.0% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 0.90% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -1.38% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -2.57% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -7.22% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 22 | -1.91% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 22 | -3.91% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.28% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 33 | 33.3% | -1.09% | 16 (48%) | 5 (15%) | 12 (36%) |
| Mid-Term | 58 | 37.9% | -0.77% | 13 (22%) | 1 (2%) | 44 (76%) |
| Fundamental | 58 | 32.8% | -2.75% | 24 (41%) | 4 (7%) | 30 (52%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 27 | 26% | -3.96% |
| Pharma | 13 | 62% | 2.95% |
| Capital Goods | 13 | 8% | -7.14% |
| FMCG | 12 | 50% | 2.11% |
| Finance | 10 | 0% | -5.67% |
| IT | 9 | 44% | -3.09% |
| Auto | 9 | 78% | 3.15% |
| Insurance | 7 | 43% | -1.36% |
| Defence | 7 | 29% | -1.57% |
| Tourism | 6 | 0% | -4.83% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 66 | 33.3% | -1.84% |
| QUALITY_GROWTH | 25 | 32.0% | -2.95% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 365 |
| Wins / Losses | 129 / 236 |
| Win Rate | 35.3% |
| Avg Return/Trade | -1.22% |
| XIRR (Filtered) | -10.8% |
| XIRR (No Filter) | -3.6% |
| Nifty XIRR | 5.3% |
| Alpha | -16.1% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2024 | STRONG_BUY_DAY | 26 | 2.59% | -0.2% |
| May 2024 | BUY_DAY | 15 | -3.90% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -1.70% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 24 | 9.19% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 24 | -0.35% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 27 | 1.43% | 2.2% |
| Oct 2024 | BUY_DAY | 18 | -2.31% | -5.8% |
| Nov 2024 | SELECTIVE | 11 | -3.89% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.64% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.55% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.03% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 0.90% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.82% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.22% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -7.22% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 22 | -1.91% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 22 | -4.20% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.84% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 83 | 26.5% | -2.40% | 54 (65%) | 10 (12%) | 19 (23%) |
| Mid-Term | 141 | 41.8% | -0.97% | 50 (35%) | 7 (5%) | 84 (60%) |
| Fundamental | 141 | 34.0% | -0.78% | 62 (44%) | 10 (7%) | 69 (49%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 74 | 20% | -4.48% |
| Pharma | 40 | 43% | -1.07% |
| IT | 36 | 67% | 6.06% |
| FMCG | 34 | 38% | 0.23% |
| Auto | 24 | 42% | 0.69% |
| Power | 21 | 38% | -2.36% |
| Finance | 21 | 43% | -0.00% |
| Capital Goods | 14 | 14% | -4.91% |
| Mining | 12 | 42% | 1.39% |
| Cement | 12 | 0% | -5.07% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 176 | 30.7% | -1.39% |
| QUALITY_GROWTH | 48 | 33.3% | -1.33% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 644 |
| Wins / Losses | 312 / 332 |
| Win Rate | 48.4% |
| Avg Return/Trade | 1.61% |
| XIRR (Filtered) | 18.6% |
| XIRR (No Filter) | 18.8% |
| Nifty XIRR | 13.1% |
| Alpha | +5.5% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2023 | BUY_DAY | 21 | 0.71% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 25 | 4.62% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 23 | 4.85% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 29 | 7.52% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 25 | 2.50% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 27 | 7.62% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -2.92% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 14.05% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 28 | 9.70% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 9.01% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 9.52% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | 0.87% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 2.49% | -0.2% |
| May 2024 | BUY_DAY | 19 | -2.84% | 0.2% |
| Jun 2024 | BUY_DAY | 19 | -2.80% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 8.05% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.93% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 27 | 2.40% | 2.2% |
| Oct 2024 | BUY_DAY | 18 | -2.66% | -5.8% |
| Nov 2024 | SELECTIVE | 11 | -2.89% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.64% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.55% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.03% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 0.90% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.82% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.22% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -7.22% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -1.85% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 22 | -4.38% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 158 | 45.6% | 1.37% | 79 (50%) | 50 (32%) | 29 (18%) |
| Mid-Term | 243 | 52.3% | 0.64% | 70 (29%) | 20 (8%) | 153 (63%) |
| Fundamental | 243 | 46.5% | 2.74% | 91 (37%) | 29 (12%) | 123 (51%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 89 | 30% | -1.86% |
| IT | 79 | 62% | 5.11% |
| Pharma | 62 | 50% | 1.11% |
| FMCG | 61 | 41% | 0.50% |
| Auto | 52 | 58% | 3.76% |
| Finance | 42 | 57% | 2.54% |
| Mining | 36 | 67% | 7.00% |
| Power | 35 | 40% | -1.48% |
| Energy | 23 | 70% | 4.89% |
| Insurance | 21 | 57% | 3.30% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 317 | 46.1% | 2.50% |
| QUALITY_GROWTH | 84 | 46.4% | 1.06% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 804 |
| Wins / Losses | 392 / 412 |
| Win Rate | 48.8% |
| Avg Return/Trade | 1.72% |
| XIRR (Filtered) | 18.2% |
| XIRR (No Filter) | 17.6% |
| Nifty XIRR | 8.5% |
| Alpha | +9.7% |
| Months Skipped | 9 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2022 | STRONG_BUY_DAY | 13 | 0.79% | -5.5% |
| May 2022 | SELECTIVE | 4 | -2.41% | -2.6% |
| Jun 2022 | BUY_DAY | 8 | -6.48% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.43% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 28 | 4.88% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | -0.42% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -4.15% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.24% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -3.59% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 0.71% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 4.60% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 4.61% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 6.96% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 27 | 8.21% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -2.73% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 14.89% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 28 | 9.48% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 9.64% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 9.30% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | 0.87% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 2.49% | -0.2% |
| May 2024 | BUY_DAY | 19 | -2.84% | 0.2% |
| Jun 2024 | BUY_DAY | 19 | -2.80% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 8.05% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.93% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 27 | 2.40% | 2.2% |
| Oct 2024 | BUY_DAY | 18 | -2.66% | -5.8% |
| Nov 2024 | SELECTIVE | 11 | -2.89% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.64% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.55% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.03% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 0.90% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.82% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.22% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -7.22% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -1.85% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 22 | -4.38% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 209 | 49.3% | 1.90% | 98 (47%) | 71 (34%) | 40 (19%) |
| Mid-Term | 306 | 49.7% | 0.42% | 91 (30%) | 27 (9%) | 188 (61%) |
| Fundamental | 289 | 47.4% | 2.97% | 105 (36%) | 27 (9%) | 157 (54%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 101 | 56% | 4.00% |
| Banking | 92 | 30% | -1.94% |
| Pharma | 81 | 49% | 1.16% |
| FMCG | 75 | 44% | 1.25% |
| Auto | 63 | 60% | 3.87% |
| Finance | 49 | 53% | 1.86% |
| Mining | 45 | 62% | 5.76% |
| Power | 38 | 42% | -0.66% |
| Energy | 35 | 63% | 4.27% |
| Insurance | 29 | 48% | 2.64% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 416 | 49.8% | 2.99% |
| QUALITY_GROWTH | 82 | 40.2% | 0.16% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 883 |
| Wins / Losses | 426 / 457 |
| Win Rate | 48.2% |
| Avg Return/Trade | 1.59% |
| XIRR (Filtered) | 17.0% |
| XIRR (No Filter) | 17.1% |
| Nifty XIRR | 11.0% |
| Alpha | +5.9% |
| Months Skipped | 11 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2021 | STRONG_BUY_DAY | 10 | 5.61% | -1.6% |
| May 2021 | BUY_DAY | 7 | 0.65% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 10 | -0.19% | 0.7% |
| Jul 2021 | SELECTIVE | 4 | 3.96% | 0.5% |
| Aug 2021 | SELECTIVE | 4 | 2.20% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 10 | 5.07% | 2.7% |
| Oct 2021 | SELECTIVE | 4 | 6.11% | 1.7% |
| Nov 2021 | SELECTIVE | 4 | -12.20% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -4.50% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -9.02% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 13 | 0.79% | -5.5% |
| May 2022 | SELECTIVE | 6 | -3.92% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -6.48% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.43% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 29 | 4.88% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | -0.94% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -0.62% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -0.62% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -3.59% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 0.71% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 4.60% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 4.61% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 27 | 6.86% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 27 | 8.21% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -2.03% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 14.89% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 28 | 9.98% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 9.64% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 9.30% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | 0.87% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 26 | 2.23% | -0.2% |
| May 2024 | BUY_DAY | 19 | -3.15% | 0.2% |
| Jun 2024 | BUY_DAY | 19 | -2.80% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 8.31% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.93% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 27 | 2.40% | 2.2% |
| Oct 2024 | BUY_DAY | 18 | -2.66% | -5.8% |
| Nov 2024 | SELECTIVE | 11 | -2.89% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -0.64% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -9.55% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -8.03% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 0.90% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.82% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.22% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 15 | -7.22% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -1.85% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 22 | -4.38% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 212 | 49.1% | 1.91% | 100 (47%) | 71 (33%) | 41 (19%) |
| Mid-Term | 379 | 48.5% | 0.36% | 114 (30%) | 34 (9%) | 231 (61%) |
| Fundamental | 292 | 47.3% | 2.95% | 108 (37%) | 27 (9%) | 157 (54%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 111 | 56% | 3.87% |
| Banking | 105 | 30% | -1.77% |
| Pharma | 81 | 49% | 1.16% |
| FMCG | 79 | 44% | 1.02% |
| Auto | 66 | 62% | 4.11% |
| Finance | 53 | 51% | 1.64% |
| Mining | 47 | 60% | 5.12% |
| Power | 42 | 43% | 0.09% |
| Metals | 36 | 69% | 6.21% |
| Energy | 36 | 64% | 4.09% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 422 | 49.5% | 2.98% |
| QUALITY_GROWTH | 82 | 40.2% | 0.12% |

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
| 1 Year | -12.6% | 4.4% | -17.0pp | 5 |
| 2 Years | -10.8% | -3.6% | -7.1pp | 6 |
| 3 Years | 18.6% | 18.8% | -0.2pp | 6 |
| 4 Years | 18.2% | 17.6% | +0.6pp | 9 |
| 5 Years | 17.0% | 17.1% | -0.1pp | 11 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| M&M | 5 | 100% | 13.65% | 4 |
| HINDALCO | 10 | 100% | 10.70% | 4 |
| HDFCLIFE | 12 | 100% | 8.78% | 5 |
| HEROMOTOCO | 53 | 75% | 8.51% | 5 |
| ONGC | 48 | 75% | 8.43% | 5 |
| HCLTECH | 78 | 77% | 8.22% | 5 |
| JINDALSTEL | 25 | 96% | 8.04% | 5 |
| OFSS | 68 | 69% | 7.42% | 5 |
| INDHOTEL | 21 | 86% | 6.76% | 4 |
| CGPOWER | 22 | 64% | 5.94% | 5 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| ABB | 47 | 11% | -6.89% | 5 |
| PIDILITIND | 11 | 0% | -6.15% | 5 |
| SIEMENS | 26 | 8% | -5.54% | 5 |
| CHOLAFIN | 14 | 14% | -5.50% | 5 |
| LUPIN | 8 | 0% | -5.39% | 5 |
| INDUSINDBK | 63 | 5% | -5.28% | 5 |
| KOTAKBANK | 7 | 0% | -5.04% | 5 |
| JSWSTEEL | 11 | 9% | -4.36% | 5 |
| TRENT | 28 | 14% | -3.93% | 5 |
| CANBK | 81 | 20% | -3.92% | 5 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 66 | 33.3% | -1.84% | 25 | 32.0% | -2.95% |
| 2 Years | 176 | 30.7% | -1.39% | 48 | 33.3% | -1.33% |
| 3 Years | 317 | 46.1% | 2.50% | 84 | 46.4% | 1.06% |
| 4 Years | 416 | 49.8% | 2.99% | 82 | 40.2% | 0.16% |
| 5 Years | 422 | 49.5% | 2.98% | 82 | 40.2% | 0.12% |

**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in 4/5 horizons. Consider overweighting DEEP_VALUE picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Hospitality | 21 | 86% | 6.76% | OVERWEIGHT |
| Mining | 142 | 61% | 5.41% | OVERWEIGHT |
| Metals | 84 | 70% | 5.19% | OVERWEIGHT |
| IT | 336 | 58% | 4.25% | OVERWEIGHT |
| Internet | 26 | 62% | 4.24% | OVERWEIGHT |
| Energy | 106 | 63% | 3.93% | OVERWEIGHT |
| Auto | 214 | 59% | 3.53% | OVERWEIGHT |
| Diversified | 12 | 42% | 2.92% | NEUTRAL |
| Insurance | 95 | 52% | 2.20% | MAINTAIN |
| Finance | 175 | 49% | 1.30% | NEUTRAL |
| Infrastructure | 43 | 53% | 1.09% | MAINTAIN |
| Pharma | 277 | 49% | 0.91% | NEUTRAL |
| FMCG | 261 | 43% | 0.91% | NEUTRAL |
| Real Estate | 20 | 45% | 0.37% | NEUTRAL |
| Defence | 72 | 46% | 0.12% | NEUTRAL |
| Auto Components | 50 | 46% | -0.51% | NEUTRAL |
| Consumer Durables | 11 | 45% | -0.67% | NEUTRAL |
| Power | 140 | 41% | -0.87% | NEUTRAL |
| Tourism | 73 | 25% | -1.04% | UNDERWEIGHT / EXCLUDE |
| Chemicals | 48 | 31% | -1.07% | UNDERWEIGHT / EXCLUDE |
| Consumer | 35 | 46% | -1.28% | NEUTRAL |
| Banking | 387 | 28% | -2.50% | UNDERWEIGHT / EXCLUDE |
| Retail | 33 | 21% | -2.59% | UNDERWEIGHT / EXCLUDE |
| Cement | 60 | 15% | -2.69% | UNDERWEIGHT / EXCLUDE |
| Renewable Energy | 20 | 35% | -3.24% | UNDERWEIGHT / EXCLUDE |
| Capital Goods | 95 | 22% | -3.55% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 53 (36%) | 10 (7%) | 86 (58%) | 0 (0%) |
| 2 Years | 166 (45%) | 27 (7%) | 172 (47%) | 0 (0%) |
| 3 Years | 240 (37%) | 99 (15%) | 305 (47%) | 0 (0%) |
| 4 Years | 294 (37%) | 125 (16%) | 385 (48%) | 0 (0%) |
| 5 Years | 322 (36%) | 132 (15%) | 429 (49%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 38%
- Target Hit Rate: 12%
- Time Exit Rate: 50%

- **Stop Loss Too Tight:** 38% SL rate across all horizons suggests ATR x3 is not giving enough room. Consider widening to ATR x4 for mid-term, or using a trailing stop.
- **Targets Too Ambitious:** Only 12% of trades hit target. Consider reducing ATR target multiplier from 6x to 4.5x or 5x.
- **Holding Period Issue:** 50% time exits. Either extend holding periods or tighten targets to be more achievable.

### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Remove market mood filter | Costs 4.8pp on average; filter is reducing returns | -4.8pp |
| P1 | Widen stop loss from ATR x3 to ATR x4 | SL hit rate of 38% is excessive across all horizons | +2-5pp est. |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 12% target hits; more achievable targets improve realized gains | +1-3pp est. |
| P3 | Exclude consistent losers: ABB, PIDILITIND, SIEMENS | These stocks lose money across 3+ horizons with <35% win rate | +1-2pp est. |
| P4 | Underweight sectors: Tourism, Chemicals | Win rate below 40% consistently; these sectors drag portfolio returns | +1-3pp est. |
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

*Report generated on 2026-04-17T09:38:19.087Z by StarBhai Multi-Horizon Paper Trading Engine*
