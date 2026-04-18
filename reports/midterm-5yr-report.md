# Mid-Term 5-Year SIP Paper Trading Report

**Generated:** 2026-04-16  
**Data Period:** Oct 2019 - Apr 2026 (6.5 years OHLCV, 18 months warmup)  
**Scan Period:** Apr 2021 - Mar 2026 (60 monthly scans)  
**Strategy:** Mid-Term picks only (score >= 58, 4-week hold, ATR x4 SL, ATR x5 target)  
**SIP Amount:** Rs 1,00,000 / month (equal weight across all picks)  
**Universe:** Nifty 100 stocks  
**Engine:** StarBhai production scoring engine  

---

## 1. Executive Summary

| Metric | With Mood Filter | Without Filter | Nifty SIP |
|--------|-----------------|----------------|------------|
| Total Invested | Rs 60,00,000 | Rs 60,00,000 | Rs 60,00,000 |
| Total Returned | Rs 60,27,892 | Rs 60,40,690 | Rs 73,08,292 |
| Absolute P&L | Rs 27,892 | Rs 40,690 | Rs 13,08,292 |
| Total Return % | +0.46% | +0.68% | +21.80% |
| XIRR | +10.14% | +12.96% | +7.72% |
| Alpha over Nifty (XIRR) | +2.42% | +5.25% | - |
| Total Trades | 379 | 599 | - |
| Win Rate | 50.9% | 49.7% | - |
| Avg Return/Trade | +0.72% | +0.67% | - |

**Mood Filter Value:** -2.82% XIRR impact  
**Months Skipped (STAY_OUT):** 11/60  

---

## 2. Year-by-Year Portfolio Growth

### With Mood Filter

| Year | Months | Invested (Yr) | Returned (Yr) | Yr P&L | Yr Return | Invested (Cumul) | Portfolio Value | Cumul P&L | Cumul Return | Nifty SIP Value |
|------|--------|---------------|---------------|--------|-----------|------------------|-----------------|-----------|--------------|------------------|
| Year 1 | Apr 2021 - Mar 2022 | Rs 12.00L | Rs 12.00L | Rs 0.00L | +0.02% | Rs 12.00L | Rs 12.00L | Rs 0.00L | +0.02% | Rs 12.91L |
| Year 2 | Apr 2022 - Mar 2023 | Rs 12.00L | Rs 11.93L | Rs -0.07L | -0.61% | Rs 24.00L | Rs 23.93L | Rs -0.07L | -0.29% | Rs 24.68L |
| Year 3 | Apr 2023 - Mar 2024 | Rs 12.00L | Rs 12.35L | Rs 0.35L | +2.88% | Rs 36.00L | Rs 36.27L | Rs 0.27L | +0.76% | Rs 45.62L |
| Year 4 | Apr 2024 - Mar 2025 | Rs 12.00L | Rs 11.95L | Rs -0.05L | -0.44% | Rs 48.00L | Rs 48.22L | Rs 0.22L | +0.46% | Rs 58.73L |
| Year 5 | Apr 2025 - Mar 2026 | Rs 12.00L | Rs 12.06L | Rs 0.06L | +0.47% | Rs 60.00L | Rs 60.28L | Rs 0.28L | +0.46% | Rs 68.40L |

### Without Mood Filter

| Year | Months | Invested (Yr) | Returned (Yr) | Yr P&L | Yr Return | Invested (Cumul) | Portfolio Value | Cumul P&L | Cumul Return | Nifty SIP Value |
|------|--------|---------------|---------------|--------|-----------|------------------|-----------------|-----------|--------------|------------------|
| Year 1 | Apr 2021 - Mar 2022 | Rs 12.00L | Rs 12.12L | Rs 0.12L | +0.96% | Rs 12.00L | Rs 12.12L | Rs 0.12L | +0.96% | Rs 12.91L |
| Year 2 | Apr 2022 - Mar 2023 | Rs 12.00L | Rs 11.88L | Rs -0.12L | -1.03% | Rs 24.00L | Rs 23.99L | Rs -0.01L | -0.03% | Rs 24.68L |
| Year 3 | Apr 2023 - Mar 2024 | Rs 12.00L | Rs 12.39L | Rs 0.39L | +3.24% | Rs 36.00L | Rs 36.38L | Rs 0.38L | +1.06% | Rs 45.62L |
| Year 4 | Apr 2024 - Mar 2025 | Rs 12.00L | Rs 12.04L | Rs 0.04L | +0.30% | Rs 48.00L | Rs 48.42L | Rs 0.42L | +0.87% | Rs 58.73L |
| Year 5 | Apr 2025 - Mar 2026 | Rs 12.00L | Rs 11.99L | Rs -0.01L | -0.09% | Rs 60.00L | Rs 60.41L | Rs 0.41L | +0.68% | Rs 68.40L |

