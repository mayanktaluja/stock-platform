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
| 1 Year | 187 | 43.3% | 1.76% | 11.4% | 9.5% | +1.9% | 5 | 13.3% | -2.0pp |
| 2 Years | 423 | 39.5% | -0.14% | -0.9% | 5.3% | -6.2% | 6 | 1.3% | -2.2pp |
| 3 Years | 713 | 51.9% | 3.06% | 24.9% | 13.1% | +11.8% | 6 | 24.4% | +0.5pp |
| 4 Years | 898 | 52.2% | 3.30% | 24.5% | 8.5% | +15.9% | 9 | 20.8% | +3.6pp |
| 5 Years | 983 | 52.4% | 3.18% | 24.6% | 11.0% | +13.5% | 11 | 21.7% | +2.9pp |

**Key Observations:**

- Best absolute XIRR: **3 Years** at 24.9%
- Best alpha: **4 Years** at +15.9%
- Average filter value across all horizons: +0.6pp

### Portfolio by Category vs Nifty 50

Per-category XIRR across 1-4 year horizons (the window with 100% point-in-time fundamentals coverage). Alpha is category XIRR minus Nifty XIRR over the same window. All results use the market-mood-filtered variant.

| Horizon | Category | Trades | Win Rate | Avg Return | Portfolio XIRR | Nifty 50 XIRR | Alpha |
|---------|----------|-------:|---------:|-----------:|---------------:|--------------:|------:|
| 1 Year | Buy Now | 49 | 55.1% | 1.66% | 12.0% | 9.5% | +2.6% |
| 1 Year | Mid-Term | 58 | 41.4% | -0.54% | -7.2% | 9.5% | -16.6% |
| 1 Year | Quality Growth | 23 | 13.0% | -4.66% | -30.5% | 9.5% | -39.9% |
| 1 Year | Deep Value | 57 | 47.4% | 6.78% | 26.1% | 9.5% | +16.7% |
| 1 Year | All combined | 187 | 43.3% | 1.76% | 11.4% | 9.5% | +1.9% |
| 2 Years | Buy Now | 111 | 44.1% | -0.49% | -3.2% | 5.3% | -8.5% |
| 2 Years | Mid-Term | 141 | 46.1% | -0.63% | -9.5% | 5.3% | -14.9% |
| 2 Years | Quality Growth | 33 | 27.3% | -3.38% | -17.1% | 5.3% | -22.4% |
| 2 Years | Deep Value | 138 | 31.9% | 1.42% | 5.7% | 5.3% | +0.3% |
| 2 Years | All combined | 423 | 39.5% | -0.14% | -0.9% | 5.3% | -6.2% |
| 3 Years | Buy Now | 197 | 56.9% | 2.08% | 20.3% | 13.1% | +7.3% |
| 3 Years | Mid-Term | 243 | 55.6% | 1.19% | 26.6% | 13.1% | +13.6% |
| 3 Years | Quality Growth | 40 | 52.5% | 3.82% | 22.5% | 13.1% | +9.5% |
| 3 Years | Deep Value | 233 | 43.8% | 5.71% | 26.7% | 13.1% | +13.6% |
| 3 Years | All combined | 713 | 51.9% | 3.06% | 24.9% | 13.1% | +11.8% |
| 4 Years | Buy Now | 256 | 60.5% | 2.70% | 25.4% | 8.5% | +16.9% |
| 4 Years | Mid-Term | 306 | 52.0% | 0.77% | 14.0% | 8.5% | +5.4% |
| 4 Years | Quality Growth | 32 | 40.6% | 0.15% | 0.9% | 8.5% | -7.7% |
| 4 Years | Deep Value | 304 | 46.7% | 6.69% | 28.5% | 8.5% | +19.9% |
| 4 Years | All combined | 898 | 52.2% | 3.30% | 24.5% | 8.5% | +15.9% |

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
| Buy Now | -8.8% (-18.3) | 1.5% (-8.0) | 4.7% (-4.8) | **17.4% (+8.0)** | 12.0% (+2.6) |
| Mid-Term | **57.2% (+47.8)** | 15.7% (+6.2) | 19.6% (+10.1) | -1.8% (-11.3) | -7.2% (-16.6) |
| Quality Growth | -35.1% (-44.6) | -36.4% (-45.8) | -31.3% (-40.8) | **-30.5% (-39.9)** | -30.5% (-39.9) |
| Deep Value | 9.3% (-0.2) | 7.6% (-1.8) | 19.4% (+10.0) | **27.7% (+18.2)** | 26.1% (+16.7) |

