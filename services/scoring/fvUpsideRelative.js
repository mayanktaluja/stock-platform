// Relative, magnitude-aware fair-value-upside scoring (isolated block).
//
// Replaces the legacy absolute FV-upside band (services/swsScoring.js:305 —
// >=30%->12, >=15%->9, >=0%->6, ...). That band saturated at +30%, so a +150%
// upside and a +35% upside both scored the max 12 and all right-tail magnitude
// was thrown away.
//
// `upside_pct` across the scored universe is heavily right-skewed (median ~+14%,
// std ~90, skew ~+1.6, p99 ~+360%). A mean/std z-score is therefore the WRONG
// tool — the fat right tail dominates the std and crushes the investable bulk
// into a narrow band. Instead we:
//   1. signed-log compress the tail:  slog(u) = sign(u) * ln(1 + |u|)
//   2. standardize with the OUTLIER-ROBUST median + MAD (not mean/std):
//        rz = (slog(u) - median_slog) / (1.4826 * MAD)
//   3. map linearly to [0, maxPts] with the benchmark median at the midpoint:
//        pts = maxPts * clamp(0.5 + rz / (2K), 0, 1)
// so the median stock (rz=0) is neutral (maxPts/2), magnitude is preserved
// (+150% still beats +50%), and extreme inflated-FV moonshots saturate gently.
//
// The benchmark (median_slog, robust_sigma) is computed over the universe with
// micro-caps EXCLUDED (their analyst FVs are the noisiest) and null upsides
// excluded, so the anchor reflects investable names. This file is PURE: no I/O,
// no imports — the caller extracts {upside_pct, market_cap_inr} from whatever
// stock shape it has (deep `overview.*` or the slim universe entry).

// ₹500 crore in raw rupees (market_cap_inr is stored in raw INR, verified:
// RELIANCE = 18,263,514,259,211). Sub-floor names are dropped from the anchor.
export const DEFAULT_MICRO_CAP_FLOOR_INR = 500 * 1e7;

// Number of robust-sigmas spanning the full 0..maxPts range. K=2.5 means a name
// 2.5 robust-sigmas above the benchmark median maxes out the points. Tunable —
// intended to be set by forward-return evidence later, not hand-fixed.
export const DEFAULT_K = 2.5;

// Points this block owns (mirrors the legacy band's 12).
export const MAX_PTS = 12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Signed natural log: compresses large magnitudes while preserving sign and
// monotonicity. Returns null for non-finite input.
export function signedLog(u) {
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  return Math.sign(u) * Math.log1p(Math.abs(u));
}

function medianOf(values) {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Build the relative anchor from a list of rows. Each row supplies an upside and
// a market cap under the configured keys (default: the universe-entry / overview
// field names). Rows with a non-finite upside, or a market cap below the
// micro-cap floor, are EXCLUDED from the moment estimation so they cannot
// contaminate the median/MAD.
export function buildFvUpsideBenchmark(rows, opts = {}) {
  const floor = opts.microCapFloorInr ?? DEFAULT_MICRO_CAP_FLOOR_INR;
  const upsideKey = opts.upsideKey ?? "upside_pct";
  const marketCapKey = opts.marketCapKey ?? "market_cap_inr";

  const slogs = [];
  for (const row of rows || []) {
    const u = row?.[upsideKey];
    const mc = row?.[marketCapKey];
    if (typeof u !== "number" || !Number.isFinite(u)) continue;
    if (typeof mc !== "number" || !Number.isFinite(mc) || mc < floor) continue;
    slogs.push(signedLog(u));
  }

  const n = slogs.length;
  if (n === 0) {
    return { median_slog: 0, mad: 0, robust_sigma: 0, n: 0, micro_cap_floor_inr: floor, degenerate: true };
  }
  const median_slog = medianOf(slogs);
  const mad = medianOf(slogs.map((s) => Math.abs(s - median_slog)));
  const robust_sigma = 1.4826 * mad;
  // Degenerate when the cross-section has ~no dispersion (every name equally
  // cheap) — relative scoring is meaningless, so callers fall back to neutral.
  const degenerate = !(robust_sigma > 0) || !Number.isFinite(robust_sigma);

  return { median_slog, mad, robust_sigma, n, micro_cap_floor_inr: floor, degenerate };
}

// Map one stock's upside to relative FV-upside points against the benchmark.
// Missing upside or a degenerate/absent benchmark -> neutral (maxPts/2), flagged
// imputed (identical neutral policy to the legacy band's null->6).
export function relativeFvPoints(upside, benchmark, opts = {}) {
  const K = opts.K ?? DEFAULT_K;
  const maxPts = opts.maxPts ?? MAX_PTS;
  const neutral = maxPts / 2;

  if (typeof upside !== "number" || !Number.isFinite(upside)) {
    return { pts: neutral, rz: null, imputed: true };
  }
  if (!benchmark || benchmark.degenerate || !(benchmark.robust_sigma > 0)) {
    return { pts: neutral, rz: null, imputed: true };
  }

  const rz = (signedLog(upside) - benchmark.median_slog) / benchmark.robust_sigma;
  const pts = maxPts * clamp(0.5 + rz / (2 * K), 0, 1);
  return { pts, rz, imputed: false };
}