### Rs 1L SIP Journey (With Filter)

```
After Year 1: Invested Rs 12.00L --> Portfolio Rs 12.00L (+0.02%)
After Year 2: Invested Rs 24.00L --> Portfolio Rs 23.93L (-0.29%)
After Year 3: Invested Rs 36.00L --> Portfolio Rs 36.27L (+0.76%)
After Year 4: Invested Rs 48.00L --> Portfolio Rs 48.22L (+0.46%)
After Year 5: Invested Rs 60.00L --> Portfolio Rs 60.28L (+0.46%)
```

### Rs 1L SIP Journey (Without Filter)

```
After Year 1: Invested Rs 12.00L --> Portfolio Rs 12.12L (+0.96%)
After Year 2: Invested Rs 24.00L --> Portfolio Rs 23.99L (-0.03%)
After Year 3: Invested Rs 36.00L --> Portfolio Rs 36.38L (+1.06%)
After Year 4: Invested Rs 48.00L --> Portfolio Rs 48.42L (+0.87%)
After Year 5: Invested Rs 60.00L --> Portfolio Rs 60.41L (+0.68%)
```

### Nifty 50 SIP Journey (Benchmark)

```
After Year 1: Invested Rs 12.00L --> Value Rs 12.91L (+7.60%)
After Year 2: Invested Rs 24.00L --> Value Rs 24.68L (+2.82%)
After Year 3: Invested Rs 36.00L --> Value Rs 45.62L (+26.72%)
After Year 4: Invested Rs 48.00L --> Value Rs 58.73L (+22.35%)
After Year 5: Invested Rs 60.00L --> Value Rs 68.40L (+14.00%)
```

---

## 3. Monthly Detail (60 Months)

### With Mood Filter

