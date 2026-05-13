/**
 * calibration.js — PR T7
 *
 * Builds a Polymarket-style calibration plot of "predicted-confidence
 * bucket → realised hit-rate." Five buckets at 40–50 / 50–60 / 60–70 /
 * 70–80 / 80–100 %. For each bucket we report:
 *
 *   bucket_low, bucket_high — bucket bounds (in %)
 *   predicted_mid           — bucket midpoint
 *   n                       — count of resolved forecasts in the bucket
 *   realised_pct            — realised hit-rate among that bucket's picks
 *   ci_lo_pct, ci_hi_pct    — Wilson-style 95% CI half-width on realised
 *   thin                    — true when n < 30 (UI greys these out + flags)
 *
 * A perfectly-calibrated forecaster lands every bucket on the 45° line.
 * Bars below the line = over-confident (claimed 80%, hit 60%); above the
 * line = under-confident.
 *
 * Confidence source:
 *   1. Earnings-style trades store prediction.confidence_pct directly.
 *   2. SWS pick trades store v3 / composite scores rather than a calibrated
 *      probability. We map v3_score_100 → an implied hit-probability via
 *      the documented mapping in server.js comments:
 *        score 50 → 50 %, 60 → 55 %, 70 → 62 %, 78 → ~65 %, 85+ → 70 %.
 *      Linear interpolation between anchor points; below 40 returns null
 *      (excluded from calibration).
 *
 * Hit definition: alpha_pct > 0 (the call beat the benchmark). For trades
 * without alpha_pct we fall back to returnPct > 0.
 */

const BUCKETS = [
  { lo: 40, hi: 50 },
  { lo: 50, hi: 60 },
  { lo: 60, hi: 70 },
  { lo: 70, hi: 80 },
  { lo: 80, hi: 100 },
];
const THIN_N = 30;

function inferConfidencePct(trade) {
  // Earnings-shape: explicit probability already.
  if (trade && trade.prediction && Number.isFinite(trade.prediction.confidence_pct)) {
    return trade.prediction.confidence_pct;
  }
  // SWS-shape: derive from v3 score using the public mapping.
  const v3 =
    (trade && Number.isFinite(trade.v3_score_100)) ? trade.v3_score_100 :
    (trade && Number.isFinite(trade.v3_score)) ? trade.v3_score :
    (trade && trade.snapshot && Number.isFinite(trade.snapshot.v3_score_100)) ? trade.snapshot.v3_score_100 :
    null;
  if (!Number.isFinite(v3)) return null;
  if (v3 < 40) return null;
  // Anchor points (score → implied hit rate %) from the documented mapping.
  const anchors = [
    [40, 45], [50, 50], [60, 55], [70, 62], [78, 65], [85, 70], [100, 75],
  ];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [s0, p0] = anchors[i];
    const [s1, p1] = anchors[i + 1];
    if (v3 >= s0 && v3 <= s1) {
      const t = (v3 - s0) / (s1 - s0);
      return p0 + t * (p1 - p0);
    }
  }
  return null;
}

function classifyHit(trade) {
  // Prefer resolved alpha (already signed for "call was right"), fall
  // back to plain return percentage. Returns true/false/null.
  if (trade && trade.returns) {
    if (Number.isFinite(trade.returns.alphaPct)) return trade.returns.alphaPct > 0;
    if (Number.isFinite(trade.returns.returnPct)) return trade.returns.returnPct > 0;
  }
  if (Number.isFinite(trade.alpha_pct)) return trade.alpha_pct > 0;
  return null;
}

function wilsonCI(hits, n) {
  if (!n) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - halfWidth) * 100, hi: Math.min(1, centre + halfWidth) * 100 };
}

/**
 * @param {Array} trades — paper-trade entries with .returns and either
 *   .prediction.confidence_pct (earnings) or .v3_score_100 / .v3_score
 *   (SWS picks).
 * @returns {{ buckets: Array, total: number, resolved: number }}
 */
export function buildCalibration(trades) {
  const bucketAcc = BUCKETS.map((b) => ({ ...b, predicted_mid: (b.lo + b.hi) / 2, hits: 0, n: 0 }));
  let total = 0;
  let resolved = 0;
  if (!Array.isArray(trades)) {
    return {
      buckets: bucketAcc.map((b) => ({
        bucket_low: b.lo, bucket_high: b.hi, predicted_mid: b.predicted_mid,
        n: 0, realised_pct: null, ci_lo_pct: null, ci_hi_pct: null, thin: true,
      })),
      total: 0, resolved: 0,
    };
  }
  for (const t of trades) {
    if (!t) continue;
    total += 1;
    const conf = inferConfidencePct(t);
    if (conf == null) continue;
    const hit = classifyHit(t);
    if (hit == null) continue;
    resolved += 1;
    const b = bucketAcc.find((b) => conf >= b.lo && conf <= b.hi);
    if (!b) continue;
    b.n += 1;
    if (hit) b.hits += 1;
  }
  const buckets = bucketAcc.map((b) => {
    if (b.n === 0) {
      return {
        bucket_low: b.lo, bucket_high: b.hi, predicted_mid: b.predicted_mid,
        n: 0, realised_pct: null, ci_lo_pct: null, ci_hi_pct: null, thin: true,
      };
    }
    const realised = (b.hits / b.n) * 100;
    const { lo, hi } = wilsonCI(b.hits, b.n);
    return {
      bucket_low: b.lo, bucket_high: b.hi, predicted_mid: b.predicted_mid,
      n: b.n,
      realised_pct: +realised.toFixed(2),
      ci_lo_pct: +lo.toFixed(2),
      ci_hi_pct: +hi.toFixed(2),
      thin: b.n < THIN_N,
    };
  });
  return { buckets, total, resolved };
}

export const _internals = { inferConfidencePct, classifyHit, wilsonCI, THIN_N, BUCKETS };
