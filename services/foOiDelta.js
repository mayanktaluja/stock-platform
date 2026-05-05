/**
 * Compute day-over-day OI / price deltas, classify into swing signals,
 * and emit a composite 0-100 score per underlying.
 *
 * Inputs come from foBhavcopyParser's `aggregated` output. The bhavcopy
 * itself carries `ChngInOpnIntrst` and `PrvsClsgPric` per contract, so we
 * can compute today's deltas without loading yesterday's file. Yesterday's
 * file is only needed for the 20-day volume baseline (handled by
 * foHistory.js, not here).
 */

import {
  FO_CONFIG,
  classifySignal,
  isDecoupled,
  volumeBucket,
} from "./foConfig.js";

function pct(num, den) {
  if (den == null || den === 0 || !Number.isFinite(den)) return null;
  if (num == null || !Number.isFinite(num)) return null;
  return (num / den) * 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Per-underlying composite score, 0-100. Documented design:
 *   raw       = clamp(|OI Δ%|, 0, 50) / 50
 *   volBoost  = clamp(volRatio, 0.5, 3.0) / 3.0      (treats <0.5× as 0.5×)
 *   decouple  = 1.25 if decoupled else 1.0
 *   consist.  = 0.85 if OI and price moved opposite directions, else 1.0
 *   score     = 100 * raw * (0.4 + 0.6 * volBoost) * decouple * consist
 *
 * The (0.4 + 0.6*volBoost) shape means: a thin-volume signal still scores
 * (the 0.4 floor), but never the same as a confirmed one.
 */
export function computeScore({
  oiDeltaPct,
  priceDeltaPct,
  volumeRatio,
  decoupled,
}) {
  if (!Number.isFinite(oiDeltaPct)) return 0;

  const raw = clamp(Math.abs(oiDeltaPct), 0, FO_CONFIG.SCORE_RAW_OI_CAP) /
    FO_CONFIG.SCORE_RAW_OI_CAP;

  const volBoost = Number.isFinite(volumeRatio)
    ? clamp(volumeRatio, 0.5, FO_CONFIG.SCORE_VOL_CAP) / FO_CONFIG.SCORE_VOL_CAP
    : 1 / FO_CONFIG.SCORE_VOL_CAP; // unknown vol → conservative

  const decouple = decoupled ? FO_CONFIG.SCORE_DECOUPLE_BOOST : 1.0;

  const sameDir =
    Number.isFinite(priceDeltaPct) &&
    Math.sign(oiDeltaPct) === Math.sign(priceDeltaPct);
  const consistency = sameDir
    ? 1.0
    : FO_CONFIG.SCORE_DIRECTION_INCONSISTENT_PENALTY;

  return Math.round(100 * raw * (0.4 + 0.6 * volBoost) * decouple * consistency);
}

/**
 * Build a one-line interpretation string from the classified signal +
 * decoupling flag. Short, neutral, no buy/sell directives.
 */
function interpretation({ signal, decoupled, oiDeltaPct, priceDeltaPct }) {
  const ad = decoupled ? " · OI moving while spot is flat (smart-money positioning?)" : "";
  switch (signal) {
    case "long_buildup":
      return `Bulls adding fresh longs — OI up with price${ad}.`;
    case "short_buildup":
      return `Bears adding fresh shorts — OI up while price drops${ad}.`;
    case "long_unwinding":
      return `Longs being booked — OI falling with price${ad}.`;
    case "short_covering":
      return `Shorts covering — OI falling as price recovers${ad}.`;
    case "neutral":
    default:
      if (decoupled) {
        return `OI ${oiDeltaPct > 0 ? "rising" : "falling"} sharply while spot barely moves — watch for catalyst.`;
      }
      return "No meaningful conviction — OI/price moves both within noise.";
  }
}

/**
 * Compute deltas + classification + score for every underlying in the
 * aggregated map. `volumeRatios` is an optional Map<underlying, ratio>
 * supplied by foHistory; absent → vol-confirmation downweighted.
 *
 * Returns an array of stock objects, sorted desc by score.
 */
export function computeOiDeltas(aggregated, volumeRatios = new Map()) {
  const out = [];

  for (const [underlying, agg] of Object.entries(aggregated)) {
    const oiYesterday = agg.oiTotal - agg.oiChangeTotal;
    const oiDeltaPct = pct(agg.oiChangeTotal, oiYesterday);

    const priceDeltaPct = pct(
      (agg.nearMonthSettle ?? 0) - (agg.nearMonthPrevClose ?? 0),
      agg.nearMonthPrevClose,
    );

    const volumeRatio = volumeRatios.get(underlying) ?? null;
    const decoupled = isDecoupled(priceDeltaPct ?? 0, oiDeltaPct ?? 0);
    const signal = classifySignal(priceDeltaPct ?? 0, oiDeltaPct ?? 0);
    const score = computeScore({
      oiDeltaPct,
      priceDeltaPct,
      volumeRatio,
      decoupled,
    });

    out.push({
      underlying,
      instrumentType: agg.instrumentType,
      expiryCount: agg.expiryCount,
      nearMonthExpiry: agg.nearMonthExpiry,
      nearMonthSettle: agg.nearMonthSettle,
      underlyingPrice: agg.underlyingPrice,
      oiTotal: agg.oiTotal,
      oiChangeTotal: agg.oiChangeTotal,
      volumeTotal: agg.volumeTotal,
      oiDeltaPct,
      priceDeltaPct,
      volumeRatio,
      volumeBucket: volumeBucket(volumeRatio),
      signal,
      decoupled,
      score,
      interpretation: interpretation({
        signal,
        decoupled,
        oiDeltaPct: oiDeltaPct ?? 0,
        priceDeltaPct: priceDeltaPct ?? 0,
      }),
    });
  }

  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}