| # | Month | Mood | Picks | Avg Return | Month P&L (Rs) | Cumulative P&L (Rs) |
|---|-------|------|-------|------------|----------------|--------------------|
| 1 | Apr 2021 | STRONG_BUY | 10 | +5.96% | Rs 5,964 | Rs 5,964 |
| 2 | May 2021 | BUY | 7 | +7.00% | Rs 7,002 | Rs 12,966 |
| 3 | Jun 2021 | STRONG_BUY | 10 | +1.23% | Rs 1,228 | Rs 14,194 |
| 4 | Jul 2021 | SELECTIVE | 4 | -1.32% | Rs -1,317 | Rs 12,877 |
| 5 | Aug 2021 | SELECTIVE | 4 | +2.98% | Rs 2,975 | Rs 15,852 |
| 6 | Sep 2021 | STRONG_BUY | 10 | -0.69% | Rs -688 | Rs 15,164 |
| 7 | Oct 2021 | SELECTIVE | 4 | -3.26% | Rs -3,263 | Rs 11,901 |
| 8 | Nov 2021 | SELECTIVE | 4 | +2.13% | Rs 2,134 | Rs 14,035 |
| 9 | Dec 2021 | STAY_OUT | - | skipped | Rs 0 | Rs 14,035 |
| 10 | Jan 2022 | STRONG_BUY | 10 | -3.79% | Rs -3,793 | Rs 10,241 |
| 11 | Feb 2022 | STRONG_BUY | 10 | -10.02% | Rs -10,020 | Rs 221 |
| 12 | Mar 2022 | STAY_OUT | - | skipped | Rs 0 | Rs 221 |
| 13 | Apr 2022 | STRONG_BUY | 10 | +3.04% | Rs 3,036 | Rs 3,257 |
| 14 | May 2022 | SELECTIVE | 4 | -2.35% | Rs -2,354 | Rs 903 |
| 15 | Jun 2022 | BUY | 7 | -6.45% | Rs -6,449 | Rs -5,546 |
| 16 | Jul 2022 | SELECTIVE | 4 | +11.26% | Rs 11,258 | Rs 5,712 |
| 17 | Aug 2022 | STRONG_BUY | 10 | -1.23% | Rs -1,234 | Rs 4,478 |
| 18 | Sep 2022 | SELECTIVE | 4 | -1.98% | Rs -1,978 | Rs 2,499 |
| 19 | Oct 2022 | STAY_OUT | - | skipped | Rs 0 | Rs 2,499 |
| 20 | Nov 2022 | STRONG_BUY | 10 | -1.79% | Rs -1,790 | Rs 709 |
| 21 | Dec 2022 | STRONG_BUY | 10 | -4.10% | Rs -4,100 | Rs -3,391 |
| 22 | Jan 2023 | SELECTIVE | 4 | -3.69% | Rs -3,686 | Rs -7,077 |
| 23 | Feb 2023 | STAY_OUT | - | skipped | Rs 0 | Rs -7,077 |
| 24 | Mar 2023 | STAY_OUT | - | skipped | Rs 0 | Rs -7,077 |
| 25 | Apr 2023 | BUY | 7 | +1.78% | Rs 1,784 | Rs -5,293 |
| 26 | May 2023 | STRONG_BUY | 10 | +3.69% | Rs 3,689 | Rs -1,604 |
| 27 | Jun 2023 | STRONG_BUY | 10 | +2.67% | Rs 2,670 | Rs 1,065 |
| 28 | Jul 2023 | STRONG_BUY | 10 | +5.90% | Rs 5,897 | Rs 6,962 |
| 29 | Aug 2023 | STRONG_BUY | 10 | +1.71% | Rs 1,711 | Rs 8,672 |
| 30 | Sep 2023 | STRONG_BUY | 10 | +2.93% | Rs 2,932 | Rs 11,605 |
| 31 | Oct 2023 | SELECTIVE | 4 | -5.43% | Rs -5,435 | Rs 6,170 |
| 32 | Nov 2023 | SELECTIVE | 4 | +6.11% | Rs 6,108 | Rs 12,278 |
| 33 | Dec 2023 | STRONG_BUY | 10 | +7.65% | Rs 7,647 | Rs 19,925 |
| 34 | Jan 2024 | BUY | 7 | +3.61% | Rs 3,611 | Rs 23,536 |
| 35 | Feb 2024 | STRONG_BUY | 10 | +6.85% | Rs 6,850 | Rs 30,386 |
| 36 | Mar 2024 | STRONG_BUY | 10 | -2.95% | Rs -2,952 | Rs 27,434 |
| 37 | Apr 2024 | STRONG_BUY | 10 | +5.61% | Rs 5,609 | Rs 33,043 |
| 38 | May 2024 | BUY | 7 | +0.46% | Rs 463 | Rs 33,507 |
| 39 | Jun 2024 | BUY | 7 | -2.20% | Rs -2,203 | Rs 31,303 |
| 40 | Jul 2024 | STRONG_BUY | 10 | +7.89% | Rs 7,894 | Rs 39,197 |
| 41 | Aug 2024 | STRONG_BUY | 10 | +0.86% | Rs 858 | Rs 40,055 |
| 42 | Sep 2024 | STRONG_BUY | 10 | +3.70% | Rs 3,700 | Rs 43,755 |
| 43 | Oct 2024 | BUY | 7 | -7.54% | Rs -7,543 | Rs 36,212 |
| 44 | Nov 2024 | SELECTIVE | 4 | +2.10% | Rs 2,102 | Rs 38,314 |
| 45 | Dec 2024 | BUY | 7 | -1.29% | Rs -1,295 | Rs 37,019 |
| 46 | Jan 2025 | SELECTIVE | 4 | -8.86% | Rs -8,861 | Rs 28,157 |
| 47 | Feb 2025 | BUY | 7 | -5.96% | Rs -5,963 | Rs 22,194 |
| 48 | Mar 2025 | STAY_OUT | - | skipped | Rs 0 | Rs 22,194 |
| 49 | Apr 2025 | STAY_OUT | - | skipped | Rs 0 | Rs 22,194 |
| 50 | May 2025 | STRONG_BUY | 10 | +2.86% | Rs 2,858 | Rs 25,052 |
| 51 | Jun 2025 | BUY | 7 | +1.53% | Rs 1,530 | Rs 26,581 |
| 52 | Jul 2025 | STRONG_BUY | 10 | -4.35% | Rs -4,346 | Rs 22,235 |
| 53 | Aug 2025 | STAY_OUT | - | skipped | Rs 0 | Rs 22,235 |
| 54 | Sep 2025 | STAY_OUT | - | skipped | Rs 0 | Rs 22,235 |
| 55 | Oct 2025 | STAY_OUT | - | skipped | Rs 0 | Rs 22,235 |
| 56 | Nov 2025 | BUY | 7 | +1.48% | Rs 1,479 | Rs 23,714 |
| 57 | Dec 2025 | STRONG_BUY | 10 | +0.01% | Rs 14 | Rs 23,728 |
| 58 | Jan 2026 | STRONG_BUY | 10 | -3.10% | Rs -3,103 | Rs 20,625 |
| 59 | Feb 2026 | SELECTIVE | 4 | +7.27% | Rs 7,267 | Rs 27,892 |
| 60 | Mar 2026 | STAY_OUT | - | skipped | Rs 0 | Rs 27,892 |

### Without Mood Filter

