# Multi-Horizon Paper Trading Report with Market Mood Filter

**Generated:** 2026-04-16  
**Data Period:** Oct 2020 - Apr 2026 (5.5 years of OHLCV)  
**Horizons Tested:** 1yr, 2yr, 3yr, 4yr, 5yr  
**Universe:** Nifty 100 stocks  
**Engine:** StarBhai production scoring engine  

---

## Part 1: Cross-Horizon Comparison

| Horizon | Trades (Filtered) | Win Rate | Avg Return | XIRR | Nifty XIRR | Alpha | Months Skipped | XIRR (No Filter) | Filter Value |
|---------|-------------------|----------|------------|------|------------|-------|----------------|-------------------|--------------|
| 1 Year | 174 | 27.6% | -1.79% | -14.5% | 9.5% | -24.0% | 5 | -7.4% | -7.2pp |
| 2 Years | 423 | 31.7% | -2.14% | -18.2% | 5.3% | -23.5% | 6 | -11.9% | -6.3pp |
| 3 Years | 723 | 43.4% | 0.61% | 6.8% | 13.1% | -6.3% | 6 | 6.9% | -0.1pp |
| 4 Years | 916 | 42.8% | 0.43% | 4.4% | 8.5% | -4.2% | 9 | 4.6% | -0.2pp |
| 5 Years | 1135 | 43.6% | 0.62% | 6.4% | 11.0% | -4.6% | 11 | 8.3% | -1.9pp |

**Key Observations:**

- Best absolute XIRR: **3 Years** at 6.8%
- Best alpha: **4 Years** at -4.2%
- Average filter value across all horizons: -3.1pp

---

## Part 2: Individual Horizon Analysis

