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
| 1 Year | 168 | 25.6% | -1.95% | -18.1% | 9.5% | -27.5% | 5 | -9.1% | -8.9pp |
| 2 Years | 415 | 32.0% | -1.73% | -19.2% | 5.3% | -24.5% | 6 | -11.0% | -8.2pp |
| 3 Years | 705 | 43.8% | 0.58% | 8.7% | 13.1% | -4.4% | 6 | 8.4% | +0.3pp |
| 4 Years | 902 | 41.7% | 0.15% | 2.0% | 8.5% | -6.6% | 9 | 3.9% | -1.9pp |
| 5 Years | 1110 | 43.1% | 0.34% | 4.6% | 11.0% | -6.4% | 11 | 8.0% | -3.4pp |
| 6 Years | 1367 | 47.6% | 1.54% | 31.2% | 20.9% | +10.3% | 12 | 37.8% | -6.6pp |
| 7 Years | 1577 | 44.5% | 0.96% | 12.9% | 11.7% | +1.3% | 15 | 17.4% | -4.5pp |
| 8 Years | 1819 | 44.3% | 0.83% | 10.3% | 12.0% | -1.7% | 16 | 14.6% | -4.3pp |

**Key Observations:**

- Best absolute XIRR: **6 Years** at 31.2%
- Best alpha: **6 Years** at +10.3%
- Average filter value across all horizons: -4.7pp

---

## Part 2: Individual Horizon Analysis