| # | Month | Mood | Picks | Avg Return | Month P&L (Rs) | Cumulative P&L (Rs) |
|---|-------|------|-------|------------|----------------|--------------------|
| 1 | Apr 2021 | STRONG_BUY | 10 | +5.96% | Rs 5,964 | Rs 5,964 |
| 2 | May 2021 | BUY | 10 | +4.91% | Rs 4,912 | Rs 10,876 |
| 3 | Jun 2021 | STRONG_BUY | 10 | +1.23% | Rs 1,228 | Rs 12,104 |
| 4 | Jul 2021 | SELECTIVE | 10 | +1.51% | Rs 1,514 | Rs 13,618 |
| 5 | Aug 2021 | SELECTIVE | 10 | +6.69% | Rs 6,695 | Rs 20,313 |
| 6 | Sep 2021 | STRONG_BUY | 10 | -0.69% | Rs -688 | Rs 19,625 |
| 7 | Oct 2021 | SELECTIVE | 10 | +4.65% | Rs 4,651 | Rs 24,275 |
| 8 | Nov 2021 | SELECTIVE | 10 | -1.15% | Rs -1,148 | Rs 23,127 |
| 9 | Dec 2021 | STAY_OUT | 10 | -1.98% | Rs -1,978 | Rs 21,148 |
| 10 | Jan 2022 | STRONG_BUY | 10 | -3.79% | Rs -3,793 | Rs 17,355 |
| 11 | Feb 2022 | STRONG_BUY | 10 | -10.02% | Rs -10,020 | Rs 7,335 |
| 12 | Mar 2022 | STAY_OUT | 10 | +4.20% | Rs 4,202 | Rs 11,537 |
| 13 | Apr 2022 | STRONG_BUY | 10 | +3.04% | Rs 3,036 | Rs 14,573 |
| 14 | May 2022 | SELECTIVE | 10 | -3.94% | Rs -3,935 | Rs 10,638 |
| 15 | Jun 2022 | BUY | 10 | -6.26% | Rs -6,255 | Rs 4,382 |
| 16 | Jul 2022 | SELECTIVE | 10 | +10.61% | Rs 10,608 | Rs 14,990 |
| 17 | Aug 2022 | STRONG_BUY | 10 | -1.23% | Rs -1,234 | Rs 13,756 |
| 18 | Sep 2022 | SELECTIVE | 10 | -2.51% | Rs -2,508 | Rs 11,248 |
| 19 | Oct 2022 | STAY_OUT | 10 | +0.35% | Rs 348 | Rs 11,596 |
| 20 | Nov 2022 | STRONG_BUY | 10 | -1.79% | Rs -1,790 | Rs 9,806 |
| 21 | Dec 2022 | STRONG_BUY | 10 | -4.10% | Rs -4,100 | Rs 5,706 |
| 22 | Jan 2023 | SELECTIVE | 10 | -3.12% | Rs -3,118 | Rs 2,588 |
| 23 | Feb 2023 | STAY_OUT | 10 | -2.71% | Rs -2,711 | Rs -124 |
| 24 | Mar 2023 | STAY_OUT | 10 | -0.66% | Rs -664 | Rs -787 |
| 25 | Apr 2023 | BUY | 10 | +2.42% | Rs 2,420 | Rs 1,633 |
| 26 | May 2023 | STRONG_BUY | 10 | +3.69% | Rs 3,689 | Rs 5,321 |
| 27 | Jun 2023 | STRONG_BUY | 10 | +2.67% | Rs 2,670 | Rs 7,991 |
| 28 | Jul 2023 | STRONG_BUY | 10 | +5.90% | Rs 5,897 | Rs 13,887 |
| 29 | Aug 2023 | STRONG_BUY | 10 | +1.71% | Rs 1,711 | Rs 15,598 |
| 30 | Sep 2023 | STRONG_BUY | 10 | +2.93% | Rs 2,932 | Rs 18,530 |
| 31 | Oct 2023 | SELECTIVE | 10 | -4.37% | Rs -4,373 | Rs 14,158 |
| 32 | Nov 2023 | SELECTIVE | 10 | +7.89% | Rs 7,892 | Rs 22,050 |
| 33 | Dec 2023 | STRONG_BUY | 10 | +7.65% | Rs 7,647 | Rs 29,697 |
| 34 | Jan 2024 | BUY | 10 | +4.47% | Rs 4,475 | Rs 34,172 |
| 35 | Feb 2024 | STRONG_BUY | 10 | +6.85% | Rs 6,850 | Rs 41,021 |
| 36 | Mar 2024 | STRONG_BUY | 10 | -2.95% | Rs -2,952 | Rs 38,070 |
| 37 | Apr 2024 | STRONG_BUY | 10 | +5.61% | Rs 5,609 | Rs 43,679 |
| 38 | May 2024 | BUY | 10 | +1.22% | Rs 1,221 | Rs 44,900 |
| 39 | Jun 2024 | BUY | 10 | -4.65% | Rs -4,646 | Rs 40,254 |
| 40 | Jul 2024 | STRONG_BUY | 10 | +7.89% | Rs 7,894 | Rs 48,148 |
| 41 | Aug 2024 | STRONG_BUY | 10 | +0.86% | Rs 858 | Rs 49,005 |
| 42 | Sep 2024 | STRONG_BUY | 10 | +3.70% | Rs 3,700 | Rs 52,705 |
| 43 | Oct 2024 | BUY | 10 | -6.83% | Rs -6,826 | Rs 45,879 |
| 44 | Nov 2024 | SELECTIVE | 10 | +0.86% | Rs 857 | Rs 46,735 |
| 45 | Dec 2024 | BUY | 10 | -1.09% | Rs -1,092 | Rs 45,644 |
| 46 | Jan 2025 | SELECTIVE | 10 | -5.25% | Rs -5,248 | Rs 40,395 |
| 47 | Feb 2025 | BUY | 10 | -7.07% | Rs -7,075 | Rs 33,320 |
| 48 | Mar 2025 | STAY_OUT | 9 | +8.40% | Rs 8,405 | Rs 41,725 |
| 49 | Apr 2025 | STAY_OUT | 10 | +1.23% | Rs 1,228 | Rs 42,952 |
| 50 | May 2025 | STRONG_BUY | 10 | +2.86% | Rs 2,858 | Rs 45,810 |
| 51 | Jun 2025 | BUY | 10 | -0.27% | Rs -274 | Rs 45,536 |
| 52 | Jul 2025 | STRONG_BUY | 10 | -4.35% | Rs -4,346 | Rs 41,190 |
| 53 | Aug 2025 | STAY_OUT | 10 | -2.31% | Rs -2,306 | Rs 38,884 |
| 54 | Sep 2025 | STAY_OUT | 10 | +1.05% | Rs 1,053 | Rs 39,937 |
| 55 | Oct 2025 | STAY_OUT | 10 | +5.12% | Rs 5,125 | Rs 45,062 |
| 56 | Nov 2025 | BUY | 10 | +1.95% | Rs 1,952 | Rs 47,014 |
| 57 | Dec 2025 | STRONG_BUY | 10 | +0.01% | Rs 14 | Rs 47,028 |
| 58 | Jan 2026 | STRONG_BUY | 10 | -3.10% | Rs -3,103 | Rs 43,926 |
| 59 | Feb 2026 | SELECTIVE | 10 | +3.39% | Rs 3,387 | Rs 47,313 |
| 60 | Mar 2026 | STAY_OUT | 10 | -6.62% | Rs -6,622 | Rs 40,690 |

