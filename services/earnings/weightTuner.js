/**
 * weightTuner.js
 *
 * Pure sweep logic for data-tuning the earnings predictor's component
 * weights once enough resolved actuals have accumulated.
 *
 * Approach — MULTIPLIER sweep, not a predictor rewrite. Each archived
 * resolved prediction carries its per-component `score_breakdown`. The
 * tuner re-scores those rows under candidate multiplier configs
 * (config = { component: factor }), re-derives the verdict, and scores
 * the result against the known `actual_verdict`. This needs zero
 * changes to earningsPredictor.js — it works entirely off archived
 * data, so there is no regression risk in the tuner itself.
 *
 * It is a first-order approximation: a component that was clamped at
 * its weight bound won't rescale perfectly. That's fine — the tuner's
 * job is to surface DIRECTIONS ("up-weight trajectory, down-weight
 * runup"), which a human then applies to the predictor by hand. The
 * tuner recommends; it never edits the predictor.
 *
 * Validation discipline (post-adversarial-review): the gate requires
 *   - >= 80 resolved actuals (small samples overfit)
 *   - across >= 2 fiscal quarters (one quarter is a regime, not a model)
 *   - >= 5 sectors with >= 10 resolved events each (no IT/FMCG dominance)
 * and the sweep is run on an 80% train split with a 20% held-out check.
 */

import crypto from "node:crypto";

// The component keys the tuner sweeps — the real predictor components,
// excluding `raw_sum` and the v1 aliases (sws_quality / fv_upside).
export const COMPONENT_KEYS = [
  "v3_future_past",
  "v3_valuation",
  "v3_overlay",
  "runup",
  "sector_momentum",
  "trajectory",
  "last_quarter_echo",
  "announcements",
  "deal_flow",
  "llm_signal",
];

// Gate thresholds.
export const GATE = {
  MIN_RESOLVED: 80,
  MIN_QUARTERS: 2,
  MIN_SECTORS_WITH_EVENTS: 5,
  SECTOR_MIN_EVENTS: 10,
};

const CONF_CAP = 65;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* ──────────────────── row selection ─────────────────────────────── */

/**
 * Deduped resolved rows that carry a `score_breakdown` — the tuner's
 * input set. Dedup keeps one row per (symbol, event_iso_date),
 * preferring the latest snapshot.
 *
 * Note: `score_breakdown` only entered the archive row in schema v4
 * (this PR). Resolved rows archived earlier are intentionally excluded
 * — the tuner can't re-score what it can't see the component points
 * for. As post-v4 events resolve, the usable set grows naturally.
 */
export function selectResolvedForTuning(history) {
  const byKey = new Map();
  for (const day of history || []) {
    const todayIso = day.today_iso || day.filename || "";
    for (const r of day.predictions || []) {
      if (!r || !r.actual_verdict || !r.score_breakdown) continue;
      if (!r.predicted_verdict) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      const existing = byKey.get(key);
      if (!existing || todayIso >= existing._today_iso) {
        byKey.set(key, { ...r, _today_iso: todayIso });
      }
    }
  }
  return [...byKey.values()];
}

/* ──────────────────── validation gate ───────────────────────────── */

export function checkTuningGate(rows, gate = GATE) {
  const resolved = rows.length;
  const quarters = new Set(rows.map((r) => r.fiscal_quarter).filter(Boolean));
  const bySector = {};
  for (const r of rows) {
    const s = r.sector || "Unknown";
    bySector[s] = (bySector[s] || 0) + 1;
  }
  const sectorsWithMin = Object.values(bySector).filter((n) => n >= gate.SECTOR_MIN_EVENTS).length;

  const met =
    resolved >= gate.MIN_RESOLVED &&
    quarters.size >= gate.MIN_QUARTERS &&
    sectorsWithMin >= gate.MIN_SECTORS_WITH_EVENTS;

  return {
    met,
    resolved_count: resolved,
    distinct_quarters: quarters.size,
    sectors_with_min_events: sectorsWithMin,
    detail: {
      need_resolved: gate.MIN_RESOLVED,
      need_quarters: gate.MIN_QUARTERS,
      need_sectors_with_events: gate.MIN_SECTORS_WITH_EVENTS,
      sector_min_events: gate.SECTOR_MIN_EVENTS,
      quarters: [...quarters].sort(),
      by_sector: bySector,
    },
  };
}

/* ──────────────────── re-scoring under a config ─────────────────── */

function verdictFromScore(score) {
  if (score >= 65) return "BEAT";
  if (score < 35) return "MISS";
  return "INLINE";
}

// Mirror of earningsPredictor.js's confidence formula so a re-scored
// row gets a consistent confidence for the Brier calculation.
function confidenceFromScore(score, verdict) {
  let conf;
  if (verdict === "BEAT") conf = 50 + (score - 65) * 1.0;
  else if (verdict === "MISS") conf = 50 + (35 - score) * 1.0;
  else conf = 50 + (15 - Math.abs(score - 50)) * 0.6;
  return clamp(Math.round(conf), 50, CONF_CAP);
}