### 1 Year Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 174 |
| Wins / Losses | 48 / 126 |
| Win Rate | 27.6% |
| Avg Return/Trade | -1.79% |
| XIRR (Filtered) | -14.5% |
| XIRR (No Filter) | -7.4% |
| Nifty XIRR | 9.5% |
| Alpha | -24.0% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.06% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.27% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -6.04% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.42% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 30 | -2.15% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.94% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 58 | 24.1% | -1.80% | 35 (60%) | 10 (17%) | 13 (22%) |
| Mid-Term | 58 | 37.9% | -0.77% | 13 (22%) | 1 (2%) | 44 (76%) |
| Fundamental | 58 | 20.7% | -2.80% | 30 (52%) | 1 (2%) | 27 (47%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 33 | 24% | -2.49% |
| IT | 23 | 26% | -2.94% |
| FMCG | 18 | 33% | 0.02% |
| Defence | 13 | 15% | -3.77% |
| Pharma | 11 | 55% | 0.04% |
| Finance | 10 | 10% | -4.16% |
| Insurance | 9 | 44% | -0.06% |
| Tourism | 8 | 0% | -4.88% |
| Auto | 8 | 50% | 4.62% |
| Real Estate | 7 | 14% | -3.33% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 104 | 22.1% | -2.35% |
| QUALITY_GROWTH | 12 | 25.0% | -1.87% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 423 |
| Wins / Losses | 134 / 289 |
| Win Rate | 31.7% |
| Avg Return/Trade | -2.14% |
| XIRR (Filtered) | -18.2% |
| XIRR (No Filter) | -11.9% |
| Nifty XIRR | 5.3% |
| Alpha | -23.5% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2024 | STRONG_BUY_DAY | 30 | 2.77% | -0.2% |
| May 2024 | BUY_DAY | 21 | -0.06% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | -3.40% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 3.29% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -2.79% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 1.32% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -3.35% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -1.91% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.67% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.05% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.69% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.43% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -4.01% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -6.04% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.42% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 30 | -2.15% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.94% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 141 | 24.1% | -2.31% | 94 (67%) | 21 (15%) | 26 (18%) |
| Mid-Term | 141 | 41.8% | -1.02% | 50 (35%) | 6 (4%) | 85 (60%) |
| Fundamental | 141 | 29.1% | -3.08% | 67 (48%) | 8 (6%) | 66 (47%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 68 | 46% | 0.08% |
| Banking | 61 | 23% | -3.78% |
| FMCG | 49 | 31% | -1.58% |
| Finance | 30 | 43% | -0.04% |
| Pharma | 28 | 43% | 0.04% |
| Insurance | 27 | 26% | -5.51% |
| Defence | 25 | 20% | -3.30% |
| Tourism | 23 | 4% | -7.18% |
| Real Estate | 22 | 32% | -0.58% |
| Cement | 18 | 6% | -6.58% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 266 | 26.7% | -2.67% |
| QUALITY_GROWTH | 16 | 25.0% | -3.05% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 723 |
| Wins / Losses | 314 / 409 |
| Win Rate | 43.4% |
| Avg Return/Trade | 0.61% |
| XIRR (Filtered) | 6.8% |
| XIRR (No Filter) | 6.9% |
| Nifty XIRR | 13.1% |
| Alpha | -6.3% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2023 | BUY_DAY | 21 | 0.46% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 1.72% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 27 | 4.22% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 8.35% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 28 | 3.95% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 5.42% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.48% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.83% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 9.42% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.91% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.51% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 29 | 1.27% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 30 | 1.36% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.04% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | -3.18% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 6.35% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -4.99% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 0.10% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -3.54% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -1.91% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.67% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.05% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.69% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.43% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -4.01% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -6.04% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.42% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 30 | -2.15% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.94% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 237 | 38.8% | 0.75% | 128 (54%) | 67 (28%) | 42 (18%) |
| Mid-Term | 243 | 51.9% | 0.62% | 71 (29%) | 20 (8%) | 152 (63%) |
| Fundamental | 243 | 39.5% | 0.48% | 94 (39%) | 32 (13%) | 117 (48%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 125 | 45% | 0.49% |
| Banking | 92 | 32% | -1.54% |
| FMCG | 90 | 38% | -0.52% |
| Finance | 55 | 51% | 2.59% |
| Insurance | 45 | 42% | 0.85% |
| Tourism | 40 | 28% | -2.20% |
| Pharma | 39 | 54% | 2.31% |
| Defence | 39 | 49% | 5.01% |
| Auto | 32 | 59% | 1.99% |
| Real Estate | 29 | 41% | 1.47% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 435 | 37.5% | 0.29% |
| QUALITY_GROWTH | 45 | 55.6% | 3.75% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 916 |
| Wins / Losses | 392 / 524 |
| Win Rate | 42.8% |
| Avg Return/Trade | 0.43% |
| XIRR (Filtered) | 4.4% |
| XIRR (No Filter) | 4.6% |
| Nifty XIRR | 8.5% |
| Alpha | -4.2% |
| Months Skipped | 9 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2022 | STRONG_BUY_DAY | 30 | -3.02% | -5.5% |
| May 2022 | SELECTIVE | 12 | -3.83% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -8.29% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 4.75% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 6.77% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 3.82% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | 3.05% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.62% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -5.34% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 0.46% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.55% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 5.45% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.01% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 29 | 5.56% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 4.99% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.48% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.83% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 9.42% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.91% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.51% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 29 | 1.27% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 30 | 1.36% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.04% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | -3.18% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 6.35% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -4.99% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 0.10% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -3.54% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -1.91% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.67% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.05% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.69% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.43% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -4.01% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -6.04% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.42% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 30 | -2.15% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.94% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 304 | 40.1% | 0.86% | 166 (55%) | 88 (29%) | 50 (16%) |
| Mid-Term | 306 | 49.7% | 0.44% | 90 (29%) | 27 (9%) | 189 (62%) |
| Fundamental | 306 | 38.6% | -0.01% | 130 (42%) | 35 (11%) | 141 (46%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 165 | 36% | -1.24% |
| FMCG | 112 | 42% | 0.32% |
| Banking | 98 | 35% | -0.98% |
| Finance | 80 | 50% | 1.69% |
| Insurance | 63 | 43% | 0.82% |
| Tourism | 59 | 37% | -0.92% |
| Defence | 50 | 52% | 5.73% |
| Pharma | 43 | 47% | 0.90% |
| Cement | 42 | 36% | -0.25% |
| Auto | 39 | 59% | 2.31% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 567 | 38.8% | 0.32% |
| QUALITY_GROWTH | 43 | 46.5% | 1.84% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1135 |
| Wins / Losses | 495 / 640 |
| Win Rate | 43.6% |
| Avg Return/Trade | 0.62% |
| XIRR (Filtered) | 6.4% |
| XIRR (No Filter) | 8.3% |
| Nifty XIRR | 11.0% |
| Alpha | -4.6% |
| Months Skipped | 11 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2021 | STRONG_BUY_DAY | 30 | 5.39% | -1.6% |
| May 2021 | BUY_DAY | 21 | 3.37% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 30 | 0.15% | 0.7% |
| Jul 2021 | SELECTIVE | 12 | 6.84% | 0.5% |
| Aug 2021 | SELECTIVE | 12 | 4.63% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 30 | 4.65% | 2.7% |
| Oct 2021 | SELECTIVE | 12 | 7.13% | 1.7% |
| Nov 2021 | SELECTIVE | 12 | 0.47% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 30 | -3.65% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 30 | -7.13% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 30 | -3.32% | -5.5% |
| May 2022 | SELECTIVE | 12 | -4.00% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -8.29% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 4.75% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 7.11% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 4.01% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | 3.05% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.62% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -5.34% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 0.46% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.55% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 5.45% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.01% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 29 | 5.56% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 4.99% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.48% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.83% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 9.42% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.91% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.51% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 29 | 1.27% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 30 | 1.36% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.04% | 0.2% |
| Jun 2024 | BUY_DAY | 21 | -3.18% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 6.35% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -4.99% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 0.10% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -3.54% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -1.91% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.67% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.05% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.69% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.74% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.43% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -4.01% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -6.04% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.42% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 30 | -2.15% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.94% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 377 | 40.6% | 0.88% | 204 (54%) | 109 (29%) | 64 (17%) |
| Mid-Term | 379 | 48.5% | 0.31% | 113 (30%) | 33 (9%) | 233 (61%) |
| Fundamental | 379 | 41.7% | 0.66% | 147 (39%) | 53 (14%) | 179 (47%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 214 | 42% | 0.15% |
| FMCG | 132 | 42% | 0.40% |
| Banking | 125 | 33% | -1.28% |
| Finance | 93 | 53% | 2.22% |
| Tourism | 67 | 40% | -0.08% |
| Insurance | 65 | 45% | 0.86% |
| Defence | 59 | 54% | 5.65% |
| Cement | 58 | 33% | -0.75% |
| Pharma | 54 | 50% | 1.60% |
| Auto | 50 | 52% | 1.38% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 696 | 40.8% | 0.72% |
| QUALITY_GROWTH | 60 | 45.0% | 1.35% |

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
| 1 Year | -14.5% | -7.4% | -7.2pp | 5 |
| 2 Years | -18.2% | -11.9% | -6.3pp | 6 |
| 3 Years | 6.8% | 6.9% | -0.1pp | 6 |
| 4 Years | 4.4% | 4.6% | -0.2pp | 9 |
| 5 Years | 6.4% | 8.3% | -1.9pp | 11 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| M&M | 5 | 100% | 13.65% | 4 |
| ADANIPOWER | 14 | 79% | 10.82% | 3 |
| HDFCLIFE | 12 | 100% | 8.78% | 5 |
| VEDL | 10 | 90% | 8.25% | 4 |
| ONGC | 8 | 100% | 7.86% | 5 |
| SUNPHARMA | 6 | 67% | 7.43% | 3 |
| INDHOTEL | 31 | 84% | 6.96% | 5 |
| ZYDUSLIFE | 48 | 65% | 5.74% | 5 |
| JINDALSTEL | 19 | 100% | 5.53% | 5 |
| CGPOWER | 14 | 64% | 5.44% | 5 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| SIEMENS | 15 | 13% | -6.16% | 4 |
| TECHM | 6 | 0% | -5.64% | 5 |
| CHOLAFIN | 14 | 14% | -5.50% | 5 |
| KOTAKBANK | 16 | 0% | -5.43% | 5 |
| LUPIN | 16 | 13% | -4.98% | 5 |
| JSWSTEEL | 11 | 9% | -4.36% | 5 |
| MARICO | 17 | 18% | -4.06% | 5 |
| TATACONSUM | 14 | 29% | -3.89% | 5 |
| POWERGRID | 15 | 20% | -3.69% | 4 |
| ULTRACEMCO | 13 | 0% | -3.51% | 5 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 104 | 22.1% | -2.35% | 12 | 25.0% | -1.87% |
| 2 Years | 266 | 26.7% | -2.67% | 16 | 25.0% | -3.05% |
| 3 Years | 435 | 37.5% | 0.29% | 45 | 55.6% | 3.75% |
| 4 Years | 567 | 38.8% | 0.32% | 43 | 46.5% | 1.84% |
| 5 Years | 696 | 40.8% | 0.72% | 60 | 45.0% | 1.35% |

**Finding:** QUALITY_GROWTH outperforms DEEP_VALUE in 4/5 horizons. Consider overweighting QUALITY_GROWTH picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Hospitality | 31 | 84% | 6.96% | OVERWEIGHT |
| Mining | 23 | 87% | 5.58% | OVERWEIGHT |
| Defence | 186 | 45% | 3.68% | NEUTRAL |
| Diversified | 13 | 46% | 3.00% | NEUTRAL |
| Metals | 50 | 68% | 2.49% | OVERWEIGHT |
| Auto | 145 | 54% | 1.72% | MAINTAIN |
| Finance | 268 | 49% | 1.65% | NEUTRAL |
| Pharma | 175 | 49% | 1.24% | NEUTRAL |
| Retail | 13 | 54% | 0.90% | MAINTAIN |
| Power | 85 | 38% | 0.53% | UNDERWEIGHT / EXCLUDE |
| Real Estate | 126 | 37% | 0.47% | UNDERWEIGHT / EXCLUDE |
| Energy | 58 | 55% | 0.22% | MAINTAIN |
| Insurance | 209 | 41% | -0.02% | NEUTRAL |
| FMCG | 401 | 39% | -0.09% | UNDERWEIGHT / EXCLUDE |
| IT | 595 | 41% | -0.29% | NEUTRAL |
| Infrastructure | 41 | 44% | -0.49% | NEUTRAL |
| Capital Goods | 45 | 36% | -1.06% | UNDERWEIGHT / EXCLUDE |
| Consumer | 15 | 60% | -1.07% | NEUTRAL |
| Cement | 151 | 28% | -1.47% | UNDERWEIGHT / EXCLUDE |
| Banking | 409 | 31% | -1.74% | UNDERWEIGHT / EXCLUDE |
| Tourism | 197 | 31% | -1.79% | UNDERWEIGHT / EXCLUDE |
| Auto Components | 41 | 34% | -2.05% | UNDERWEIGHT / EXCLUDE |
| Consumer Durables | 17 | 35% | -2.24% | UNDERWEIGHT / EXCLUDE |
| Chemicals | 46 | 28% | -2.91% | UNDERWEIGHT / EXCLUDE |
| Renewable Energy | 20 | 35% | -3.24% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 78 (45%) | 12 (7%) | 84 (48%) | 0 (0%) |
| 2 Years | 211 (50%) | 35 (8%) | 177 (42%) | 0 (0%) |
| 3 Years | 293 (41%) | 119 (16%) | 311 (43%) | 0 (0%) |
| 4 Years | 386 (42%) | 150 (16%) | 380 (41%) | 0 (0%) |
| 5 Years | 464 (41%) | 195 (17%) | 476 (42%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 44%
- Target Hit Rate: 13%
- Time Exit Rate: 43%

- **Stop Loss Too Tight:** 44% SL rate across all horizons suggests ATR x3 is not giving enough room. Consider widening to ATR x4 for mid-term, or using a trailing stop.
- **Targets Too Ambitious:** Only 13% of trades hit target. Consider reducing ATR target multiplier from 6x to 4.5x or 5x.

### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Remove market mood filter | Costs 3.1pp on average; filter is reducing returns | -3.1pp |
| P1 | Widen stop loss from ATR x3 to ATR x4 | SL hit rate of 44% is excessive across all horizons | +2-5pp est. |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 13% target hits; more achievable targets improve realized gains | +1-3pp est. |
| P3 | Exclude consistent losers: SIEMENS, TECHM, CHOLAFIN | These stocks lose money across 3+ horizons with <35% win rate | +1-2pp est. |
| P4 | Underweight sectors: Power, Real Estate | Win rate below 40% consistently; these sectors drag portfolio returns | +1-3pp est. |
| P5 | Add trailing stop mechanism | Reduce time-exit losses; lock in gains on trending moves | +2-4pp est. |
| P6 | Earnings calendar filter | Avoid binary event risk; reduce SL exits near earnings dates | +1-2pp est. |

---

## Disclaimer

This multi-horizon paper trading simulation has the following limitations:

1. **Historical fundamentals approximation:** The simulation uses the current (Apr 2026) fundamentals.json snapshot for all scans. In reality, fundamental scores changed significantly over time as earnings were reported quarterly. This introduces look-ahead bias; earlier horizon results should be interpreted with more caution.
2. **No transaction costs:** Real trading involves brokerage, STT, GST, SEBI charges, and slippage. For Nifty 100 stocks, estimate 0.05-0.10% round-trip costs per trade.
3. **Survivorship bias:** The Nifty 100 constituent list used is the current composition. Stocks that were removed from the index during the test period (due to poor performance) are not represented.
4. **No position sizing:** All trades are treated equally with fixed capital allocation. In practice, position sizing based on conviction, volatility, and portfolio risk would significantly affect returns.
5. **Execution assumption:** Trades are assumed to execute at the closing price on the scan date. In practice, orders may fill at different prices.
6. **SL/Target fill assumption:** When price gaps through SL or target, the simulation assumes fills at the exact SL/target level. In reality, gap fills would be worse.
7. **Market mood filter uses Nifty 50 index only.** A more sophisticated regime filter could incorporate VIX, yield curves, FII flows, and global market signals.

---

*Report generated on 2026-04-16T00:45:17.887Z by StarBhai Multi-Horizon Paper Trading Engine*