---

## 4. Trade Statistics

### With Mood Filter

| Metric | Value |
|--------|-------|
| Total Trades | 379 |
| Wins / Losses | 193 / 186 |
| Win Rate | 50.9% |
| Avg Return | +0.72% |
| Median Return | +0.16% |
| Avg Peak Return | +5.26% |
| Avg Hold Days | 21.5 |
| Best Trade | LODHA.NS +29.67% |
| Worst Trade | LODHA.NS -18.74% |

**Exit Distribution:**

| Exit Reason | Count | % | Avg Return |
|------------|-------|---|------------|
| Trailing Stop | 129 | 34.0% | -6.93% |
| Target Hit | 60 | 15.8% | +12.22% |
| Time Expiry | 190 | 50.1% | +2.28% |

**Top 10 Winners:**

| Symbol | Month | Entry | Exit | Return | Exit Reason | Hold |
|--------|-------|-------|------|--------|-------------|------|
| LODHA | Nov 2021 | Rs 589 | Rs 764 | +29.67% | TARGET | 28d |
| RECLTD | Jul 2024 | Rs 525 | Rs 642 | +22.13% | TARGET | 10d |
| ADANIGREEN | Apr 2022 | Rs 1945 | Rs 2374 | +22.07% | TARGET | 7d |
| JINDALSTEL | Apr 2021 | Rs 371 | Rs 451 | +21.72% | TARGET | 23d |
| JSWENERGY | Apr 2021 | Rs 91 | Rs 110 | +20.84% | EXPIRY | 26d |
| TATASTEEL | Apr 2021 | Rs 86 | Rs 104 | +20.11% | TARGET | 25d |
| JSWSTEEL | Apr 2021 | Rs 509 | Rs 597 | +17.34% | TARGET | 4d |
| ADANIPOWER | Aug 2023 | Rs 55 | Rs 64 | +16.92% | TARGET | 17d |
| SHRIRAMFIN | Jul 2022 | Rs 256 | Rs 299 | +16.49% | TARGET | 21d |
| ADANIENT | Dec 2023 | Rs 2359 | Rs 2741 | +16.23% | TARGET | 4d |

