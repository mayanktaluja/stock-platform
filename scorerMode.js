/**
 * scorerMode.js — feature-flagged selection between V1 and V2 scorers.
 *
 * Phase 4 of the V2 rollout centralises the "which scorer is authoritative"
 * decision here, so every user-facing endpoint reads from the same switch.
 * The switch is controlled by the SCORER_MODE env var:
 *
 *   SCORER_MODE=v1          — V1 only. No V2 computation. Rollback mode.
 *   SCORER_MODE=v2-shadow   — V1 authoritative, V2 attached as shadow.
 *   SCORER_MODE=v2-primary  — V2 authoritative, V1 attached as legacy.   (default)
 *
 * Default is `v2-primary` (Phase 3 backtest: V2 beats V1 by +10.6pp XIRR).
 * Use SCORER_MODE=v1 as an escape hatch if a V2 regression lands.
 *
 * Response payload shape:
 *   { primary, legacy, shadow, mode }
 *
 *     primary — the authoritative scorer's result (what the client should
 *               treat as "the verdict"). Never null unless the primary
 *               scorer threw AND no fallback produced a result.
 *     legacy  — non-null only under v2-primary. Carries V1's score/verdict
 *               so the UI can show a "legacy scorer said X" disclosure
 *               during the transition window (SEBI Reg 15(2) transparency).
 *     shadow  — non-null only under v2-shadow. Carries V2's score/verdict
 *               without making it authoritative — used for the Snowflake
 *               hexagon and A/B diffing.
 *     mode    — the effective mode string. May be "v2-primary-fallback-v1"
 *               if v2-primary was requested but V2 failed and V1 served
 *               as fallback — the UI should surface this clearly.
 *
 * Fail-safe behaviour:
 *   Under v2-primary, if V2 throws we fall back to V1 rather than returning
 *   no verdict. A silent V1 fallback is strictly better than a broken
 *   detail page — and we log a warning so operators see the regression.
 */

import { scoreFundamentals } from "./fundamentals.js";
import { scoreFundamentalsV2 } from "./fundamentalsV2.js";

const VALID_MODES = new Set(["v1", "v2-shadow", "v2-primary"]);
const RAW_MODE = process.env.SCORER_MODE || "v2-primary";
export const SCORER_MODE = VALID_MODES.has(RAW_MODE) ? RAW_MODE : "v2-primary";

if (!VALID_MODES.has(RAW_MODE)) {
  console.warn(
    `[scorerMode] Unknown SCORER_MODE="${RAW_MODE}". Falling back to "v2-shadow".`
  );
}

// Single log line at module load so operators can confirm the deployed mode.
console.log(`[scorerMode] active: ${SCORER_MODE}`);

export function isV1Only() {
  return SCORER_MODE === "v1";
}

export function isV2Primary() {
  return SCORER_MODE === "v2-primary";
}

export function isV2Shadow() {
  return SCORER_MODE === "v2-shadow";
}

/**
 * Score a snapshot for an API response, honouring SCORER_MODE.
 *
 * @param {object} snap - The fundamentals snapshot (from fundamentals.json).
 * @param {number|null} [dma200=null] - 200-day moving average, passed to V1
 *        only. V2 does not use DMA. Optional.
 * @param {object} [opts]
 * @param {string} [opts.symbol] - For log context if a scorer throws.
 * @returns {{primary: object|null, legacy: object|null, shadow: object|null, mode: string}}
 */
export function scoreForResponse(snap, dma200 = null, opts = {}) {
  const symbol = opts.symbol || snap?.symbol || "";

  if (!snap) {
    return { primary: null, legacy: null, shadow: null, mode: SCORER_MODE };
  }

  // ── v1 mode: skip V2 entirely. Fastest path. ──
  if (SCORER_MODE === "v1") {
    let v1 = null;
    try {
      v1 = scoreFundamentals(snap, dma200);
    } catch (err) {
      console.warn(`[scorerMode v1] ${symbol} failed: ${err.message}`);
    }
    return { primary: v1, legacy: null, shadow: null, mode: SCORER_MODE };
  }

  // ── shadow or primary: compute both; pick which is authoritative below. ──
  let v1 = null;
  let v2 = null;

  try {
    v1 = scoreFundamentals(snap, dma200);
  } catch (err) {
    console.warn(`[scorerMode v1] ${symbol} failed: ${err.message}`);
  }
  try {
    v2 = scoreFundamentalsV2(snap);
  } catch (err) {
    console.warn(`[scorerMode v2] ${symbol} failed: ${err.message}`);
  }

  if (SCORER_MODE === "v2-primary") {
    // V2 authoritative; V1 is legacy.
    // Fail-safe: if V2 returned null but V1 didn't, serve V1 as primary
    // with a mode tag so the UI can show a "temporary fallback" warning.
    if (v2 == null && v1 != null) {
      return {
        primary: v1,
        legacy: null,
        shadow: null,
        mode: "v2-primary-fallback-v1",
      };
    }
    return { primary: v2, legacy: v1, shadow: null, mode: SCORER_MODE };
  }

  // SCORER_MODE === "v2-shadow": V1 authoritative, V2 alongside.
  return { primary: v1, legacy: null, shadow: v2, mode: SCORER_MODE };
}

/**
 * Lightweight scorer payload for scan responses (strips pillar detail to
 * keep the row-per-stock payload small). Used inside the scan endpoint
 * when attaching legacy/shadow info per row.
 */
export function compactScorerInfo(result) {
  if (!result) return null;
  return {
    score: result.score ?? null,
    verdict: result.verdict ?? null,
    scorerVersion: result.scorerVersion ?? null,
  };
}
