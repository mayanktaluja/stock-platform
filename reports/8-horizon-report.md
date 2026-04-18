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
| 1 Year | 143 | 37.8% | -0.92% | -8.4% | 9.5% | -17.9% | 5 | 3.5% | -11.9pp |
| 2 Years | 354 | 37.0% | -1.02% | -10.4% | 5.3% | -15.8% | 6 | -5.3% | -5.1pp |
| 3 Years | 633 | 47.9% | 1.37% | 20.1% | 13.1% | +7.0% | 6 | 19.1% | +1.0pp |
| 4 Years | 789 | 47.0% | 1.23% | 16.2% | 8.5% | +7.6% | 9 | 14.4% | +1.8pp |
| 5 Years | 865 | 46.7% | 1.11% | 14.8% | 11.0% | +3.7% | 11 | 13.9% | +0.9pp |
| 6 Years | 961 | 48.3% | 1.34% | 21.1% | 20.9% | +0.2% | 12 | 25.9% | -4.7pp |
| 7 Years | 1039 | 47.8% | 1.17% | 16.1% | 11.7% | +4.4% | 15 | 21.6% | -5.5pp |
| 8 Years | 1130 | 47.5% | 1.02% | 12.9% | 12.0% | +0.8% | 16 | 17.9% | -5.0pp |

**Key Observations:**

- Best absolute XIRR: **6 Years** at 21.1%
- Best alpha: **4 Years** at +7.6%
- Average filter value across all horizons: -3.6pp

---

## Part 2: Individual Horizon Analysis