**Bottom 10 Losers:**

| Symbol | Month | Entry | Exit | Return | Exit Reason | Hold |
|--------|-------|-------|------|--------|-------------|------|
| LODHA | Feb 2022 | Rs 649 | Rs 527 | -18.74% | TRAILING | 22d |
| TORNTPHARM | Jan 2022 | Rs 1639 | Rs 1342 | -18.15% | TRAILING | 24d |
| CHOLAFIN | May 2022 | Rs 747 | Rs 637 | -14.69% | TRAILING | 3d |
| INDHOTEL | May 2022 | Rs 262 | Rs 225 | -14.02% | TRAILING | 8d |
| MPHASIS | Apr 2022 | Rs 3344 | Rs 2880 | -13.88% | TRAILING | 14d |
| APOLLOTYRE | Apr 2021 | Rs 236 | Rs 204 | -13.79% | TRAILING | 8d |
| ACC | Feb 2022 | Rs 2333 | Rs 2014 | -13.66% | TRAILING | 22d |
| ADANIPORTS | Jun 2024 | Rs 1437 | Rs 1249 | -13.11% | TRAILING | 2d |
| ADANIGREEN | Mar 2024 | Rs 1970 | Rs 1725 | -12.42% | TRAILING | 11d |
| INDHOTEL | Feb 2022 | Rs 223 | Rs 195 | -12.35% | TRAILING | 12d |

**Sector Performance:**

| Sector | Trades | Win Rate | Avg Return | Total P&L Contribution |
|--------|--------|----------|------------|------------------------|
| Airlines | 3 | 67% | +5.93% | +17.80% |
| Insurance | 10 | 90% | +5.39% | +53.88% |
| Defence | 6 | 50% | +4.11% | +24.66% |
| Metals | 21 | 57% | +3.91% | +82.08% |
| Telecom | 6 | 83% | +3.88% | +23.27% |
| Internet | 3 | 67% | +3.83% | +11.49% |
| Diversified | 5 | 60% | +2.72% | +13.62% |
| Infrastructure | 12 | 75% | +2.24% | +26.87% |
| IT | 24 | 63% | +2.05% | +49.25% |
| Power | 22 | 50% | +1.92% | +42.17% |
| Pharma | 35 | 57% | +1.44% | +50.43% |
| Finance | 29 | 45% | +1.08% | +31.25% |
| Auto | 33 | 58% | +0.98% | +32.30% |
| Mining | 10 | 60% | +0.57% | +5.65% |
| Capital Goods | 6 | 50% | -0.18% | -1.07% |
| Chemicals | 4 | 50% | -0.39% | -1.57% |
| Banking | 46 | 39% | -0.54% | -25.02% |
| FMCG | 24 | 50% | -0.70% | -16.68% |
| Hospitality | 8 | 63% | -0.94% | -7.54% |
| Auto Components | 8 | 38% | -1.14% | -9.12% |
| Renewable Energy | 5 | 20% | -1.56% | -7.81% |
| Cement | 12 | 33% | -1.72% | -20.70% |
| Retail | 4 | 50% | -1.89% | -7.57% |
| Energy | 20 | 40% | -2.01% | -40.17% |
| Consumer Durables | 4 | 25% | -2.05% | -8.21% |
| Healthcare | 2 | 0% | -2.22% | -4.45% |
| Real Estate | 7 | 14% | -2.34% | -16.40% |
| Consumer | 7 | 43% | -2.56% | -17.92% |
| Tourism | 3 | 33% | -2.84% | -8.51% |

### Without Mood Filter

| Metric | Value |
|--------|-------|
| Total Trades | 599 |
| Wins / Losses | 298 / 301 |
| Win Rate | 49.7% |
| Avg Return | +0.67% |
| Median Return | -0.01% |
| Avg Peak Return | +5.36% |
| Avg Hold Days | 21.5 |
| Best Trade | ADANIPOWER.NS +40.00% |
| Worst Trade | LODHA.NS -18.74% |

**Exit Distribution:**

| Exit Reason | Count | % | Avg Return |
|------------|-------|---|------------|
| Trailing Stop | 217 | 36.2% | -6.64% |
| Target Hit | 93 | 15.5% | +13.11% |
| Time Expiry | 289 | 48.2% | +2.15% |

**Top 10 Winners:**

