/**
 * Historical Macro Regime Classifier
 *
 * Labels each date with a regime (RISK_OFF / NEUTRAL / RISK_ON) based on
 * observable Nifty 50 behavior — no hand-labeling, no LLM, no
 * forward-looking data. Pure function of the Nifty price history that
 * was available at the scan date.
 *
 * Uses three signals observed at time T:
 *   1. 20-day Nifty return (short-term trend)
 *   2. 60-day Nifty return (medium-term trend — filters noise)
 *   3. 20-day realized volatility vs 120-day baseline (stress indicator)
 *
 * Decision logic (simple and defensible):
 *   RISK_OFF if any of:
 *     • 20-day return ≤ −5% AND vol ratio > 1.5
 *     • 60-day return ≤ −10%
 *     • 20-day return ≤ −8% (catastrophic short-term drop)
 *   RISK_ON if all of:
 *     • 20-day return ≥ +3%
 *     • 60-day return ≥ +5%
 *     • vol ratio < 1.2 (calm)
 *   NEUTRAL otherwise.
 *
 * Why these thresholds: back-checked against 2023-2026 Nifty. The
 * thresholds identify the Feb 2025 correction, Mar 2023 banking stress,
 * Q1 2026 market crash correctly as RISK_OFF, and 2024 bull run as
 * RISK_ON. No look-ahead; everything is computed from bars ≤ T.
 */

/**
 * @param {Array<{date: Date, close: number}>} niftyBars - ascending by date
 * @param {Date|string} asOfDate
 * @returns {{ regime: "RISK_OFF"|"NEUTRAL"|"RISK_ON", metrics: object }}
 */
export function classifyRegime(niftyBars, asOfDate) {
  const asOf = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const cutoff = new Date(asOf.getTime());
  cutoff.setHours(23, 59, 59, 999);

  // Filter bars up to (and including) asOfDate
  const bars = niftyBars.filter((b) => b.date <= cutoff);
  if (bars.length < 120) {
    return { regime: "NEUTRAL", metrics: { reason: "insufficient_history" } };
  }

  const last = bars[bars.length - 1].close;
  const t20 = bars[bars.length - 21]?.close ?? last;
  const t60 = bars[bars.length - 61]?.close ?? last;

  const ret20 = ((last - t20) / t20) * 100;
  const ret60 = ((last - t60) / t60) * 100;

  // Realized volatility: stddev of log returns over 20 days vs 120 days
  function dailyLogReturns(series) {
    const out = [];
    for (let i = 1; i < series.length; i++) {
      out.push(Math.log(series[i] / series[i - 1]));
    }
    return out;
  }
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }

  const last20Closes = bars.slice(-20).map((b) => b.close);
  const last120Closes = bars.slice(-120).map((b) => b.close);
  const vol20 = stdev(dailyLogReturns(last20Closes));
  const vol120 = stdev(dailyLogReturns(last120Closes));
  const volRatio = vol120 > 0 ? vol20 / vol120 : 1;

  // Classify
  let regime = "NEUTRAL";
  let reason = "default";

  if (ret20 <= -8) {
    regime = "RISK_OFF";
    reason = "20d_return_crash";
  } else if (ret60 <= -10) {
    regime = "RISK_OFF";
    reason = "60d_sustained_decline";
  } else if (ret20 <= -5 && volRatio > 1.5) {
    regime = "RISK_OFF";
    reason = "20d_drop_plus_vol_spike";
  } else if (ret20 >= 3 && ret60 >= 5 && volRatio < 1.2) {
    regime = "RISK_ON";
    reason = "sustained_uptrend_calm";
  }

  return {
    regime,
    metrics: {
      ret20: parseFloat(ret20.toFixed(2)),
      ret60: parseFloat(ret60.toFixed(2)),
      vol20: parseFloat((vol20 * 100).toFixed(3)),
      vol120: parseFloat((vol120 * 100).toFixed(3)),
      volRatio: parseFloat(volRatio.toFixed(2)),
      reason,
    },
  };
}

/**
 * Position-size multiplier from regime. Replaces the mock macro-delta
 * that was in Kelly-lite sizing previously.
 *
 *   RISK_OFF  → 0.50x  (half-size in adverse regimes)
 *   NEUTRAL   → 1.00x  (normal)
 *   RISK_ON   → 1.10x  (mild lean-in during calm uptrends; capped low
 *                       because we don't want to be hero in bull markets
 *                       and then get punished in the drawdown)
 */
export function regimeSizeFromLabel(label) {
  switch (label) {
    case "RISK_OFF": return 0.50;
    case "RISK_ON":  return 1.10;
    default:          return 1.00;
  }
}

/**
 * Should the scanner skip the scan entirely? Returns true only for
 * extreme RISK_OFF scenarios — a 5-10% drop month is bad but sizing
 * down may be enough. Only skip when we're in genuine crash territory.
 */
export function shouldSkipScan(regimeLabel, metrics) {
  if (regimeLabel !== "RISK_OFF") return false;
  // Skip only when 20-day drop is >12% (catastrophic crash) — don't
  // skip on normal drawdowns where reversal picks could actually work
  return (metrics?.ret20 ?? 0) <= -12;
}
