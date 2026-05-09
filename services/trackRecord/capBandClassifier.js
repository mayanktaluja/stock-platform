/**
 * Cap-band classifier for the SEBI-RA-grade Track Record.
 *
 * Routes each pick to the right TRI proxy benchmark based on market cap.
 * V1 thresholds are dollar-amount based (₹50,000 cr large / ₹15,000 cr mid)
 * — pragmatic for the snapshot moment, easier to reason about than a
 * rank-based mapping. Flag in the plan: a V2 upgrade would use SEBI's
 * official rank-based definition (top 100 = large, 101–250 = mid, 251+ = small).
 *
 * Benchmark proxies are defined in benchmarkIndices.js:
 *   nifty50_tri    — UTI Nifty 50 Index Fund (scheme 120716)
 *   midcap150_tri  — Motilal Oswal Nifty Midcap 150 (scheme 147625)
 *   smallcap250_tri— Nippon India Nifty Smallcap 250 (scheme 147622)
 *
 * The classifier is a pure function so the snapshotter, resolver, and
 * scorecard aggregator all agree on the same thresholds.
 */

// Crore boundaries, in raw rupees.
const LARGE_CAP_THRESHOLD_INR = 50_000 * 1e7;  // ₹50,000 cr
const MID_CAP_THRESHOLD_INR   = 15_000 * 1e7;  // ₹15,000 cr

export function classifyCapBand(marketCapInr) {
  const m = Number(marketCapInr);
  if (!Number.isFinite(m) || m <= 0) return null;
  if (m >= LARGE_CAP_THRESHOLD_INR) return "large";
  if (m >= MID_CAP_THRESHOLD_INR) return "mid";
  return "small";
}

export function benchmarkProxyForCapBand(capBand) {
  if (capBand === "large") return "nifty50_tri";
  if (capBand === "mid") return "midcap150_tri";
  if (capBand === "small") return "smallcap250_tri";
  return "nifty50_tri"; // unknown → safest default (broad-market large-cap proxy)
}

export const CAP_BAND_THRESHOLDS = {
  largeMinInr: LARGE_CAP_THRESHOLD_INR,
  midMinInr: MID_CAP_THRESHOLD_INR,
};