**2 Years** (Nifty XIRR: 5.3%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **-0.1% (-5.5)** | -4.8% (-10.1) | -10.0% (-15.3) | -3.1% (-8.5) | -3.2% (-8.5) |
| Mid-Term | **4.0% (-1.4)** | -1.5% (-6.9) | -9.5% (-14.9) | -11.3% (-16.7) | -9.5% (-14.9) |
| Quality Growth | -27.8% (-33.1) | -22.8% (-28.1) | -20.5% (-25.8) | -18.5% (-23.8) | **-17.1% (-22.4)** |
| Deep Value | 8.6% (+3.2) | 10.8% (+5.5) | **13.3% (+8.0)** | 13.2% (+7.8) | 5.7% (+0.3) |

**3 Years** (Nifty XIRR: 13.1%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **42.6% (+29.6)** | 36.9% (+23.8) | 22.9% (+9.9) | 22.6% (+9.5) | 20.3% (+7.3) |
| Mid-Term | 39.3% (+26.2) | **50.8% (+37.8)** | 30.4% (+17.3) | 23.3% (+10.2) | 26.6% (+13.6) |
| Quality Growth | 2.6% (-10.4) | 14.7% (+1.7) | **23.4% (+10.4)** | 21.1% (+8.1) | 22.5% (+9.5) |
| Deep Value | 16.8% (+3.7) | 30.8% (+17.8) | **38.3% (+25.2)** | 36.0% (+23.0) | 26.7% (+13.6) |

**4 Years** (Nifty XIRR: 8.5%)

| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |
|----------|-------|-------|-------|-------|--------|
| Buy Now | **51.8% (+43.2)** | 36.7% (+28.2) | 23.1% (+14.5) | 29.6% (+21.1) | 25.4% (+16.9) |
| Mid-Term | **37.8% (+29.2)** | 21.6% (+13.0) | 13.2% (+4.7) | 7.9% (-0.6) | 14.0% (+5.4) |
| Quality Growth | 1.3% (-7.2) | **6.3% (-2.2)** | 1.8% (-6.7) | 0.9% (-7.7) | 0.9% (-7.7) |
| Deep Value | 25.0% (+16.4) | 27.6% (+19.0) | 30.3% (+21.7) | **33.5% (+24.9)** | 28.5% (+19.9) |


### Fundamentals Coverage

Stock×scanDate pairs where historical fundamentals were available as-of the scan date. Pairs without historical data skip fundamental-gated trades (they don't fall back to the current snapshot).

| Horizon | With Fundamentals | Without Fundamentals | Coverage % |
|---------|-------------------|----------------------|------------|
| 1 Year | 1188 | 0 | 100.0% |
| 2 Years | 2376 | 0 | 100.0% |
| 3 Years | 3558 | 6 | 99.8% |
| 4 Years | 4424 | 324 | 93.2% |
| 5 Years | 4424 | 1496 | 74.7% |

---

## Part 2: Individual Horizon Analysis

### 1 Year Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 187 |
| Wins / Losses | 81 / 106 |
| Win Rate | 43.3% |
| Avg Return/Trade | 1.76% |
| XIRR (Filtered) | 11.4% |
| XIRR (No Filter) | 13.3% |
| Nifty XIRR | 9.5% |
| Alpha | +1.9% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 10 | -3.39% | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 6.24% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 3.44% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.44% | -3.8% |
| Aug 2025 | STAY_OUT | 10 | 2.93% | 0.2% |
| Sep 2025 | STAY_OUT | 6 | 5.00% | 0.9% |
| Oct 2025 | STAY_OUT | 7 | 6.04% | 3.7% |
| Nov 2025 | BUY_DAY | 11 | 12.97% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | 1.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -3.58% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -3.28% | -0.9% |
| Mar 2026 | STAY_OUT | 6 | -0.57% | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 49 | 55.1% | 1.66% | 16 (33%) | 17 (35%) | 16 (33%) |
| Mid-Term | 58 | 41.4% | -0.54% | 7 (12%) | 2 (3%) | 49 (84%) |
| Fundamental | 80 | 37.5% | 3.49% | 43 (54%) | 9 (11%) | 28 (35%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 32 | 53% | 4.19% |
| Pharma | 27 | 52% | 1.32% |
| IT | 19 | 26% | -1.78% |
| FMCG | 14 | 50% | 1.33% |
| Auto | 14 | 86% | 14.98% |
| Capital Goods | 12 | 8% | -5.63% |
| Finance | 10 | 0% | -6.60% |
| Insurance | 9 | 67% | 2.84% |
| Defence | 7 | 29% | 0.71% |
| Tourism | 6 | 0% | -7.08% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 91 | 52.7% | 5.50% |
| QUALITY_GROWTH | 38 | 23.7% | -3.68% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 423 |
| Wins / Losses | 167 / 256 |
| Win Rate | 39.5% |
| Avg Return/Trade | -0.14% |
| XIRR (Filtered) | -0.9% |
| XIRR (No Filter) | 1.3% |
| Nifty XIRR | 5.3% |
| Alpha | -6.2% |
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
| Mar 2025 | STAY_OUT | 10 | 3.84% | 3.5% |
| Apr 2025 | STAY_OUT | 10 | 1.69% | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.71% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.71% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.68% | -3.8% |
| Aug 2025 | STAY_OUT | 10 | 0.77% | 0.2% |
| Sep 2025 | STAY_OUT | 7 | 16.75% | 0.9% |
| Oct 2025 | STAY_OUT | 7 | 8.32% | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.95% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 25 | -1.91% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -3.37% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -5.48% | -0.9% |
| Mar 2026 | STAY_OUT | 6 | -1.49% | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 111 | 44.1% | -0.49% | 50 (45%) | 30 (27%) | 31 (28%) |
| Mid-Term | 141 | 46.1% | -0.63% | 28 (20%) | 11 (8%) | 102 (72%) |
| Fundamental | 171 | 31.0% | 0.49% | 99 (58%) | 22 (13%) | 50 (29%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 95 | 32% | -1.59% |
| IT | 51 | 49% | 2.56% |
| Pharma | 50 | 38% | -1.41% |
| FMCG | 34 | 44% | 0.54% |
| Auto | 28 | 50% | 3.20% |
| Power | 26 | 65% | 8.18% |
| Finance | 19 | 47% | 0.74% |
| Capital Goods | 18 | 17% | -5.49% |
| Mining | 14 | 64% | 4.15% |
| Tourism | 13 | 0% | -9.77% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 223 | 37.7% | 0.95% |
| QUALITY_GROWTH | 59 | 30.5% | -3.06% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 713 |
| Wins / Losses | 370 / 343 |
| Win Rate | 51.9% |
| Avg Return/Trade | 3.06% |
| XIRR (Filtered) | 24.9% |
| XIRR (No Filter) | 24.4% |
| Nifty XIRR | 13.1% |
| Alpha | +11.8% |
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
| Mar 2025 | STAY_OUT | 10 | 3.84% | 3.5% |
| Apr 2025 | STAY_OUT | 10 | 0.53% | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.71% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.71% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.68% | -3.8% |
| Aug 2025 | STAY_OUT | 10 | 0.77% | 0.2% |
| Sep 2025 | STAY_OUT | 7 | 16.75% | 0.9% |
| Oct 2025 | STAY_OUT | 7 | 8.32% | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.95% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.87% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -3.45% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -4.53% | -0.9% |
| Mar 2026 | STAY_OUT | 6 | -1.49% | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 197 | 56.9% | 2.08% | 71 (36%) | 87 (44%) | 39 (20%) |
| Mid-Term | 243 | 55.6% | 1.19% | 37 (15%) | 37 (15%) | 169 (70%) |
| Fundamental | 273 | 45.1% | 5.43% | 129 (47%) | 65 (24%) | 79 (29%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 107 | 37% | 0.56% |
| IT | 102 | 60% | 5.68% |
| Pharma | 72 | 46% | 0.47% |
| FMCG | 65 | 43% | 0.24% |
| Auto | 53 | 62% | 6.93% |
| Finance | 44 | 66% | 6.59% |
| Power | 42 | 60% | 4.50% |
| Mining | 33 | 70% | 7.44% |
| Energy | 25 | 76% | 9.15% |
| Capital Goods | 24 | 29% | -3.02% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 376 | 48.9% | 4.38% |
| QUALITY_GROWTH | 94 | 54.3% | 2.64% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 898 |
| Wins / Losses | 469 / 429 |
| Win Rate | 52.2% |
| Avg Return/Trade | 3.30% |
| XIRR (Filtered) | 24.5% |
| XIRR (No Filter) | 20.8% |
| Nifty XIRR | 8.5% |
| Alpha | +15.9% |
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
| Oct 2022 | STAY_OUT | 10 | 3.03% | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 28 | -3.28% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 28 | 1.47% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 5.08% | -3.4% |
| Feb 2023 | STAY_OUT | 10 | 2.25% | -1.6% |
| Mar 2023 | STAY_OUT | 10 | -6.31% | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 3.86% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 8.85% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 4.26% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 9.51% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 27 | 8.64% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 10.20% | 1.0% |
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
| Mar 2025 | STAY_OUT | 10 | 3.84% | 3.5% |
| Apr 2025 | STAY_OUT | 10 | 0.53% | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.71% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.71% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.68% | -3.8% |
| Aug 2025 | STAY_OUT | 10 | 0.77% | 0.2% |
| Sep 2025 | STAY_OUT | 7 | 16.75% | 0.9% |
| Oct 2025 | STAY_OUT | 7 | 8.32% | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.95% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.87% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -3.45% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -4.53% | -0.9% |
| Mar 2026 | STAY_OUT | 6 | -1.49% | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 256 | 60.5% | 2.70% | 82 (32%) | 120 (47%) | 54 (21%) |
| Mid-Term | 306 | 52.0% | 0.77% | 48 (16%) | 45 (15%) | 213 (70%) |
| Fundamental | 336 | 46.1% | 6.07% | 156 (46%) | 68 (20%) | 112 (33%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 136 | 55% | 4.88% |
| Banking | 110 | 37% | 0.13% |
| Pharma | 88 | 44% | 1.19% |
| FMCG | 81 | 48% | 1.70% |
| Auto | 64 | 64% | 6.15% |
| Finance | 50 | 60% | 4.37% |
| Power | 45 | 58% | 4.52% |
| Mining | 45 | 71% | 8.17% |
| Energy | 40 | 75% | 8.52% |
| Insurance | 30 | 53% | 3.07% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 501 | 52.7% | 5.21% |
| QUALITY_GROWTH | 91 | 50.5% | 1.32% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 983 |
| Wins / Losses | 515 / 468 |
| Win Rate | 52.4% |
| Avg Return/Trade | 3.18% |
| XIRR (Filtered) | 24.6% |
| XIRR (No Filter) | 21.7% |
| Nifty XIRR | 11.0% |
| Alpha | +13.5% |
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
| Dec 2021 | STAY_OUT | 0 | -2.69% | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -4.81% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -11.65% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | -1.21% | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 14 | 1.59% | -5.5% |
| May 2022 | SELECTIVE | 6 | -3.85% | -2.6% |
| Jun 2022 | BUY_DAY | 10 | -2.22% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 6.05% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 28 | 5.63% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 5.43% | -2.6% |
| Oct 2022 | STAY_OUT | 10 | 3.53% | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -0.67% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | 2.09% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 7.53% | -3.4% |
| Feb 2023 | STAY_OUT | 10 | 1.23% | -1.6% |
| Mar 2023 | STAY_OUT | 10 | -5.61% | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 3.86% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 8.70% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 4.26% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 9.51% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 28 | 8.53% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 10.27% | 1.0% |
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
| Mar 2025 | STAY_OUT | 10 | 3.84% | 3.5% |
| Apr 2025 | STAY_OUT | 10 | 0.53% | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.71% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 6.71% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.68% | -3.8% |
| Aug 2025 | STAY_OUT | 10 | 0.77% | 0.2% |
| Sep 2025 | STAY_OUT | 7 | 16.75% | 0.9% |
| Oct 2025 | STAY_OUT | 7 | 8.32% | 3.7% |
| Nov 2025 | BUY_DAY | 15 | 7.95% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 26 | -1.87% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 23 | -3.45% | -4.7% |
| Feb 2026 | SELECTIVE | 10 | -4.53% | -0.9% |
| Mar 2026 | STAY_OUT | 6 | -1.49% | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 266 | 61.3% | 2.82% | 84 (32%) | 126 (47%) | 56 (21%) |
| Mid-Term | 379 | 51.5% | 0.78% | 58 (15%) | 57 (15%) | 264 (70%) |
| Fundamental | 338 | 46.4% | 6.15% | 157 (46%) | 70 (21%) | 111 (33%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 146 | 57% | 4.84% |
| Banking | 125 | 38% | 0.40% |
| Pharma | 87 | 45% | 1.31% |
| FMCG | 84 | 49% | 1.53% |
| Auto | 67 | 66% | 6.20% |
| Finance | 54 | 57% | 4.04% |
| Mining | 50 | 70% | 7.31% |
| Power | 49 | 57% | 4.62% |
| Energy | 39 | 72% | 7.66% |
| Metals | 38 | 79% | 8.76% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 511 | 53.2% | 5.24% |
| QUALITY_GROWTH | 93 | 51.6% | 1.59% |

---

## Part 3: Market Mood Filter Deep-Dive

### STAY_OUT Months Validation

The mood filter signals STAY_OUT when all 3 indicators (5-day return, above SMA20, above SMA50) are negative.

No STAY_OUT months recorded in the 5-year horizon.

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
| 1 Year | 11.4% | 13.3% | -2.0pp | 5 |
| 2 Years | -0.9% | 1.3% | -2.2pp | 6 |
| 3 Years | 24.9% | 24.4% | +0.5pp | 6 |
| 4 Years | 24.5% | 20.8% | +3.6pp | 9 |
| 5 Years | 24.6% | 21.7% | +2.9pp | 11 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| HEROMOTOCO | 57 | 79% | 14.46% | 5 |
| ONGC | 52 | 88% | 13.34% | 5 |
| HINDALCO | 10 | 100% | 11.68% | 4 |
| HINDPETRO | 9 | 78% | 11.36% | 3 |
| JINDALSTEL | 25 | 96% | 10.20% | 5 |
| HCLTECH | 92 | 80% | 9.55% | 5 |
| OFSS | 85 | 66% | 9.09% | 5 |
| M&M | 6 | 83% | 9.08% | 4 |
| TATASTEEL | 37 | 76% | 8.37% | 3 |
| HDFCLIFE | 12 | 100% | 8.22% | 5 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| ABB | 57 | 7% | -7.15% | 5 |
| CHOLAFIN | 14 | 14% | -6.82% | 5 |
| KOTAKBANK | 7 | 0% | -5.96% | 5 |
| IOC | 10 | 0% | -5.78% | 5 |
| TRENT | 29 | 14% | -4.71% | 5 |
| MARUTI | 24 | 29% | -4.55% | 4 |
| LUPIN | 8 | 13% | -4.48% | 5 |
| POWERGRID | 15 | 20% | -4.33% | 4 |
| INDUSINDBK | 66 | 18% | -4.01% | 5 |
| TATACONSUM | 14 | 29% | -3.95% | 5 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 91 | 52.7% | 5.50% | 38 | 23.7% | -3.68% |
| 2 Years | 223 | 37.7% | 0.95% | 59 | 30.5% | -3.06% |
| 3 Years | 376 | 48.9% | 4.38% | 94 | 54.3% | 2.64% |
| 4 Years | 501 | 52.7% | 5.21% | 91 | 50.5% | 1.32% |
| 5 Years | 511 | 53.2% | 5.24% | 93 | 51.6% | 1.59% |

**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in 5/5 horizons. Consider overweighting DEEP_VALUE picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Metals | 83 | 81% | 7.99% | OVERWEIGHT |
| Energy | 115 | 72% | 7.66% | OVERWEIGHT |
| Mining | 144 | 70% | 7.23% | OVERWEIGHT |
| Auto | 226 | 64% | 6.53% | OVERWEIGHT |
| Power | 167 | 59% | 5.27% | OVERWEIGHT |
| IT | 454 | 55% | 4.51% | MAINTAIN |
| Hospitality | 18 | 83% | 4.33% | OVERWEIGHT |
| Finance | 177 | 56% | 3.81% | OVERWEIGHT |
| Defence | 68 | 60% | 3.62% | OVERWEIGHT |
| Internet | 43 | 56% | 3.59% | OVERWEIGHT |
| Insurance | 98 | 58% | 3.08% | OVERWEIGHT |
| Infrastructure | 43 | 53% | 2.16% | MAINTAIN |
| Diversified | 12 | 42% | 2.10% | NEUTRAL |
| Real Estate | 21 | 43% | 1.68% | NEUTRAL |
| FMCG | 278 | 47% | 1.15% | NEUTRAL |
| Chemicals | 51 | 37% | 0.92% | UNDERWEIGHT / EXCLUDE |
| Pharma | 324 | 44% | 0.67% | NEUTRAL |
| Cement | 68 | 25% | 0.38% | UNDERWEIGHT / EXCLUDE |
| Banking | 469 | 37% | 0.23% | UNDERWEIGHT / EXCLUDE |
| Consumer Durables | 11 | 45% | 0.15% | NEUTRAL |
| Auto Components | 51 | 41% | -0.81% | NEUTRAL |
| Tourism | 80 | 24% | -1.06% | UNDERWEIGHT / EXCLUDE |
| Renewable Energy | 20 | 35% | -2.18% | UNDERWEIGHT / EXCLUDE |
| Consumer | 31 | 39% | -2.97% | UNDERWEIGHT / EXCLUDE |
| Retail | 34 | 21% | -3.53% | UNDERWEIGHT / EXCLUDE |
| Capital Goods | 109 | 25% | -3.66% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 66 (35%) | 28 (15%) | 93 (50%) | 0 (0%) |
| 2 Years | 177 (42%) | 63 (15%) | 183 (43%) | 0 (0%) |
| 3 Years | 237 (33%) | 189 (27%) | 287 (40%) | 0 (0%) |
| 4 Years | 286 (32%) | 233 (26%) | 379 (42%) | 0 (0%) |
| 5 Years | 299 (30%) | 253 (26%) | 431 (44%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 35%
- Target Hit Rate: 22%
- Time Exit Rate: 44%


### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Keep market mood filter | Adds 0.6pp on average; best in 4 Years (+3.6pp) | +0.6pp |
| P1 | Widen stop loss from ATR x3 to ATR x4 | SL hit rate of 35% is excessive across all horizons | +2-5pp est. |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 22% target hits; more achievable targets improve realized gains | +1-3pp est. |
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

*Report generated on 2026-04-17T11:07:07.941Z by StarBhai Multi-Horizon Paper Trading Engine*
