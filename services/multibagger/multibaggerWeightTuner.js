// Multibagger weight tuner — multiplier sweep over the scorer's
// component weights, ranked by ≥2x hit-rate on resolved rows. Mirrors
// services/earnings/weightTuner.js: NEVER edits multibaggerScorer.js;
// it recommends directional weight shifts a human applies by hand.
//
// Gated identically to the backtest — refuses to recommend until the
// resolved-row count + window + sector-coverage thresholds clear. Until
// then it writes gate_met: false (expected for months — the forward
// archive only just started accumulating).

const COMPONENT_KEYS = [
  "mcap", "v3_future", "v3_valuation", "fv_upside", "inflection",
  "sector_tailwind", "momentum", "liquidity_bonus", "health", "forward_growth",
];

const MULTIPLIERS = [0.5, 0.75, 1.0, 1.25, 1.5];

const GATE = Object.freeze({
  MIN_RESOLVED: 80,
  MIN_WINDOWS: 2,
  MIN_SECTORS_WITH_EVENTS: 5,
  SECTOR_MIN_EVENTS: 10,
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function rescore(row, weights) {
  const b = row.breakdown || {};
  let score = 0;
  for (const key of COMPONENT_KEYS) {
    const raw = isFiniteNumber(b[key]) ? b[key] : 0;
    const mult = weights[key] ?? 1.0;
    score += raw * mult;
  }
  // Penalties carried through unchanged
  score += (b.penalty_surveillance || 0) + (b.penalty_data_completeness || 0) + (b.penalty_miss_streak || 0);
  return Math.max(0, Math.min(100, score));
}

function hitRate2x(rows, weights) {
  if (!rows.length) return null;
  // Take top quartile by re-scored value, measure their ≥2x realization.
  const ranked = rows
    .map((r) => ({ ...r, _score: rescore(r, weights), _mult: r.forward_365d_price_inr / r.entry_price_inr }))
    .sort((a, b) => b._score - a._score);
  const topN = ranked.slice(0, Math.max(1, Math.floor(ranked.length * 0.25)));
  const hits = topN.filter((r) => r._mult >= 2).length;
  return Number((hits / topN.length * 100).toFixed(1));
}

export function checkTuningGate(resolved) {
  const rows = (Array.isArray(resolved) ? resolved : []).filter((r) =>
    r && isFiniteNumber(r.entry_price_inr) && r.entry_price_inr > 0 &&
    isFiniteNumber(r.forward_365d_price_inr) && r.breakdown
  );
  const reasons = [];
  if (rows.length < GATE.MIN_RESOLVED) reasons.push(`resolved_${rows.length}_<_${GATE.MIN_RESOLVED}`);
  const windows = new Set(rows.map((r) => r.snapshot_iso));
  if (windows.size < GATE.MIN_WINDOWS) reasons.push(`windows_${windows.size}_<_${GATE.MIN_WINDOWS}`);
  const sectorCounts = {};
  for (const r of rows) {
    const s = r.sector || "Unknown";
    sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  const sectorsWithMin = Object.values(sectorCounts).filter((n) => n >= GATE.SECTOR_MIN_EVENTS).length;
  if (sectorsWithMin < GATE.MIN_SECTORS_WITH_EVENTS) {
    reasons.push(`sectors_with_${GATE.SECTOR_MIN_EVENTS}+_events_${sectorsWithMin}_<_${GATE.MIN_SECTORS_WITH_EVENTS}`);
  }
  return { gate_met: reasons.length === 0, blocking_reasons: reasons, gate_spec: GATE, eligible_rows: rows.length };
}

export function tuneWeights(resolved) {
  const gate = checkTuningGate(resolved);
  const rows = (Array.isArray(resolved) ? resolved : []).filter((r) =>
    r && isFiniteNumber(r.entry_price_inr) && r.entry_price_inr > 0 &&
    isFiniteNumber(r.forward_365d_price_inr) && r.breakdown
  );

  const baseline = {};
  for (const k of COMPONENT_KEYS) baseline[k] = 1.0;
  const baselineHit = hitRate2x(rows, baseline);

  const candidates = [{ label: "baseline", weights: baseline, hit_rate_2x_pct: baselineHit }];

  // Single-component coordinate sweep
  for (const key of COMPONENT_KEYS) {
    for (const m of MULTIPLIERS) {
      if (m === 1.0) continue;
      const w = { ...baseline, [key]: m };
      candidates.push({ label: `${key}×${m}`, weights: w, hit_rate_2x_pct: hitRate2x(rows, w) });
    }
  }

  candidates.sort((a, b) => (b.hit_rate_2x_pct ?? -1) - (a.hit_rate_2x_pct ?? -1));

  return {
    schema_version: "multibagger-weight-tuning-v1",
    gate_met: gate.gate_met,
    blocking_reasons: gate.blocking_reasons,
    baseline_hit_rate_2x_pct: baselineHit,
    top_candidates: candidates.slice(0, 10),
    recommendation: gate.gate_met
      ? `Best config "${candidates[0].label}" lifts ≥2x hit-rate to ${candidates[0].hit_rate_2x_pct}% (baseline ${baselineHit}%). Apply directionally by hand.`
      : `Gate not met (${gate.blocking_reasons.join(", ")}) — no recommendation. This is expected until the forward archive accrues.`,
  };
}

export { COMPONENT_KEYS, MULTIPLIERS, GATE };