| Symbol | Month | Entry | Exit | Return | Exit Reason | Hold |
|--------|-------|-------|------|--------|-------------|------|
| ADANIPOWER | Mar 2022 | Rs 25 | Rs 35 | +40.00% | TARGET | 27d |
| LODHA | Nov 2021 | Rs 589 | Rs 764 | +29.67% | TARGET | 28d |
| JINDALSTEL | Mar 2022 | Rs 425 | Rs 525 | +23.49% | TARGET | 22d |
| RECLTD | Jul 2024 | Rs 525 | Rs 642 | +22.13% | TARGET | 10d |
| ADANIGREEN | Apr 2022 | Rs 1945 | Rs 2374 | +22.07% | TARGET | 7d |
| JINDALSTEL | Apr 2021 | Rs 371 | Rs 451 | +21.72% | TARGET | 23d |
| JSWENERGY | Apr 2021 | Rs 91 | Rs 110 | +20.84% | EXPIRY | 26d |
| RECLTD | Nov 2023 | Rs 302 | Rs 364 | +20.29% | TARGET | 28d |
| TATASTEEL | Apr 2021 | Rs 86 | Rs 104 | +20.11% | TARGET | 25d |
| CGPOWER | Oct 2021 | Rs 123 | Rs 146 | +18.87% | TARGET | 24d |

**Bottom 10 Losers:**

| Symbol | Month | Entry | Exit | Return | Exit Reason | Hold |
|--------|-------|-------|------|--------|-------------|------|
| LODHA | Feb 2022 | Rs 649 | Rs 527 | -18.74% | TRAILING | 22d |
| TORNTPHARM | Jan 2022 | Rs 1639 | Rs 1342 | -18.15% | TRAILING | 24d |
| LODHA | Dec 2021 | Rs 709 | Rs 592 | -16.48% | TRAILING | 16d |
| APOLLOHOSP | Dec 2021 | Rs 5688 | Rs 4787 | -15.84% | TRAILING | 16d |
| TRENT | Feb 2025 | Rs 6190 | Rs 5277 | -14.74% | TRAILING | 4d |
| CHOLAFIN | May 2022 | Rs 747 | Rs 637 | -14.69% | TRAILING | 3d |
| INDHOTEL | May 2022 | Rs 262 | Rs 225 | -14.02% | TRAILING | 8d |
| MPHASIS | Apr 2022 | Rs 3344 | Rs 2880 | -13.88% | TRAILING | 14d |
| APOLLOTYRE | Apr 2021 | Rs 236 | Rs 204 | -13.79% | TRAILING | 8d |
| ACC | Feb 2022 | Rs 2333 | Rs 2014 | -13.66% | TRAILING | 22d |

**Sector Performance:**

| Sector | Trades | Win Rate | Avg Return | Total P&L Contribution |
|--------|--------|----------|------------|------------------------|
| Airlines | 4 | 75% | +7.81% | +31.22% |
| Insurance | 15 | 67% | +3.13% | +46.91% |
| Metals | 38 | 53% | +2.86% | +108.56% |
| IT | 36 | 61% | +2.61% | +93.87% |
| Diversified | 9 | 56% | +2.57% | +23.12% |
| Capital Goods | 13 | 54% | +2.53% | +32.90% |
| Power | 35 | 54% | +2.48% | +86.81% |
| Internet | 5 | 60% | +2.42% | +12.12% |
| Telecom | 9 | 67% | +2.28% | +20.54% |
| Finance | 49 | 51% | +1.91% | +93.40% |
| Infrastructure | 13 | 69% | +1.87% | +24.32% |
| Defence | 13 | 46% | +1.71% | +22.27% |
| Mining | 16 | 63% | +1.21% | +19.31% |
| Auto | 49 | 53% | +0.49% | +24.05% |
| Tourism | 4 | 50% | +0.44% | +1.76% |
| Banking | 72 | 46% | +0.23% | +16.87% |
| Hospitality | 10 | 60% | +0.09% | +0.92% |
| Pharma | 53 | 49% | +0.06% | +3.14% |
| Consumer Durables | 8 | 50% | -0.12% | -0.94% |
| FMCG | 45 | 44% | -0.65% | -29.08% |
| Energy | 30 | 47% | -1.50% | -44.89% |
| Cement | 15 | 40% | -1.54% | -23.09% |
| Auto Components | 13 | 38% | -1.64% | -21.26% |
| Retail | 8 | 38% | -2.40% | -19.20% |
| Renewable Energy | 6 | 17% | -2.62% | -15.73% |
| Consumer | 9 | 33% | -2.75% | -24.72% |
| Real Estate | 9 | 22% | -2.75% | -24.75% |
| Chemicals | 7 | 29% | -3.27% | -22.91% |
| Healthcare | 6 | 0% | -6.17% | -37.00% |

---

## 5. With Filter vs Without Filter Comparison