### 1 Year Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 168 |
| Wins / Losses | 43 / 125 |
| Win Rate | 25.6% |
| Avg Return/Trade | -1.95% |
| XIRR (Filtered) | -18.1% |
| XIRR (No Filter) | -9.1% |
| Nifty XIRR | 9.5% |
| Alpha | -27.5% |
| Months Skipped | 5 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.84% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 28 | -2.92% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 52 | 25.0% | -1.98% | 0 (0%) | 7 (13%) | 5 (10%) |
| Mid-Term | 58 | 31.0% | -1.32% | 0 (0%) | 2 (3%) | 37 (64%) |
| Fundamental | 58 | 20.7% | -2.55% | 0 (0%) | 0 (0%) | 5 (9%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| FMCG | 21 | 14% | -2.92% |
| IT | 21 | 29% | -2.20% |
| Banking | 19 | 21% | -2.66% |
| Finance | 15 | 13% | -5.02% |
| Defence | 14 | 21% | -3.49% |
| Pharma | 14 | 57% | 1.33% |
| Auto | 9 | 33% | 0.46% |
| Real Estate | 8 | 13% | -1.93% |
| Insurance | 8 | 38% | -0.94% |
| Infrastructure | 6 | 33% | 1.29% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 95 | 22.1% | -2.32% |
| QUALITY_GROWTH | 15 | 26.7% | -1.99% |

### 2 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 415 |
| Wins / Losses | 133 / 282 |
| Win Rate | 32.0% |
| Avg Return/Trade | -1.73% |
| XIRR (Filtered) | -19.2% |
| XIRR (No Filter) | -11.0% |
| Nifty XIRR | 5.3% |
| Alpha | -24.5% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.32% | -0.2% |
| May 2024 | BUY_DAY | 21 | 1.84% | 0.2% |
| Jun 2024 | BUY_DAY | 19 | 1.24% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 3.60% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.77% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 133 | 31.6% | -1.07% | 0 (0%) | 29 (22%) | 6 (5%) |
| Mid-Term | 141 | 39.0% | -1.25% | 0 (0%) | 9 (6%) | 75 (53%) |
| Fundamental | 141 | 25.5% | -2.83% | 0 (0%) | 9 (6%) | 16 (11%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 68 | 43% | 0.48% |
| FMCG | 53 | 19% | -3.37% |
| Banking | 37 | 24% | -3.83% |
| Finance | 35 | 46% | -0.04% |
| Pharma | 35 | 49% | 0.19% |
| Defence | 27 | 22% | -3.75% |
| Insurance | 24 | 21% | -5.29% |
| Auto | 22 | 36% | -0.49% |
| Real Estate | 22 | 32% | 1.46% |
| Tourism | 17 | 6% | -6.98% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 236 | 28.0% | -1.99% |
| QUALITY_GROWTH | 38 | 31.6% | -1.89% |

### 3 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 705 |
| Wins / Losses | 309 / 396 |
| Win Rate | 43.8% |
| Avg Return/Trade | 0.58% |
| XIRR (Filtered) | 8.7% |
| XIRR (No Filter) | 8.4% |
| Nifty XIRR | 13.1% |
| Alpha | -4.4% |
| Months Skipped | 6 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2023 | BUY_DAY | 21 | 2.63% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 28 | 2.03% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 27 | 2.98% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 28 | 6.76% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 25 | 5.21% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 3.22% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.18% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | -2.96% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 8.78% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.47% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.58% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 25 | -3.10% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.11% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.81% | 0.2% |
| Jun 2024 | BUY_DAY | 20 | 0.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 5.20% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.81% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 219 | 41.1% | 0.78% | 0 (0%) | 69 (32%) | 7 (3%) |
| Mid-Term | 243 | 49.8% | 0.66% | 0 (0%) | 37 (15%) | 125 (51%) |
| Fundamental | 243 | 40.3% | 0.30% | 0 (0%) | 27 (11%) | 40 (16%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 120 | 52% | 1.18% |
| FMCG | 97 | 34% | -1.08% |
| Finance | 56 | 52% | 1.80% |
| Banking | 53 | 28% | -2.16% |
| Pharma | 47 | 51% | 0.93% |
| Insurance | 46 | 43% | 0.33% |
| Defence | 44 | 43% | 3.20% |
| Auto | 39 | 44% | 0.53% |
| Real Estate | 32 | 38% | 2.27% |
| Tourism | 31 | 32% | -1.54% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 392 | 41.3% | 0.54% |
| QUALITY_GROWTH | 70 | 37.1% | 0.45% |

### 4 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 902 |
| Wins / Losses | 376 / 526 |
| Win Rate | 41.7% |
| Avg Return/Trade | 0.15% |
| XIRR (Filtered) | 2.0% |
| XIRR (No Filter) | 3.9% |
| Nifty XIRR | 8.5% |
| Alpha | -6.6% |
| Months Skipped | 9 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2022 | STRONG_BUY_DAY | 30 | -2.79% | -5.5% |
| May 2022 | SELECTIVE | 12 | -5.51% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -5.14% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 0.64% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 3.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 3.17% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -1.70% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -2.49% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -4.00% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 2.63% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.39% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 4.71% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 5.11% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 3.54% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 2.96% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.18% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | -2.96% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 8.78% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.47% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.58% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 25 | -3.10% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.11% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.81% | 0.2% |
| Jun 2024 | BUY_DAY | 20 | 0.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 5.20% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.81% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 290 | 39.0% | 0.30% | 0 (0%) | 85 (29%) | 11 (4%) |
| Mid-Term | 306 | 48.0% | 0.41% | 0 (0%) | 44 (14%) | 159 (52%) |
| Fundamental | 306 | 37.9% | -0.25% | 0 (0%) | 32 (10%) | 46 (15%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 163 | 40% | -0.59% |
| FMCG | 122 | 34% | -0.60% |
| Finance | 80 | 49% | 0.65% |
| Insurance | 63 | 46% | 0.64% |
| Pharma | 61 | 46% | 0.17% |
| Defence | 55 | 45% | 2.87% |
| Banking | 51 | 29% | -2.54% |
| Auto | 48 | 46% | 0.94% |
| Tourism | 42 | 36% | -1.15% |
| Real Estate | 40 | 33% | 1.00% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 502 | 39.4% | 0.13% |
| QUALITY_GROWTH | 94 | 33.0% | -0.57% |

### 5 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1110 |
| Wins / Losses | 478 / 632 |
| Win Rate | 43.1% |
| Avg Return/Trade | 0.34% |
| XIRR (Filtered) | 4.6% |
| XIRR (No Filter) | 8.0% |
| Nifty XIRR | 11.0% |
| Alpha | -6.4% |
| Months Skipped | 11 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2021 | STRONG_BUY_DAY | 27 | 1.17% | -1.6% |
| May 2021 | BUY_DAY | 20 | 1.87% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 24 | 3.51% | 0.7% |
| Jul 2021 | SELECTIVE | 12 | 5.80% | 0.5% |
| Aug 2021 | SELECTIVE | 12 | 4.88% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 30 | 6.85% | 2.7% |
| Oct 2021 | SELECTIVE | 12 | 4.56% | 1.7% |
| Nov 2021 | SELECTIVE | 12 | -1.62% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 30 | -2.49% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 29 | -9.26% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 30 | -2.28% | -5.5% |
| May 2022 | SELECTIVE | 12 | -5.53% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -5.33% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 0.64% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 3.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 3.17% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -1.70% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -2.49% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -4.00% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 2.63% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.39% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 4.71% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 5.11% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 3.54% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 2.96% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.18% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | -2.96% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 8.78% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.47% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.58% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 25 | -3.10% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.11% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.81% | 0.2% |
| Jun 2024 | BUY_DAY | 20 | 0.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 5.20% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.81% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 352 | 40.3% | 0.44% | 0 (0%) | 105 (30%) | 15 (4%) |
| Mid-Term | 379 | 47.5% | 0.37% | 0 (0%) | 56 (15%) | 191 (50%) |
| Fundamental | 379 | 41.2% | 0.21% | 0 (0%) | 46 (12%) | 63 (17%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 214 | 44% | 0.41% |
| FMCG | 150 | 36% | -0.58% |
| Finance | 90 | 50% | 1.09% |
| Banking | 70 | 30% | -2.53% |
| Pharma | 69 | 43% | -0.11% |
| Defence | 65 | 49% | 3.05% |
| Insurance | 65 | 48% | 0.66% |
| Auto | 59 | 51% | 1.33% |
| Tourism | 49 | 39% | -0.19% |
| Real Estate | 45 | 36% | 1.34% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 602 | 41.5% | 0.40% |
| QUALITY_GROWTH | 129 | 37.2% | -0.03% |

### 6 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1367 |
| Wins / Losses | 651 / 716 |
| Win Rate | 47.6% |
| Avg Return/Trade | 1.54% |
| XIRR (Filtered) | 31.2% |
| XIRR (No Filter) | 37.8% |
| Nifty XIRR | 20.9% |
| Alpha | +10.3% |
| Months Skipped | 12 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2020 | STAY_OUT | 0 | - | 22.0% |
| May 2020 | STRONG_BUY_DAY | 26 | -5.62% | 1.2% |
| Jun 2020 | STRONG_BUY_DAY | 29 | 10.29% | 4.5% |
| Jul 2020 | STRONG_BUY_DAY | 24 | 10.88% | 6.2% |
| Aug 2020 | BUY_DAY | 18 | 9.54% | 3.6% |
| Sep 2020 | BUY_DAY | 15 | 4.36% | -0.5% |
| Oct 2020 | STRONG_BUY_DAY | 30 | 0.95% | 3.5% |
| Nov 2020 | SELECTIVE | 11 | 11.49% | 11.0% |
| Dec 2020 | STRONG_BUY_DAY | 30 | 11.48% | 6.9% |
| Jan 2021 | STRONG_BUY_DAY | 25 | 5.83% | 4.5% |
| Feb 2021 | STRONG_BUY_DAY | 23 | 7.39% | 1.9% |
| Mar 2021 | BUY_DAY | 21 | -1.76% | -0.3% |
| Apr 2021 | STRONG_BUY_DAY | 27 | 1.69% | -1.6% |
| May 2021 | BUY_DAY | 21 | 2.81% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 28 | 5.67% | 0.7% |
| Jul 2021 | SELECTIVE | 12 | 6.36% | 0.5% |
| Aug 2021 | SELECTIVE | 12 | 9.61% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 30 | 9.66% | 2.7% |
| Oct 2021 | SELECTIVE | 12 | 5.19% | 1.7% |
| Nov 2021 | SELECTIVE | 12 | -1.62% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 30 | -2.49% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 29 | -9.26% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 30 | -2.28% | -5.5% |
| May 2022 | SELECTIVE | 12 | -5.53% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -5.33% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 0.64% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 3.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 3.17% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -1.70% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -2.49% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -4.00% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 2.63% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.39% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 4.71% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 5.11% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 3.54% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 2.96% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.18% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | -2.96% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 8.78% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.47% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.58% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 25 | -3.10% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.11% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.81% | 0.2% |
| Jun 2024 | BUY_DAY | 20 | 0.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 5.20% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.81% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 419 | 45.1% | 1.63% | 0 (0%) | 139 (33%) | 25 (6%) |
| Mid-Term | 474 | 50.8% | 1.01% | 0 (0%) | 75 (16%) | 246 (52%) |
| Fundamental | 474 | 46.6% | 1.99% | 0 (0%) | 68 (14%) | 88 (19%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 261 | 52% | 2.47% |
| FMCG | 182 | 40% | 0.02% |
| Finance | 110 | 55% | 3.35% |
| Banking | 94 | 36% | -1.03% |
| Pharma | 87 | 46% | 0.61% |
| Auto | 87 | 55% | 2.72% |
| Defence | 82 | 52% | 4.79% |
| Insurance | 69 | 49% | 0.95% |
| Tourism | 61 | 43% | 0.62% |
| Real Estate | 48 | 38% | 1.93% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 738 | 46.9% | 1.97% |
| QUALITY_GROWTH | 155 | 41.3% | 1.10% |

### 7 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1577 |
| Wins / Losses | 701 / 876 |
| Win Rate | 44.5% |
| Avg Return/Trade | 0.96% |
| XIRR (Filtered) | 12.9% |
| XIRR (No Filter) | 17.4% |
| Nifty XIRR | 11.7% |
| Alpha | +1.3% |
| Months Skipped | 15 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2019 | STRONG_BUY_DAY | 28 | -2.91% | 1.0% |
| May 2019 | BUY_DAY | 16 | -2.13% | 1.8% |
| Jun 2019 | STRONG_BUY_DAY | 27 | -3.59% | -0.5% |
| Jul 2019 | STRONG_BUY_DAY | 25 | -5.43% | -7.5% |
| Aug 2019 | STAY_OUT | 0 | - | 0.4% |
| Sep 2019 | BUY_DAY | 20 | -2.45% | 3.1% |
| Oct 2019 | BUY_DAY | 21 | 2.61% | 4.7% |
| Nov 2019 | STRONG_BUY_DAY | 29 | -3.55% | 1.4% |
| Dec 2019 | STRONG_BUY_DAY | 23 | -3.42% | 1.4% |
| Jan 2020 | BUY_DAY | 17 | 2.87% | -2.2% |
| Feb 2020 | STAY_OUT | 0 | - | -6.9% |
| Mar 2020 | STAY_OUT | 0 | - | -27.4% |
| Apr 2020 | STAY_OUT | 0 | - | 22.0% |
| May 2020 | STRONG_BUY_DAY | 26 | -5.62% | 1.2% |
| Jun 2020 | STRONG_BUY_DAY | 30 | 13.59% | 4.5% |
| Jul 2020 | STRONG_BUY_DAY | 27 | 11.38% | 6.2% |
| Aug 2020 | BUY_DAY | 18 | 10.59% | 3.6% |
| Sep 2020 | BUY_DAY | 15 | 0.34% | -0.5% |
| Oct 2020 | STRONG_BUY_DAY | 30 | 0.59% | 3.5% |
| Nov 2020 | SELECTIVE | 11 | 11.49% | 11.0% |
| Dec 2020 | STRONG_BUY_DAY | 30 | 11.48% | 6.9% |
| Jan 2021 | STRONG_BUY_DAY | 25 | 5.08% | 4.5% |
| Feb 2021 | STRONG_BUY_DAY | 23 | 7.39% | 1.9% |
| Mar 2021 | BUY_DAY | 21 | -1.76% | -0.3% |
| Apr 2021 | STRONG_BUY_DAY | 27 | 1.69% | -1.6% |
| May 2021 | BUY_DAY | 21 | 2.81% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 28 | 5.67% | 0.7% |
| Jul 2021 | SELECTIVE | 12 | 6.36% | 0.5% |
| Aug 2021 | SELECTIVE | 12 | 9.61% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 30 | 9.66% | 2.7% |
| Oct 2021 | SELECTIVE | 12 | 5.19% | 1.7% |
| Nov 2021 | SELECTIVE | 12 | -1.62% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 30 | -2.49% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 29 | -9.26% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 30 | -2.28% | -5.5% |
| May 2022 | SELECTIVE | 12 | -5.53% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -5.33% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 0.64% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 3.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 3.17% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -1.70% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -2.49% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -4.00% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 2.63% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.39% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 4.71% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 5.11% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 3.54% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 2.96% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.18% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | -2.96% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 8.78% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.47% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.58% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 25 | -3.10% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.11% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.81% | 0.2% |
| Jun 2024 | BUY_DAY | 20 | 0.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 5.20% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.81% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 473 | 42.1% | 1.09% | 0 (0%) | 146 (31%) | 28 (6%) |
| Mid-Term | 552 | 48.9% | 0.66% | 0 (0%) | 78 (14%) | 294 (53%) |
| Fundamental | 552 | 42.0% | 1.15% | 0 (0%) | 71 (13%) | 93 (17%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 296 | 48% | 1.60% |
| FMCG | 209 | 37% | -0.32% |
| Finance | 128 | 50% | 2.68% |
| Banking | 107 | 34% | -1.61% |
| Pharma | 102 | 40% | -0.20% |
| Auto | 101 | 50% | 1.95% |
| Defence | 98 | 50% | 4.27% |
| Insurance | 73 | 51% | 1.01% |
| Tourism | 66 | 42% | 0.74% |
| Cement | 59 | 44% | 1.42% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 846 | 43.1% | 1.30% |
| QUALITY_GROWTH | 179 | 36.9% | 0.27% |

### 8 Years Horizon

**Summary:**

| Metric | Value |
|--------|-------|
| Total Trades | 1819 |
| Wins / Losses | 806 / 1013 |
| Win Rate | 44.3% |
| Avg Return/Trade | 0.83% |
| XIRR (Filtered) | 10.3% |
| XIRR (No Filter) | 14.6% |
| Nifty XIRR | 12.0% |
| Alpha | -1.7% |
| Months Skipped | 16 |

#### Monthly P&L

| Month | Mood | Entries | Avg Return | Nifty Monthly |
|-------|------|---------|------------|---------------|
| Apr 2018 | STAY_OUT | 0 | - | 5.4% |
| May 2018 | STRONG_BUY_DAY | 30 | -2.71% | 0.2% |
| Jun 2018 | STRONG_BUY_DAY | 27 | 2.63% | 0.2% |
| Jul 2018 | SELECTIVE | 11 | 5.46% | 5.9% |
| Aug 2018 | STRONG_BUY_DAY | 25 | 2.77% | 2.9% |
| Sep 2018 | STRONG_BUY_DAY | 30 | -3.25% | -5.8% |
| Oct 2018 | SELECTIVE | 11 | -5.69% | -4.1% |
| Nov 2018 | BUY_DAY | 16 | 0.75% | 3.1% |
| Dec 2018 | STRONG_BUY_DAY | 26 | -1.38% | -1.9% |
| Jan 2019 | SELECTIVE | 11 | -0.65% | 2.1% |
| Feb 2019 | STRONG_BUY_DAY | 27 | -3.03% | -0.3% |
| Mar 2019 | STRONG_BUY_DAY | 25 | 1.69% | 6.8% |
| Apr 2019 | STRONG_BUY_DAY | 28 | 1.40% | 1.0% |
| May 2019 | BUY_DAY | 17 | -2.14% | 1.8% |
| Jun 2019 | STRONG_BUY_DAY | 27 | -2.86% | -0.5% |
| Jul 2019 | STRONG_BUY_DAY | 26 | -5.17% | -7.5% |
| Aug 2019 | STAY_OUT | 0 | - | 0.4% |
| Sep 2019 | BUY_DAY | 20 | -2.45% | 3.1% |
| Oct 2019 | BUY_DAY | 21 | 3.03% | 4.7% |
| Nov 2019 | STRONG_BUY_DAY | 29 | -3.55% | 1.4% |
| Dec 2019 | STRONG_BUY_DAY | 24 | -3.41% | 1.4% |
| Jan 2020 | BUY_DAY | 17 | 2.27% | -2.2% |
| Feb 2020 | STAY_OUT | 0 | - | -6.9% |
| Mar 2020 | STAY_OUT | 0 | - | -27.4% |
| Apr 2020 | STAY_OUT | 0 | - | 22.0% |
| May 2020 | STRONG_BUY_DAY | 26 | -5.62% | 1.2% |
| Jun 2020 | STRONG_BUY_DAY | 30 | 13.59% | 4.5% |
| Jul 2020 | STRONG_BUY_DAY | 27 | 11.38% | 6.2% |
| Aug 2020 | BUY_DAY | 18 | 10.59% | 3.6% |
| Sep 2020 | BUY_DAY | 15 | 0.34% | -0.5% |
| Oct 2020 | STRONG_BUY_DAY | 30 | 0.59% | 3.5% |
| Nov 2020 | SELECTIVE | 11 | 11.49% | 11.0% |
| Dec 2020 | STRONG_BUY_DAY | 30 | 11.48% | 6.9% |
| Jan 2021 | STRONG_BUY_DAY | 25 | 5.08% | 4.5% |
| Feb 2021 | STRONG_BUY_DAY | 23 | 7.39% | 1.9% |
| Mar 2021 | BUY_DAY | 21 | -1.76% | -0.3% |
| Apr 2021 | STRONG_BUY_DAY | 27 | 1.69% | -1.6% |
| May 2021 | BUY_DAY | 21 | 2.81% | 6.4% |
| Jun 2021 | STRONG_BUY_DAY | 28 | 5.67% | 0.7% |
| Jul 2021 | SELECTIVE | 12 | 6.36% | 0.5% |
| Aug 2021 | SELECTIVE | 12 | 9.61% | 8.3% |
| Sep 2021 | STRONG_BUY_DAY | 30 | 9.66% | 2.7% |
| Oct 2021 | SELECTIVE | 12 | 5.19% | 1.7% |
| Nov 2021 | SELECTIVE | 12 | -1.62% | -3.7% |
| Dec 2021 | STAY_OUT | 0 | - | 2.7% |
| Jan 2022 | STRONG_BUY_DAY | 30 | -2.49% | 0.9% |
| Feb 2022 | STRONG_BUY_DAY | 29 | -9.26% | -6.6% |
| Mar 2022 | STAY_OUT | 0 | - | 8.7% |
| Apr 2022 | STRONG_BUY_DAY | 30 | -2.28% | -5.5% |
| May 2022 | SELECTIVE | 12 | -5.53% | -2.6% |
| Jun 2022 | BUY_DAY | 21 | -5.33% | -5.3% |
| Jul 2022 | SELECTIVE | 12 | 0.64% | 10.1% |
| Aug 2022 | STRONG_BUY_DAY | 30 | 3.08% | 1.2% |
| Sep 2022 | SELECTIVE | 12 | 3.17% | -2.6% |
| Oct 2022 | STAY_OUT | 0 | - | 5.6% |
| Nov 2022 | STRONG_BUY_DAY | 30 | -1.70% | 4.2% |
| Dec 2022 | STRONG_BUY_DAY | 30 | -2.49% | -3.1% |
| Jan 2023 | SELECTIVE | 12 | -4.00% | -3.4% |
| Feb 2023 | STAY_OUT | 0 | - | -1.6% |
| Mar 2023 | STAY_OUT | 0 | - | 0.4% |
| Apr 2023 | BUY_DAY | 21 | 2.63% | 4.0% |
| May 2023 | STRONG_BUY_DAY | 30 | 2.39% | 2.5% |
| Jun 2023 | STRONG_BUY_DAY | 30 | 4.71% | 3.5% |
| Jul 2023 | STRONG_BUY_DAY | 30 | 5.11% | 2.8% |
| Aug 2023 | STRONG_BUY_DAY | 26 | 3.54% | -1.5% |
| Sep 2023 | STRONG_BUY_DAY | 30 | 2.96% | 1.0% |
| Oct 2023 | SELECTIVE | 12 | -4.18% | -2.1% |
| Nov 2023 | SELECTIVE | 12 | -2.96% | 5.4% |
| Dec 2023 | STRONG_BUY_DAY | 30 | 8.78% | 6.2% |
| Jan 2024 | BUY_DAY | 21 | 4.47% | 1.6% |
| Feb 2024 | STRONG_BUY_DAY | 30 | 11.58% | 2.2% |
| Mar 2024 | STRONG_BUY_DAY | 25 | -3.10% | 0.8% |
| Apr 2024 | STRONG_BUY_DAY | 28 | 2.11% | -0.2% |
| May 2024 | BUY_DAY | 21 | 2.81% | 0.2% |
| Jun 2024 | BUY_DAY | 20 | 0.10% | 7.2% |
| Jul 2024 | STRONG_BUY_DAY | 30 | 5.20% | 3.6% |
| Aug 2024 | STRONG_BUY_DAY | 30 | -3.81% | 0.9% |
| Sep 2024 | STRONG_BUY_DAY | 30 | 2.45% | 2.2% |
| Oct 2024 | BUY_DAY | 21 | -4.23% | -5.8% |
| Nov 2024 | SELECTIVE | 12 | -2.35% | -0.7% |
| Dec 2024 | BUY_DAY | 21 | 0.08% | -0.5% |
| Jan 2025 | SELECTIVE | 12 | -4.93% | -2.2% |
| Feb 2025 | BUY_DAY | 21 | -7.93% | -5.8% |
| Mar 2025 | STAY_OUT | 0 | - | 3.5% |
| Apr 2025 | STAY_OUT | 0 | - | 6.3% |
| May 2025 | STRONG_BUY_DAY | 30 | 3.53% | 1.5% |
| Jun 2025 | BUY_DAY | 21 | -0.15% | 3.3% |
| Jul 2025 | STRONG_BUY_DAY | 30 | -3.52% | -3.8% |
| Aug 2025 | STAY_OUT | 0 | - | 0.2% |
| Sep 2025 | STAY_OUT | 0 | - | 0.9% |
| Oct 2025 | STAY_OUT | 0 | - | 3.7% |
| Nov 2025 | BUY_DAY | 21 | -5.92% | 1.6% |
| Dec 2025 | STRONG_BUY_DAY | 30 | -2.69% | 0.6% |
| Jan 2026 | STRONG_BUY_DAY | 26 | -3.02% | -4.7% |
| Feb 2026 | SELECTIVE | 12 | -3.87% | -0.9% |
| Mar 2026 | STAY_OUT | 0 | - | N/A |

#### Category Breakdown

| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |
|----------|--------|----------|------------|----------|--------------|------------|
| Buy Now | 537 | 41.0% | 0.86% | 0 (0%) | 162 (30%) | 31 (6%) |
| Mid-Term | 641 | 48.7% | 0.50% | 0 (0%) | 84 (13%) | 349 (54%) |
| Fundamental | 641 | 42.7% | 1.13% | 0 (0%) | 79 (12%) | 102 (16%) |

#### Sector Analysis (Top 10)

| Sector | Trades | Win Rate | Avg Return |
|--------|--------|----------|------------|
| IT | 346 | 48% | 1.55% |
| FMCG | 251 | 39% | -0.16% |
| Finance | 150 | 52% | 2.72% |
| Pharma | 135 | 40% | -0.38% |
| Banking | 130 | 36% | -1.49% |
| Auto | 115 | 47% | 1.59% |
| Defence | 114 | 46% | 3.24% |
| Insurance | 80 | 50% | 0.94% |
| Cement | 70 | 44% | 1.35% |
| Tourism | 66 | 42% | 0.74% |

#### Verdict Comparison

| Verdict | Trades | Win Rate | Avg Return |
|---------|--------|----------|------------|
| DEEP_VALUE | 968 | 43.1% | 1.20% |
| QUALITY_GROWTH | 210 | 36.7% | 0.12% |

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
| 1 Year | -18.1% | -9.1% | -8.9pp | 5 |
| 2 Years | -19.2% | -11.0% | -8.2pp | 6 |
| 3 Years | 8.7% | 8.4% | +0.3pp | 6 |
| 4 Years | 2.0% | 3.9% | -1.9pp | 9 |
| 5 Years | 4.6% | 8.0% | -3.4pp | 11 |
| 6 Years | 31.2% | 37.8% | -6.6pp | 12 |
| 7 Years | 12.9% | 17.4% | -4.5pp | 15 |
| 8 Years | 10.3% | 14.6% | -4.3pp | 16 |

---

## Part 4: Consolidated Improvement Recommendations

### 1. Consistent Winners Across All Timeframes

Stocks that appear across 3+ horizons with >= 60% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| M&M | 15 | 93% | 8.87% | 7 |
| ADANIPOWER | 33 | 73% | 8.54% | 6 |
| INDIGO | 13 | 100% | 8.46% | 6 |
| HINDPETRO | 21 | 67% | 8.37% | 6 |
| ONGC | 24 | 83% | 8.06% | 8 |
| HDFCLIFE | 29 | 97% | 7.17% | 8 |
| CGPOWER | 35 | 69% | 6.73% | 8 |
| PFC | 24 | 67% | 6.01% | 8 |
| TATAPOWER | 30 | 73% | 5.02% | 8 |
| JINDALSTEL | 37 | 84% | 4.71% | 8 |

### 2. Consistent Losers to Exclude

Stocks that appear across 3+ horizons with < 35% win rate:

| Symbol | Trades | Win Rate | Avg Return | Horizons |
|--------|--------|----------|------------|----------|
| KOTAKBANK | 19 | 26% | -4.75% | 8 |
| INDUSINDBK | 43 | 19% | -4.21% | 8 |
| CHOLAFIN | 36 | 25% | -4.15% | 8 |
| PNB | 185 | 20% | -3.97% | 8 |
| IOC | 59 | 14% | -3.67% | 8 |
| APOLLOTYRE | 48 | 25% | -3.25% | 8 |
| TATACONSUM | 28 | 32% | -3.11% | 8 |
| NESTLEIND | 75 | 21% | -3.03% | 8 |
| ULTRACEMCO | 25 | 12% | -2.68% | 8 |
| POWERGRID | 37 | 32% | -2.58% | 7 |

### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution

| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |
|---------|-----------|-------------|---------------|-----------|-------------|---------------|
| 1 Year | 95 | 22.1% | -2.32% | 15 | 26.7% | -1.99% |
| 2 Years | 236 | 28.0% | -1.99% | 38 | 31.6% | -1.89% |
| 3 Years | 392 | 41.3% | 0.54% | 70 | 37.1% | 0.45% |
| 4 Years | 502 | 39.4% | 0.13% | 94 | 33.0% | -0.57% |
| 5 Years | 602 | 41.5% | 0.40% | 129 | 37.2% | -0.03% |
| 6 Years | 738 | 46.9% | 1.97% | 155 | 41.3% | 1.10% |
| 7 Years | 846 | 43.1% | 1.30% | 179 | 36.9% | 0.27% |
| 8 Years | 968 | 43.1% | 1.20% | 210 | 36.7% | 0.12% |

**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in 6/8 horizons. Consider overweighting DEEP_VALUE picks.

### 4. Sector Allocation Recommendations

| Sector | Total Trades | Win Rate | Avg Return | Recommendation |
|--------|-------------|----------|------------|----------------|
| Airlines | 13 | 100% | 8.46% | OVERWEIGHT |
| Defence | 499 | 46% | 3.06% | NEUTRAL |
| Hospitality | 99 | 66% | 2.84% | OVERWEIGHT |
| Metals | 115 | 57% | 2.05% | OVERWEIGHT |
| Finance | 664 | 50% | 1.95% | MAINTAIN |
| Auto | 480 | 49% | 1.57% | NEUTRAL |
| Power | 183 | 46% | 1.48% | NEUTRAL |
| Capital Goods | 110 | 49% | 1.37% | NEUTRAL |
| Diversified | 51 | 51% | 1.36% | MAINTAIN |
| Mining | 79 | 56% | 1.36% | MAINTAIN |
| Real Estate | 298 | 35% | 1.33% | UNDERWEIGHT / EXCLUDE |
| IT | 1489 | 47% | 1.19% | NEUTRAL |
| Cement | 272 | 41% | 0.80% | NEUTRAL |
| Telecom | 15 | 33% | 0.50% | UNDERWEIGHT / EXCLUDE |
| Energy | 197 | 42% | 0.48% | NEUTRAL |
| Insurance | 428 | 46% | 0.42% | NEUTRAL |
| Infrastructure | 129 | 44% | 0.39% | NEUTRAL |
| Pharma | 550 | 44% | 0.10% | NEUTRAL |
| Tourism | 338 | 38% | -0.33% | UNDERWEIGHT / EXCLUDE |
| FMCG | 1085 | 36% | -0.56% | UNDERWEIGHT / EXCLUDE |
| Renewable Energy | 57 | 26% | -0.58% | UNDERWEIGHT / EXCLUDE |
| Consumer | 64 | 52% | -1.00% | NEUTRAL |
| Internet | 13 | 31% | -1.38% | UNDERWEIGHT / EXCLUDE |
| Banking | 561 | 32% | -1.92% | UNDERWEIGHT / EXCLUDE |
| Chemicals | 68 | 37% | -2.15% | UNDERWEIGHT / EXCLUDE |
| Consumer Durables | 57 | 35% | -2.22% | UNDERWEIGHT / EXCLUDE |
| Auto Components | 91 | 31% | -2.51% | UNDERWEIGHT / EXCLUDE |
| Retail | 51 | 39% | -3.23% | UNDERWEIGHT / EXCLUDE |

### 5. Parameter Tuning Observations

#### Exit Reason Distribution Across Horizons

| Horizon | SL Hit | Target Hit | Time Exit | No Data |
|---------|--------|------------|-----------|----------|
| 1 Year | 0 (0%) | 9 (5%) | 47 (28%) | 0 (0%) |
| 2 Years | 0 (0%) | 47 (11%) | 97 (23%) | 0 (0%) |
| 3 Years | 0 (0%) | 133 (19%) | 172 (24%) | 0 (0%) |
| 4 Years | 0 (0%) | 161 (18%) | 216 (24%) | 0 (0%) |
| 5 Years | 0 (0%) | 207 (19%) | 269 (24%) | 0 (0%) |
| 6 Years | 0 (0%) | 282 (21%) | 359 (26%) | 0 (0%) |
| 7 Years | 0 (0%) | 295 (19%) | 415 (26%) | 0 (0%) |
| 8 Years | 0 (0%) | 325 (18%) | 482 (26%) | 0 (0%) |

**Cross-Horizon Averages:**
- SL Hit Rate: 0%
- Target Hit Rate: 16%
- Time Exit Rate: 25%

- **Targets Too Ambitious:** Only 16% of trades hit target. Consider reducing ATR target multiplier from 6x to 4.5x or 5x.

### 6. Concrete Priority List with Estimated Impact

| Priority | Action | Rationale | Estimated XIRR Impact |
|----------|--------|-----------|----------------------|
| P0 | Remove market mood filter | Costs 4.7pp on average; filter is reducing returns | -4.7pp |
| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only 16% target hits; more achievable targets improve realized gains | +1-3pp est. |
| P3 | Exclude consistent losers: KOTAKBANK, INDUSINDBK, CHOLAFIN | These stocks lose money across 3+ horizons with <35% win rate | +1-2pp est. |
| P4 | Underweight sectors: Real Estate, Telecom | Win rate below 40% consistently; these sectors drag portfolio returns | +1-3pp est. |
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

*Report generated on 2026-04-16T08:39:10.067Z by StarBhai Multi-Horizon Paper Trading Engine*