/**
 * Re-score one archived prediction under a multiplier config.
 * `multipliers` is { component: factor }; an absent component is ×1.
 */
export function rescoreUnderMultipliers(scoreBreakdown, multipliers = {}) {
  let raw = 0;
  for (const k of COMPONENT_KEYS) {
    const pts = num(scoreBreakdown && scoreBreakdown[k]);
    if (pts == null) continue;
    const factor = num(multipliers[k]);
    raw += pts * (factor == null ? 1 : factor);
  }
  const score_100 = clamp(Math.round((50 + raw) * 10) / 10, 0, 100);
  const verdict = verdictFromScore(score_100);
  return { score_100, verdict, confidence_pct: confidenceFromScore(score_100, verdict) };
}

/* ──────────────────── config evaluation ─────────────────────────── */

/**
 * Evaluate one multiplier config against a set of resolved rows:
 * overall hit-rate, Brier, and a per-sector hit-rate breakdown.
 */
export function evaluateConfig(rows, multipliers) {
  let hits = 0, n = 0, brierSum = 0;
  const bySector = {};
  for (const r of rows) {
    const { verdict, confidence_pct } = rescoreUnderMultipliers(r.score_breakdown, multipliers);
    const hit = verdict === r.actual_verdict;
    n += 1;
    if (hit) hits += 1;
    brierSum += Math.pow(confidence_pct / 100 - (hit ? 1 : 0), 2);
    const s = r.sector || "Unknown";
    if (!bySector[s]) bySector[s] = { hits: 0, n: 0 };
    bySector[s].n += 1;
    if (hit) bySector[s].hits += 1;
  }
  const by_sector = {};
  for (const [s, v] of Object.entries(bySector)) {
    by_sector[s] = { n: v.n, hit_rate_pct: v.n ? Math.round((v.hits / v.n) * 1000) / 10 : null };
  }
  return {
    n,
    hit_rate_pct: n ? Math.round((hits / n) * 1000) / 10 : null,
    brier: n ? Math.round((brierSum / n) * 1000) / 1000 : null,
    by_sector,
  };
}

/* ──────────────────── candidate configs ─────────────────────────── */

/**
 * Curated hypothesis configs + a one-component-at-a-time coordinate
 * sweep. Bounded (~50 configs) and interpretable — every config has a
 * name so the report reads as a set of hypotheses, not a black box.
 */
export function buildCandidateConfigs() {
  const configs = [{ name: "baseline", multipliers: {} }];

  // Hypothesis configs — the directional shifts the plan anticipated.
  configs.push(
    { name: "v3_heavy", multipliers: { v3_future_past: 1.25, runup: 0.55, sector_momentum: 0.5 } },
    { name: "trajectory_heavy", multipliers: { trajectory: 1.25, runup: 0.6 } },
    { name: "runup_light", multipliers: { runup: 0.5, sector_momentum: 0.5 } },
    { name: "llm_heavy", multipliers: { llm_signal: 1.5 } },
    { name: "overlay_strict", multipliers: { v3_overlay: 1.3 } },
    {
      name: "plan_v3_shift",
      multipliers: {
        v3_future_past: 1.22, v3_valuation: 0.75, v3_overlay: 1.2,
        runup: 0.53, sector_momentum: 0.5, trajectory: 1.2, last_quarter_echo: 0.8,
      },
    },
  );

  // Coordinate sweep — vary one component at a time.
  for (const k of COMPONENT_KEYS) {
    for (const f of [0.6, 0.8, 1.2, 1.4]) {
      configs.push({ name: `${k}_x${f}`, multipliers: { [k]: f } });
    }
  }
  return configs;
}

/* ──────────────────── ranking + split ───────────────────────────── */

export function rankConfigs(rows, configs) {
  return configs
    .map((c) => ({ ...c, result: evaluateConfig(rows, c.multipliers) }))
    .sort((a, b) => {
      const hr = (b.result.hit_rate_pct ?? 0) - (a.result.hit_rate_pct ?? 0);
      if (hr !== 0) return hr;
      return (a.result.brier ?? 1) - (b.result.brier ?? 1); // lower Brier wins ties
    });
}

/**
 * Deterministic 80/20 train/holdout split — sorts by a hash of
 * (symbol|event_iso_date) so the split is stable across runs and
 * independent of archive file order.
 */
export function splitTrainHoldout(rows, holdoutFrac = 0.2) {
  const keyed = rows
    .map((r) => ({
      r,
      h: crypto.createHash("sha1").update(`${r.symbol}|${r.event_iso_date}`).digest("hex"),
    }))
    .sort((a, b) => (a.h < b.h ? -1 : 1));
  const holdoutN = Math.floor(keyed.length * holdoutFrac);
  return {
    holdout: keyed.slice(0, holdoutN).map((x) => x.r),
    train: keyed.slice(holdoutN).map((x) => x.r),
  };
}