| Metric | With Filter | Without Filter | Difference |
|--------|------------|----------------|------------|
| Total Trades | 379 | 599 | - |
| Win Rate | 50.9% | 49.7% | - |
| Avg Return/Trade | +0.72% | +0.67% | - |
| Total Invested | Rs 60.00L | Rs 60.00L | - |
| Total Returned | Rs 60.28L | Rs 60.41L | - |
| Total P&L | Rs 0.28L | Rs 0.41L | - |
| XIRR | +10.14% | +12.96% | - |
| Months Skipped | 11 | 0 | - |

### Year-by-Year Return Comparison

| Year | With Filter Return | Without Filter Return | Nifty SIP Return | Filter Better? |
|------|--------------------|-----------------------|------------------|----------------|
| Year 1 | +0.02% | +0.96% | +7.60% | NO |
| Year 2 | -0.61% | -1.03% | +2.82% | YES |
| Year 3 | +2.88% | +3.24% | +26.72% | NO |
| Year 4 | -0.44% | +0.30% | +22.35% | NO |
| Year 5 | +0.47% | -0.09% | +14.00% | YES |

### Exit Reason Distribution Comparison

| Exit Reason | With Filter | % | Without Filter | % |
|------------|-------------|---|----------------|---|
| SL_CONFIRMED | 0 | 0.0% | 0 | 0.0% |
| TRAILING | 129 | 34.0% | 217 | 36.2% |
| TARGET | 60 | 15.8% | 93 | 15.5% |
| EXPIRY | 190 | 50.1% | 289 | 48.2% |
| NO_DATA | 0 | 0.0% | 0 | 0.0% |

---

## 6. Key Insights

### Consistency Across Years

- **With filter:** 3/5 years profitable
- **Without filter:** 3/5 years profitable
- **Best year (with filter):** Year 3 at +2.88%
- **Worst year (with filter):** Year 2 at -0.61%
- **Best year (no filter):** Year 3 at +3.24%
- **Worst year (no filter):** Year 2 at -1.03%

### Mood Filter Effectiveness for Mid-Term

The mood filter **hurts** mid-term XIRR by +2.82%.  
It skipped 11 months, but some of those months had profitable mid-term opportunities.  
Consider: mid-term picks may be resilient enough to trade through bearish macro conditions.  

### STAY_OUT Months Validation

What happened to the no-filter picks during months the filter said STAY_OUT?

| Month | No-Filter Picks | No-Filter Avg Return | Filter Correct? |
|-------|----------------|---------------------|------------------|
| Dec 2021 | 10 | -1.98% | YES (loss avoided) |
| Mar 2022 | 10 | +4.20% | NO (missed gains) |
| Oct 2022 | 10 | +0.35% | NO (missed gains) |
| Feb 2023 | 10 | -2.71% | YES (loss avoided) |
| Mar 2023 | 10 | -0.66% | YES (loss avoided) |
| Mar 2025 | 9 | +8.40% | NO (missed gains) |
| Apr 2025 | 10 | +1.23% | NO (missed gains) |
| Aug 2025 | 10 | -2.31% | YES (loss avoided) |
| Sep 2025 | 10 | +1.05% | NO (missed gains) |
| Oct 2025 | 10 | +5.12% | NO (missed gains) |
| Mar 2026 | 10 | -6.62% | YES (loss avoided) |

**Filter accuracy for mid-term:** 5/11 = 45% of STAY_OUT months actually had negative mid-term returns.  

### Alpha Over Nifty 50 SIP

- **With filter XIRR alpha:** +2.42% over Nifty SIP
- **Without filter XIRR alpha:** +5.25% over Nifty SIP
- **Nifty SIP final value:** Rs 73.08L on Rs 60.00L invested
- Mid-term strategy generates positive alpha over passive Nifty investing in both modes

---

## Disclaimer

This is a **paper trading simulation** with the following limitations:

- **Survivorship bias:** Uses current Nifty 100 constituents; stocks that were delisted or removed are not included.
- **Look-ahead bias in stock list:** The Nifty 100 composition changes over time; this simulation uses today's list for all 5 years.
- **No slippage or transaction costs:** Real execution would involve brokerage, STT, impact cost, and bid-ask spread.
- **No compounding reinvestment:** Idle capital from STAY_OUT months earns 0% (in reality, it could be parked in liquid funds).
- **Yahoo Finance data quality:** Adjusted prices may have gaps, especially around splits and bonuses.
- **Indicator computation:** Indicators are computed on available data; missing bars are skipped, not interpolated.
- **SIP assumption:** Equal weight across all picks each month; real portfolio would need rebalancing.

*Generated by StarBhai Mid-Term 5-Year SIP Backtest Engine*
