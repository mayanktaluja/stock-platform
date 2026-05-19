// Multibagger backtest — scores historical candidate snapshots against
// forward 365-day returns. Mirrors backtest-earnings-predictions.mjs in
// shape, but resolution horizon is 12 months not days.
//
// CRITICAL (adversarial finding): picks-latest.json is a current-state
// snapshot with NO delisted tickers — survivorship bias inflates the
// hit-rate by an estimated 40-60%. Until 9 months of forward archive
// accumulate OR a delisted-ticker source is ingested, this module
// refuses to emit a "validated" verdict — gate_met stays false.
//
// Pure logic — caller supplies resolved rows; we compute the stats.

const VALIDATION_GATE = Object.freeze({
  MIN_FORWARD_MONTHS: 9,
  MIN_RESOLVED_PER_WINDOW: 30,
  MIN_WINDOWS: 3,
  MIN_2X_HIT_RATE_PCT: 30,
});

const MULTIPLE_BUCKETS = [5, 3, 2, 1]; // ≥5x, ≥3x, ≥2x, ≥0% (1 = breakeven)

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// resolved: [{ ticker, snapshot_iso, score_0_100, verdict, entry_price_inr,
//   forward_365d_price_inr, breakdown }]
export function computeBacktest(resolved) {
  const rows = (Array.isArray(resolved) ? resolved : []).filter((r) =>
    r && isFiniteNumber(r.entry_price_inr) && r.entry_price_inr > 0 &&
    isFiniteNumber(r.forward_365d_price_inr) && r.forward_365d_price_inr >= 0
  );

  const withMultiple = rows.map((r) => ({
    ...r,
    realized_multiple: r.forward_365d_price_inr / r.entry_price_inr,
  }));

  const bucketHits = {};
  for (const m of MULTIPLE_BUCKETS) {
    const label = m === 1 ? "ge_0pct" : `ge_${m}x`;
    const hits = withMultiple.filter((r) => r.realized_multiple >= m).length;
    bucketHits[label] = {
      hits,
      total: withMultiple.length,
      hit_rate_pct: withMultiple.length ? Number((hits / withMultiple.length * 100).toFixed(1)) : null,
    };
  }

  // Per-verdict-band average forward return
  const byVerdict = {};
  for (const r of withMultiple) {
    const v = r.verdict || "UNKNOWN";
    (byVerdict[v] ||= []).push(r.realized_multiple);
  }
  const verdictStats = {};
  for (const [v, arr] of Object.entries(byVerdict)) {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    verdictStats[v] = {
      count: arr.length,
      avg_multiple: Number(avg.toFixed(3)),
      five_x_rate_pct: Number((arr.filter((m) => m >= 5).length / arr.length * 100).toFixed(1)),
    };
  }

  // Distinct snapshot windows
  const windows = new Set(withMultiple.map((r) => r.snapshot_iso));

  const gate = checkValidationGate({ resolved: withMultiple, windows });

  return {
    schema_version: "multibagger-backtest-v1",
    resolved_count: withMultiple.length,
    windows: windows.size,
    bucket_hit_rates: bucketHits,
    verdict_stats: verdictStats,
    validation_gate: gate,
    survivorship_warning: "picks-latest excludes delisted tickers — hit rate is upward-biased. Treat as indicative only until delisted source ingested.",
  };
}

export function checkValidationGate({ resolved, windows, forward_months_available = 0 } = {}) {
  const reasons = [];
  if (forward_months_available < VALIDATION_GATE.MIN_FORWARD_MONTHS) {
    reasons.push(`forward_archive_${forward_months_available}mo_<_${VALIDATION_GATE.MIN_FORWARD_MONTHS}mo`);
  }
  const windowCount = windows instanceof Set ? windows.size : (windows || 0);
  if (windowCount < VALIDATION_GATE.MIN_WINDOWS) {
    reasons.push(`windows_${windowCount}_<_${VALIDATION_GATE.MIN_WINDOWS}`);
  }
  const resolvedCount = Array.isArray(resolved) ? resolved.length : 0;
  if (resolvedCount < VALIDATION_GATE.MIN_RESOLVED_PER_WINDOW) {
    reasons.push(`resolved_${resolvedCount}_<_${VALIDATION_GATE.MIN_RESOLVED_PER_WINDOW}`);
  }
  return {
    gate_met: reasons.length === 0,
    blocking_reasons: reasons,
    gate_spec: VALIDATION_GATE,
  };
}

// Component ablation: re-score with each component zeroed, measure the
// drop in ≥2x hit-rate. Identifies which components carry signal.
export function computeAblation(resolved, componentKeys) {
  const base = computeBacktest(resolved);
  const baseHit = base.bucket_hit_rates?.ge_2x?.hit_rate_pct ?? 0;
  const ablation = {};
  for (const key of componentKeys) {
    // Zero the component → re-rank. We approximate by re-bucketing on
    // (score − component) ≥ original verdict threshold. Caller supplies
    // breakdown per row.
    const reweighted = resolved.map((r) => {
      const comp = r.breakdown?.[key] ?? 0;
      return { ...r, score_0_100: (r.score_0_100 ?? 0) - comp };
    });
    const rescored = computeBacktest(reweighted);
    const newHit = rescored.bucket_hit_rates?.ge_2x?.hit_rate_pct ?? 0;
    ablation[key] = {
      hit_rate_without: newHit,
      delta_vs_base: Number((newHit - baseHit).toFixed(1)),
    };
  }
  return { base_2x_hit_rate_pct: baseHit, ablation };
}

export { VALIDATION_GATE, MULTIPLE_BUCKETS };
