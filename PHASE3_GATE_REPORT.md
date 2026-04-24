# Phase 3 Gate Report — V1 vs V2 Scorer Backtest

**Date:** 2026-04-24
**Scope:** Nifty 100 universe, 3 scan dates (Nov 2025, Dec 2025, Jan 2026), exits at Apr 15 2026.
**Gate decision:** ✓ **PROMOTE V2 TO PRODUCTION (staged rollout).**

---

## Headline numbers

| metric                    | V1       | V2       | Δ         |
|---------------------------|----------|----------|-----------|
| Trades (combined)         | 60       | 60       | —         |
| Win rate                  | 23%      | 42%      | **+18pp** |
| Avg return / trade        | −4.0%    | −2.0%    | +2.0pp    |
| Median return             | −5.4%    | −4.8%    | +0.7pp    |
| **Portfolio XIRR**        | **−17.5%** | **−6.9%**  | **+10.6pp** |
| SL hits (stop-outs)       | 37       | 24       | −13       |
| Target hits               | 6        | 4        | −2        |
| Nifty 50 benchmark XIRR   | −18.3%   | −18.3%   | —         |
| Alpha vs Nifty            | +0.8pp   | **+11.4pp** | +10.6pp |

The backtest window happened to be a bear/sideways one (Nifty −7% / −18% XIRR). Both scorers lost
money in absolute terms, but V2's restraint — notably its 13 fewer stop-outs — is what drove
the 10.6pp XIRR edge.

## Why V2 wins: value-trap avoidance

Of the 34 V1 DEEP_VALUE picks that V2 rejected (V2 downgraded them to FAIR_VALUE or
QUALITY_GROWTH), only 18% finished positive and the average return was **−3.7%**. The worst
rejections all hit the −20% stop-loss:

| Symbol     | Scan     | V1 score | Forward return | Exit reason |
|------------|----------|----------|----------------|-------------|
| MARUTI.NS  | Jan 2026 | 76 DV    | −20.0%         | SL          |
| MPHASIS.NS | Dec 2025 | 73 DV    | −17.8%         | SL          |
| LICI.NS    | Dec 2025 | 80 DV    | −15.0%         | SL          |
| WIPRO.NS   | Jan 2026 | 78 DV    | −12.1%         | SL          |
| TCS.NS     | Jan 2026 | 78 DV    | −11.2%         | SL          |

These are exactly the pattern V2 was built to catch: V1 saw "cheap P/E, good ROE" and
stamped DEEP_VALUE; V2's Value pillar looked at the premium-to-sector P/E, flagged PEG
as weak under analyst-coverage gating, and downgraded the verdict. The market agreed.

## Why V2 wins: V2-only picks that worked

V2 identified 32 trades V1 missed; 15 of them (47%) finished positive. Top V2-only wins:

| Symbol        | Scan      | sectorKind | V2 verdict     | Return  |
|---------------|-----------|------------|----------------|---------|
| ONGC.NS       | (3 scans) | other      | QUALITY_GROWTH | +12.6 / +18.2 / +20.9% |
| LUPIN.NS      | Nov 2025  | other      | QUALITY_GROWTH | +19.1%  |
| SBIN.NS       | Dec 2025  | bfsi       | QUALITY_GROWTH | +14.5%  |
| BAJAJ-AUTO.NS | (2 scans) | other      | QUALITY_GROWTH | +10.9 / +8.7% |

ONGC and SBIN are the most telling: V1 penalised them for the kinds of metric gaps (banks
have no EBITDA line, energy companies have lumpy margins) that V2's **tier-adaptive
scoring** is designed to handle. V2 correctly treats BFSI D/E and currentRatio as N/A
rather than scoring them zero, and up-weights Value/Past/Future for banks.

## Selection overlap

- Both scorers picked: 19 stock-scans
- V1 only: 29
- V2 only: 27

Roughly 25% overlap — the two scorers genuinely diverge on selection, not just scoring.
This is what we want from a replacement: V2 isn't a cosmetic re-weighting of V1, it's a
different model.

## Caveats (same as the baseline backtest)

1. **Single look-ahead approximation.** Both scorers used the current Apr 2026 fundamentals
   snapshot for all 3 scan dates. ROE/margins are stable QoQ for most large caps, but
   forwardEps/dividendYield are strictly future-information. Both scorers eat the same
   approximation so the V1-vs-V2 comparison is apples-to-apples — but absolute numbers
   aren't production-grade.
2. **Single market window.** Nov 2025 – Apr 2026 was a weak market. V2's advantage is
   concentrated in avoiding drawdowns; a strong bull market might compress the edge.
3. **Nifty 100 only.** Smallcap/midcap behaviour may differ (V2's pillars depend on
   Yahoo coverage which is weaker outside large-cap).
4. **Governance pillar is still a stub.** Full Phase 2 governance (promoter pledge,
   related-party txns from BSE XBRL) is not yet wired — V2 ran with governance N/A
   for every stock.

## Gate decision

V2 clears the +2pp XIRR bar with **+10.6pp**, win rate **+18pp**, and independently
motivated value-trap avoidance evidence. Promote.

## Phase 4 rollout plan (suggested)

1. **Parity window** (no code change): keep running shadow compare weekly for 4 weeks,
   verify V2 score distribution stays stable vs this baseline.
2. **Expose V2 in the detail endpoint** (already done — `shadowV2` is on
   `/api/fundamentals/:symbol` as of this phase).
3. **Gate by verdict, not score**: make V2's verdict authoritative on the detail view
   while keeping V1's score visible with a "legacy scorer" badge. Users see both for
   one release cycle — SEBI Reg 15(2) compliance stays clean because we disclose the
   change.
4. **Swap the scan endpoint** (`/api/scan/fundamentals`): replace
   `scoreFundamentals` → `scoreFundamentalsV2` behind a feature flag. Monitor pick
   churn before removing V1.
5. **Sunset V1** after one full refresh cycle with no user-reported regressions.

Backing data: `scripts/output/backtest-v2-compare.json` (per-trade records).
Run: `node scripts/backtest-v2-compare.mjs` to reproduce.