### 1 Year Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 143 |
| Wins / Losses | 54 / 89 |
| Win Rate | 37.8% |
| Avg Return/Trade | -0.92% |
| XIRR (Filtered) | -8.4% |
| XIRR (No Filter) | 3.5% |
| Nifty XIRR | 9.5% |
| Alpha | -17.9% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 19 | 0.04% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 28 | -2.44% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 22 | -0.99% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.39% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.03% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 27 | 48.1% | 0.61% | 0 (0%) | 5 (19%) | 4 (15%) |
| Mid-Term | 58 | 31.0% | -1.32% | 0 (0%) | 2 (3%) | 37 (64%) |
| Fundamental | 58 | 39.7% | -1.23% | 0 (0%) | 3 (5%) | 13 (22%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 18 | 28% | -3.12% |
| Pharma | 14 | 71% | 2.67% |
| Capital Goods | 13 | 8% | -6.29% |
| FMCG | 12 | 33% | 0.86% |
| IT | 11 | 55% | 0.39% |
| Auto | 10 | 60% | 1.70% |
| Finance | 10 | 10% | -4.95% |
| Defence | 7 | 43% | -1.16% |
| Insurance | 7 | 57% | -0.13% |
| Energy | 5 | 40% | 1.72% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 57 | 45.6% | -0.25% |
| QUALITY_GROWTH | 28 | 35.7% | -1.46% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 354 |
| Wins / Losses | 131 / 223 |
| Win Rate | 37.0% |
| Avg Return/Trade | -1.02% |
| XIRR (Filtered) | -10.4% |
| XIRR (No Filter) | -5.3% |
| Nifty XIRR | 5.3% |
| Alpha | -15.8% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2024 | STRONG_BUY_DAY | 25 | 1.72% | -0.2% |
| May 2024 | BUY_DAY | 14 | -2.23% | 0.2% |
| Jun 2024 | BUY_DAY | 15 | 0.99% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.72% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 24 | -0.32% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 2.51% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.50% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -4.41% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 22 | -0.99% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.33% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 2.36% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 72 | 34.7% | -1.07% | 0 (0%) | 14 (19%) | 7 (10%) |
| Mid-Term | 141 | 39.7% | -1.09% | 0 (0%) | 11 (8%) | 74 (52%) |
| Fundamental | 141 | 35.5% | -0.93% | 0 (0%) | 6 (4%) | 29 (21%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| Banking | 57 | 21% | -3.90% |
| Pharma | 42 | 48% | -0.00% |
| FMCG | 38 | 29% | -2.14% |
| IT | 37 | 68% | 4.91% |
| Finance | 27 | 52% | 0.88% |
| Auto | 26 | 38% | 0.26% |
| Power | 21 | 29% | -3.46% |
| Capital Goods | 15 | 13% | -4.32% |
| Mining | 12 | 33% | 0.53% |
| Energy | 9 | 44% | 0.22% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 159 | 36.5% | -0.53% |
| QUALITY_GROWTH | 54 | 31.5% | -2.28% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 633 |
| Wins / Losses | 303 / 330 |
| Win Rate | 47.9% |
| Avg Return/Trade | 1.37% |
| XIRR (Filtered) | 20.1% |
| XIRR (No Filter) | 19.1% |
| Nifty XIRR | 13.1% |
| Alpha | +7.0% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2023 | BUY_DAY | 21 | 1.10% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 27 | 2.70% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 24 | 3.10% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.68% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 24 | 3.65% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 26 | 5.54% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -1.52% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.17% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 8.67% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 7.22% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.80% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | -0.83% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 0.69% | -0.2% |
| May 2024 | BUY_DAY | 18 | -2.54% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -2.34% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.84% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.88% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 1.90% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.16% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -2.58% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -0.86% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.23% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.39% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 147 | 46.9% | 1.55% | 0 (0%) | 53 (36%) | 7 (5%) |
| Mid-Term | 243 | 50.2% | 0.73% | 0 (0%) | 37 (15%) | 128 (53%) |
| Fundamental | 243 | 46.1% | 1.90% | 0 (0%) | 19 (8%) | 53 (22%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 83 | 65% | 4.85% |
| Banking | 70 | 29% | -2.15% |
| FMCG | 65 | 40% | -0.25% |
| Pharma | 62 | 52% | 0.96% |
| Auto | 55 | 44% | 1.14% |
| Finance | 43 | 58% | 2.64% |
| Mining | 40 | 53% | 5.07% |
| Power | 34 | 41% | -1.64% |
| Energy | 23 | 65% | 6.50% |
| Insurance | 22 | 64% | 2.89% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 308 | 47.7% | 2.21% |
| QUALITY_GROWTH | 82 | 41.5% | 0.13% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 789 |
| Wins / Losses | 371 / 418 |
| Win Rate | 47.0% |
| Avg Return/Trade | 1.23% |
| XIRR (Filtered) | 16.2% |
| XIRR (No Filter) | 14.4% |
| Nifty XIRR | 8.5% |
| Alpha | +7.6% |
| Months Skipped | 9 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2022 | STRONG_BUY_DAY | 13 | -0.28% | -5.5% |
| May 2022 | SELECTIVE | 4 | -2.39% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -4.69% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.40% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 28 | 3.77% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 0.50% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -4.78% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.51% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 0.73% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.10% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.37% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.40% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 24 | 5.64% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 26 | 4.88% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -1.28% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.17% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 8.67% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 7.22% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.80% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | -0.83% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 0.69% | -0.2% |
| May 2024 | BUY_DAY | 18 | -2.54% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -2.34% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.84% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.88% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 1.90% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.16% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -2.58% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -0.86% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.23% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.39% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 193 | 46.6% | 1.50% | 0 (0%) | 67 (35%) | 9 (5%) |
| Mid-Term | 306 | 48.0% | 0.39% | 0 (0%) | 44 (14%) | 158 (52%) |
| Fundamental | 290 | 46.2% | 1.94% | 0 (0%) | 19 (7%) | 67 (23%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 108 | 56% | 3.05% |
| Pharma | 83 | 49% | 0.96% |
| FMCG | 77 | 42% | 0.52% |
| Banking | 74 | 30% | -2.10% |
| Auto | 65 | 46% | 1.66% |
| Finance | 50 | 56% | 1.38% |
| Mining | 45 | 51% | 4.27% |
| Power | 38 | 42% | -0.98% |
| Energy | 33 | 58% | 4.25% |
| Insurance | 28 | 57% | 2.11% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 389 | 47.3% | 2.07% |
| QUALITY_GROWTH | 94 | 42.6% | 0.47% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 865 |
| Wins / Losses | 404 / 461 |
| Win Rate | 46.7% |
| Avg Return/Trade | 1.11% |
| XIRR (Filtered) | 14.8% |
| XIRR (No Filter) | 13.9% |
| Nifty XIRR | 11.0% |
| Alpha | +3.7% |
| Months Skipped | 11 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2021 | STRONG_BUY_DAY | 10 | 5.96% | -1.6% |
| May 2021 | BUY_DAY | 7 | 1.39% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 10 | 0.09% | 0.7% |
| Jul 2021 | SELECTIVE | 4 | 3.19% | 0.5% |
| Aug 2021 | SELECTIVE | 4 | 2.98% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 10 | 4.55% | 2.7% |
| Oct 2021 | SELECTIVE | 4 | 12.00% | 1.7% |
| Nov 2021 | SELECTIVE | 4 | -9.73% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -5.58% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -10.48% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 13 | -0.28% | -5.5% |
| May 2022 | SELECTIVE | 6 | -3.47% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -4.69% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.40% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 29 | 4.15% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | -0.27% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -4.78% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.51% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 0.73% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.10% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.37% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.40% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 24 | 5.64% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 26 | 4.88% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -1.28% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.17% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 8.67% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 7.22% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.80% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | -0.83% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 0.69% | -0.2% |
| May 2024 | BUY_DAY | 18 | -2.54% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -2.34% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.84% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.88% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 1.90% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.16% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -2.58% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -0.86% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.23% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.39% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 194 | 46.4% | 1.45% | 0 (0%) | 67 (35%) | 9 (5%) |
| Mid-Term | 379 | 47.5% | 0.38% | 0 (0%) | 56 (15%) | 190 (50%) |
| Fundamental | 292 | 45.9% | 1.85% | 0 (0%) | 19 (7%) | 67 (23%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 117 | 56% | 3.04% |
| Banking | 84 | 29% | -2.19% |
| Pharma | 83 | 49% | 0.96% |
| FMCG | 82 | 43% | 0.48% |
| Auto | 69 | 48% | 1.82% |
| Finance | 54 | 54% | 1.27% |
| Mining | 47 | 49% | 3.66% |
| Power | 42 | 43% | -0.28% |
| Energy | 35 | 57% | 4.04% |
| Metals | 34 | 65% | 4.85% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 390 | 47.2% | 2.03% |
| QUALITY_GROWTH | 96 | 41.7% | 0.32% |

### 6 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 961 |
| Wins / Losses | 464 / 497 |
| Win Rate | 48.3% |
| Avg Return/Trade | 1.34% |
| XIRR (Filtered) | 21.1% |
| XIRR (No Filter) | 25.9% |
| Nifty XIRR | 20.9% |
| Alpha | +0.2% |
| Months Skipped | 12 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2020 | STAY_OUT | 0 | - | 22.0% |
| May 2020 | STRONG_BUY_DAY | 10 | -3.28% | 1.2% |
| Jun 2020 | STRONG_BUY_DAY | 10 | 4.81% | 4.5% |
| Jul 2020 | STRONG_BUY_DAY | 10 | 6.22% | 6.2% |
| Aug 2020 | BUY_DAY | 7 | 6.49% | 3.6% |
| Sep 2020 | BUY_DAY | 7 | 2.43% | -0.5% |
| Oct 2020 | STRONG_BUY_DAY | 10 | -0.95% | 3.5% |
| Nov 2020 | SELECTIVE | 4 | 18.80% | 11.0% |
| Dec 2020 | STRONG_BUY_DAY | 10 | 10.49% | 6.9% |
| Jan 2021 | STRONG_BUY_DAY | 10 | -0.84% | 4.5% |
| Feb 2021 | STRONG_BUY_DAY | 10 | 10.33% | 1.9% |
| Mar 2021 | BUY_DAY | 7 | -2.27% | -0.3% |
| Apr 2021 | STRONG_BUY_DAY | 10 | 5.96% | -1.6% |
| May 2021 | BUY_DAY | 7 | 1.39% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 10 | 0.09% | 0.7% |
| Jul 2021 | SELECTIVE | 4 | 3.19% | 0.5% |
| Aug 2021 | SELECTIVE | 4 | 2.98% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 10 | 4.55% | 2.7% |
| Oct 2021 | SELECTIVE | 4 | 12.00% | 1.7% |
| Nov 2021 | SELECTIVE | 4 | -9.73% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -5.58% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -10.48% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 13 | -0.28% | -5.5% |
| May 2022 | SELECTIVE | 6 | -3.47% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -4.69% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.40% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 5.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | -0.42% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -3.18% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.66% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 0.73% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.10% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.37% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.40% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 24 | 5.64% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 26 | 4.88% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -1.28% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.17% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 8.67% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 7.22% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.80% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | -0.83% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 0.69% | -0.2% |
| May 2024 | BUY_DAY | 18 | -2.54% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -2.34% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.84% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.88% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 1.90% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.16% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -2.58% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -0.86% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.23% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.39% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 195 | 46.2% | 1.45% | 0 (0%) | 68 (35%) | 9 (5%) |
| Mid-Term | 474 | 50.4% | 0.95% | 0 (0%) | 74 (16%) | 245 (52%) |
| Fundamental | 292 | 46.2% | 1.90% | 0 (0%) | 20 (7%) | 65 (22%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 126 | 58% | 3.30% |
| Banking | 100 | 34% | -1.05% |
| Pharma | 93 | 52% | 1.29% |
| FMCG | 87 | 41% | 0.30% |
| Auto | 80 | 51% | 1.93% |
| Finance | 57 | 54% | 1.35% |
| Mining | 49 | 49% | 3.39% |
| Power | 44 | 45% | -0.08% |
| Energy | 40 | 53% | 3.06% |
| Capital Goods | 33 | 42% | 0.45% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 391 | 47.3% | 2.06% |
| QUALITY_GROWTH | 96 | 41.7% | 0.32% |

### 7 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1039 |
| Wins / Losses | 497 / 542 |
| Win Rate | 47.8% |
| Avg Return/Trade | 1.17% |
| XIRR (Filtered) | 16.1% |
| XIRR (No Filter) | 21.6% |
| Nifty XIRR | 11.7% |
| Alpha | +4.4% |
| Months Skipped | 15 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2019 | STRONG_BUY_DAY | 10 | -1.49% | 1.0% |
| May 2019 | BUY_DAY | 7 | 0.95% | 1.8% |
| Jun 2019 | STRONG_BUY_DAY | 10 | -3.58% | -0.5% |
| Jul 2019 | STRONG_BUY_DAY | 10 | -4.57% | -7.5% |
| Aug 2019 | STAY_OUT | 0 | - | 0.4% |
| Sep 2019 | BUY_DAY | 7 | -2.88% | 3.1% |
| Oct 2019 | BUY_DAY | 7 | 4.41% | 4.7% |
| Nov 2019 | STRONG_BUY_DAY | 10 | -1.30% | 1.4% |
| Dec 2019 | STRONG_BUY_DAY | 10 | -0.28% | 1.4% |
| Jan 2020 | BUY_DAY | 7 | 2.33% | -2.2% |
| Feb 2020 | STAY_OUT | 0 | - | -6.9% |
| Mar 2020 | STAY_OUT | 0 | - | -27.4% |
| Apr 2020 | STAY_OUT | 0 | - | 22.0% |
| May 2020 | STRONG_BUY_DAY | 10 | -3.28% | 1.2% |
| Jun 2020 | STRONG_BUY_DAY | 10 | 4.81% | 4.5% |
| Jul 2020 | STRONG_BUY_DAY | 10 | 6.22% | 6.2% |
| Aug 2020 | BUY_DAY | 7 | 6.49% | 3.6% |
| Sep 2020 | BUY_DAY | 7 | 2.43% | -0.5% |
| Oct 2020 | STRONG_BUY_DAY | 10 | -0.95% | 3.5% |
| Nov 2020 | SELECTIVE | 4 | 18.80% | 11.0% |
| Dec 2020 | STRONG_BUY_DAY | 10 | 10.49% | 6.9% |
| Jan 2021 | STRONG_BUY_DAY | 10 | -0.84% | 4.5% |
| Feb 2021 | STRONG_BUY_DAY | 10 | 10.33% | 1.9% |
| Mar 2021 | BUY_DAY | 7 | -2.27% | -0.3% |
| Apr 2021 | STRONG_BUY_DAY | 10 | 5.96% | -1.6% |
| May 2021 | BUY_DAY | 7 | 1.39% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 10 | 0.09% | 0.7% |
| Jul 2021 | SELECTIVE | 4 | 3.19% | 0.5% |
| Aug 2021 | SELECTIVE | 4 | 2.98% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 10 | 4.55% | 2.7% |
| Oct 2021 | SELECTIVE | 4 | 12.00% | 1.7% |
| Nov 2021 | SELECTIVE | 4 | -9.73% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -5.58% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -10.48% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 13 | -0.28% | -5.5% |
| May 2022 | SELECTIVE | 6 | -3.47% | -2.6% |
| Jun 2022 | BUY_DAY | 9 | -4.69% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.40% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 5.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | -0.42% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -3.18% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.64% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 0.73% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.10% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.37% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.40% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 24 | 5.64% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 26 | 4.88% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -1.28% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.17% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 8.62% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 7.22% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.80% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | -0.83% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 0.69% | -0.2% |
| May 2024 | BUY_DAY | 18 | -2.54% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -2.34% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.84% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.88% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 1.90% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.16% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -2.58% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -0.86% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.23% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.39% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 195 | 46.2% | 1.46% | 0 (0%) | 68 (35%) | 9 (5%) |
| Mid-Term | 552 | 49.3% | 0.68% | 0 (0%) | 78 (14%) | 293 (53%) |
| Fundamental | 292 | 46.2% | 1.89% | 0 (0%) | 20 (7%) | 65 (22%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 130 | 58% | 3.13% |
| Banking | 107 | 36% | -0.94% |
| Pharma | 100 | 50% | 1.07% |
| FMCG | 92 | 42% | 0.41% |
| Auto | 83 | 51% | 1.89% |
| Finance | 61 | 52% | 1.01% |
| Mining | 50 | 50% | 3.35% |
| Energy | 47 | 51% | 2.40% |
| Power | 46 | 46% | -0.01% |
| Metals | 38 | 58% | 3.57% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 390 | 47.4% | 2.09% |
| QUALITY_GROWTH | 97 | 41.2% | 0.24% |

### 8 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1130 |
| Wins / Losses | 537 / 593 |
| Win Rate | 47.5% |
| Avg Return/Trade | 1.02% |
| XIRR (Filtered) | 12.9% |
| XIRR (No Filter) | 17.9% |
| Nifty XIRR | 12.0% |
| Alpha | +0.8% |
| Months Skipped | 16 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2018 | STAY_OUT | 0 | - | 5.4% |
| May 2018 | STRONG_BUY_DAY | 10 | -0.09% | 0.2% |
| Jun 2018 | STRONG_BUY_DAY | 10 | -2.11% | 0.2% |
| Jul 2018 | SELECTIVE | 4 | 6.53% | 5.9% |
| Aug 2018 | STRONG_BUY_DAY | 10 | 0.74% | 2.9% |
| Sep 2018 | STRONG_BUY_DAY | 10 | -5.22% | -5.8% |
| Oct 2018 | SELECTIVE | 4 | -10.71% | -4.1% |
| Nov 2018 | BUY_DAY | 7 | 1.26% | 3.1% |
| Dec 2018 | STRONG_BUY_DAY | 10 | -1.35% | -1.9% |
| Jan 2019 | SELECTIVE | 4 | 0.80% | 2.1% |
| Feb 2019 | STRONG_BUY_DAY | 10 | -1.28% | -0.3% |
| Mar 2019 | STRONG_BUY_DAY | 10 | 3.64% | 6.8% |
| Apr 2019 | STRONG_BUY_DAY | 10 | -1.49% | 1.0% |
| May 2019 | BUY_DAY | 7 | 0.95% | 1.8% |
| Jun 2019 | STRONG_BUY_DAY | 10 | -3.58% | -0.5% |
| Jul 2019 | STRONG_BUY_DAY | 10 | -4.57% | -7.5% |
| Aug 2019 | STAY_OUT | 0 | - | 0.4% |
| Sep 2019 | BUY_DAY | 7 | -2.88% | 3.1% |
| Oct 2019 | BUY_DAY | 7 | 4.41% | 4.7% |
| Nov 2019 | STRONG_BUY_DAY | 10 | -1.30% | 1.4% |
| Dec 2019 | STRONG_BUY_DAY | 10 | -0.28% | 1.4% |
| Jan 2020 | BUY_DAY | 7 | 2.33% | -2.2% |
| Feb 2020 | STAY_OUT | 0 | - | -6.9% |
| Mar 2020 | STAY_OUT | 0 | - | -27.4% |
| Apr 2020 | STAY_OUT | 0 | - | 22.0% |
| May 2020 | STRONG_BUY_DAY | 10 | -3.28% | 1.2% |
| Jun 2020 | STRONG_BUY_DAY | 10 | 4.81% | 4.5% |
| Jul 2020 | STRONG_BUY_DAY | 10 | 6.22% | 6.2% |
| Aug 2020 | BUY_DAY | 7 | 6.49% | 3.6% |
| Sep 2020 | BUY_DAY | 7 | 2.43% | -0.5% |
| Oct 2020 | STRONG_BUY_DAY | 10 | -0.95% | 3.5% |
| Nov 2020 | SELECTIVE | 4 | 18.80% | 11.0% |
| Dec 2020 | STRONG_BUY_DAY | 10 | 10.49% | 6.9% |
| Jan 2021 | STRONG_BUY_DAY | 10 | -0.84% | 4.5% |
| Feb 2021 | STRONG_BUY_DAY | 10 | 10.33% | 1.9% |
| Mar 2021 | BUY_DAY | 7 | -2.27% | -0.3% |
| Apr 2021 | STRONG_BUY_DAY | 10 | 5.96% | -1.6% |
| May 2021 | BUY_DAY | 7 | 1.39% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 10 | 0.09% | 0.7% |
| Jul 2021 | SELECTIVE | 4 | 3.19% | 0.5% |
| Aug 2021 | SELECTIVE | 4 | 2.98% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 10 | 4.55% | 2.7% |
| Oct 2021 | SELECTIVE | 4 | 12.00% | 1.7% |
| Nov 2021 | SELECTIVE | 4 | -9.73% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 10 | -5.58% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 10 | -10.48% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 13 | -0.28% | -5.5% |
| May 2022 | SELECTIVE | 7 | -3.47% | -2.6% |
| Jun 2022 | BUY_DAY | 10 | -4.09% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 7.40% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 4.88% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | -0.04% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 29 | -3.18% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -1.64% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | 0.73% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 1.10% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.37% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 28 | 3.40% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 6.75% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 24 | 5.64% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 26 | 4.88% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -2.03% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | 11.17% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 26 | 8.62% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 7.22% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 27 | 8.80% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 20 | -0.83% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 25 | 0.69% | -0.2% |
| May 2024 | BUY_DAY | 18 | -2.54% | 0.2% |
| Jun 2024 | BUY_DAY | 17 | -2.34% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 25 | 6.84% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 26 | 0.88% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 24 | 1.90% | 2.2% |
| Oct 2024 | BUY_DAY | 16 | -3.16% | -5.8% |
| Nov 2024 | SELECTIVE | 10 | -2.58% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | -1.48% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -7.44% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -6.85% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 2.04% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | 1.23% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -1.30% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 14 | -8.37% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 23 | -0.86% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 21 | -3.23% | -4.7% |
| Feb 2026 | SELECTIVE | 9 | 1.39% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 195 | 46.2% | 1.46% | 0 (0%) | 68 (35%) | 9 (5%) |
| Mid-Term | 641 | 48.5% | 0.49% | 0 (0%) | 84 (13%) | 349 (54%) |
| Fundamental | 294 | 46.3% | 1.88% | 0 (0%) | 20 (7%) | 67 (23%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 143 | 57% | 2.78% |
| Banking | 117 | 35% | -1.04% |
| Pharma | 111 | 50% | 0.84% |
| FMCG | 102 | 42% | 0.21% |
| Auto | 88 | 50% | 1.74% |
| Finance | 67 | 54% | 1.49% |
| Mining | 50 | 50% | 3.35% |
| Power | 49 | 47% | 0.15% |
| Energy | 49 | 49% | 1.75% |
| Insurance | 43 | 60% | 2.32% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 390 | 47.2% | 2.05% |
| QUALITY_GROWTH | 99 | 42.4% | 0.36% |

---

## Part 3: Market Mood Filter Deep-Dive

### STAY_OUT Months Validation

The mood filter signals STAY_OUT when all 3 indicators (5-day return, above SMA20, above SMA50) are negative.

| Month | Nifty Monthly Return | Filter Correct? |
|-------|---------------------|------------------|
| Apr 2018 | 5.4% | NO (Nifty rose) |
| Aug 2019 | 0.4% | NO (Nifty rose) |
| Feb 2020 | -6.9% | YES (Nifty fell) |
| Mar 2020 | -27.4% | YES (Nifty fell) |
| Apr 2020 | 22.0% | NO (Nifty rose) |
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

**Filter Accuracy (True Positive Rate):** 3/15 = 20%  
This means 20% of months the filter told us to stay out, Nifty actually declined.

### Mood Distribution (5-Year Horizon)

| Mood | Count | % of Months |
|------|-------|-------------|
| STRONG_BUY_DAY | 44 | 46% |
| BUY_DAY | 19 | 20% |
| SELECTIVE | 17 | 18% |
| STAY_OUT | 16 | 17% |

### XIRR Improvement from Filter per Horizon

| Horizon | XIRR (With Filter) | XIRR (No Filter) | Improvement | Months Skipped |
|---------|--------------------|--------------------|-------------|----------------|
| 1 Year | -8.4% | 3.5% | -11.9pp | 5 |
| 2 Years | -10.4% | -5.3% | -5.1pp | 6 |
| 3 Years | 20.1% | 19.1% | +1.0pp | 6 |
| 4 Years | 16.2% | 14.4% | +1.8pp | 9 |
| 5 Years | 14.8% | 13.9% | +0.9pp | 11 |
| 6 Years | 21.1% | 25.9% | -4.7pp | 12 |
| 7 Years | 16.1% | 21.6% | -5.5pp | 15 |
| 8 Years | 12.9% | 17.9% | -5.0pp | 16 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| AMBUJACEM | 9 | 78% | 11.15% | 5 |
| M&M | 15 | 93% | 8.87% | 7 |
| INDIGO | 13 | 100% | 8.46% | 6 |
| MPHASIS | 62 | 71% | 8.36% | 8 |
| HINDPETRO | 22 | 68% | 8.07% | 6 |
| ONGC | 100 | 71% | 7.65% | 8 |
| HDFCLIFE | 29 | 97% | 7.17% | 8 |
| CGPOWER | 57 | 72% | 6.59% | 8 |
| LODHA | 17 | 65% | 6.31% | 6 |
| PFC | 24 | 67% | 6.01% | 8 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| LUPIN | 34 | 0% | -6.52% | 8 |
| INDUSINDBK | 86 | 9% | -4.41% | 8 |
| ABB | 88 | 16% | -4.39% | 8 |
| KOTAKBANK | 18 | 33% | -4.38% | 8 |
| CHOLAFIN | 36 | 25% | -4.15% | 8 |
| IOC | 28 | 7% | -3.53% | 8 |
| UPL | 70 | 33% | -3.50% | 8 |
| APOLLOTYRE | 48 | 25% | -3.25% | 8 |
| SIEMENS | 60 | 27% | -3.20% | 8 |
| TATACONSUM | 28 | 32% | -3.11% | 8 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 57 | 45.6% | -0.25% | 28 | 35.7% | -1.46% |
| 2 Years | 159 | 36.5% | -0.53% | 54 | 31.5% | -2.28% |
| 3 Years | 308 | 47.7% | 2.21% | 82 | 41.5% | 0.13% |
| 4 Years | 389 | 47.3% | 2.07% | 94 | 42.6% | 0.47% |
| 5 Years | 390 | 47.2% | 2.03% | 96 | 41.7% | 0.32% |
| 6 Years | 391 | 47.3% | 2.06% | 96 | 41.7% | 0.32% |
| 7 Years | 390 | 47.4% | 2.09% | 97 | 41.2% | 0.24% |
| 8 Years | 390 | 47.2% | 2.05% | 99 | 42.4% | 0.36% |

**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in 8/8 horizons. Consider overweighting DEEP_VALUE picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Airlines | 13 | 100% | 8.46% | OVERWEIGHT |
| Hospitality | 50 | 74% | 3.94% | OVERWEIGHT |
| Metals | 191 | 61% | 3.85% | OVERWEIGHT |
| Mining | 295 | 49% | 3.65% | NEUTRAL |
| Internet | 82 | 52% | 3.48% | MAINTAIN |
| IT | 755 | 58% | 3.30% | OVERWEIGHT |
| Energy | 241 | 54% | 3.16% | MAINTAIN |
| Real Estate | 46 | 46% | 2.49% | NEUTRAL |
| Insurance | 207 | 60% | 2.17% | OVERWEIGHT |
| Infrastructure | 98 | 55% | 1.88% | MAINTAIN |
| Auto | 476 | 48% | 1.65% | NEUTRAL |
| Diversified | 50 | 50% | 1.31% | MAINTAIN |
| Finance | 369 | 53% | 1.26% | MAINTAIN |
| Pharma | 588 | 51% | 0.98% | MAINTAIN |
| Telecom | 15 | 33% | 0.50% | UNDERWEIGHT / EXCLUDE |
| Defence | 136 | 46% | 0.34% | NEUTRAL |
| FMCG | 555 | 41% | 0.14% | NEUTRAL |
| Renewable Energy | 57 | 26% | -0.58% | UNDERWEIGHT / EXCLUDE |
| Power | 278 | 43% | -0.62% | NEUTRAL |
| Tourism | 91 | 36% | -0.64% | UNDERWEIGHT / EXCLUDE |
| Cement | 97 | 23% | -0.84% | UNDERWEIGHT / EXCLUDE |
| Capital Goods | 205 | 35% | -0.99% | UNDERWEIGHT / EXCLUDE |
| Auto Components | 102 | 43% | -1.05% | NEUTRAL |
| Banking | 627 | 31% | -1.75% | UNDERWEIGHT / EXCLUDE |
| Consumer | 79 | 37% | -1.91% | UNDERWEIGHT / EXCLUDE |
| Retail | 83 | 34% | -2.46% | UNDERWEIGHT / EXCLUDE |
| Consumer Durables | 33 | 39% | -2.62% | UNDERWEIGHT / EXCLUDE |
| Chemicals | 88 | 30% | -3.08% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 0 (0%) | 10 (7%) | 54 (38%) | 0 (0%) |
| 2 Years | 0 (0%) | 31 (9%) | 110 (31%) | 0 (0%) |
| 3 Years | 0 (0%) | 109 (17%) | 188 (30%) | 0 (0%) |
| 4 Years | 0 (0%) | 130 (16%) | 234 (30%) | 0 (0%) |
| 5 Years | 0 (0%) | 142 (16%) | 266 (31%) | 0 (0%) |
| 6 Years | 0 (0%) | 162 (17%) | 319 (33%) | 0 (0%) |
| 7 Years | 0 (0%) | 166 (16%) | 367 (35%) | 0 (0%) |
| 8 Years | 0 (0%) | 172 (15%) | 425 (38%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 0%
- Target Hit Rate: 14%
- Time Exit Rate: 33%

- **Targets Too Ambitious:** Only 14% of trades hit target. Consider reducing ATR target multiplier from 6x to 4.5x or 5x.

### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Remove market mood filter | Costs 3.6pp on average; filter is reducing returns | -3.6pp |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 14% target hits; more achievable targets improve realized gains | +1-3pp est. |
| P3 | Exclude consistent losers: LUPIN, INDUSINDBK, ABB | These stocks lose money across 3+ horizons with <35% win rate | +1-2pp est. |
| P4 | Underweight sectors: Telecom, Renewable Energy | Win rate below 40% consistently; these sectors drag portfolio returns | +1-3pp est. |
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

*Report generated on 2026-04-17T01:38:09.743Z by StarBhai Multi-Horizon Paper Trading Engine*
