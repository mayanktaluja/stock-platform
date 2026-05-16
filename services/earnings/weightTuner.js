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
 *
 * P2.2 (walk-forward CV) — for time-series predictions, a random
 * train/holdout split leaks future information back into training
 * because tomorrow's earnings outcomes carry no information that
 * wasn't (in principle) knowable today. A SEBI-style backtest needs
 * rolling-origin (a.k.a. walk-forward) CV: sort events by date, bucket
 * them by fiscal quarter, then for each fold k train on quarters 1..k
 * and test on quarter k+1. The aggregated test metrics are the honest
 * out-of-sample estimate.
 *
 * `splitTrainHoldoutWalkForward` is the new default returned in the
 * tuner output. The earlier random-split implementation remains as
 * `splitTrainHoldoutRandom` for backward compatibility (and for the
 * unit tests that pin the deterministic 80/20 behaviour). The
 * historical export name `splitTrainHoldout` continues to point at the
 * random implementation so external callers don't break — the new
 * walk-forward function carries its own name and the tuner script
 * picks which one to call explicitly.
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
 *
 * IMPORTANT: this is the v1 (random) splitter. It treats every
 * resolved event as exchangeable, which leaks future information back
 * into the training set when the predictor's components themselves
 * depend on time-evolving inputs (sector regime, runup window,
 * trajectory). Prefer `splitTrainHoldoutWalkForward` for any new
 * tuning run. This function is kept exported under both its original
 * name (`splitTrainHoldout`) and the more explicit alias
 * (`splitTrainHoldoutRandom`) for backward compatibility with callers
 * and existing tests.
 */
export function splitTrainHoldoutRandom(rows, holdoutFrac = 0.2) {
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

// Legacy export — preserved so older callers and tests continue to
// work. Points at the random implementation.
export const splitTrainHoldout = splitTrainHoldoutRandom;

/* ──────────────── walk-forward (rolling-origin) CV ──────────────── */

/**
 * Quarterly buckets, sorted oldest→newest. The bucket key is
 * `fiscal_quarter` when available (e.g. "Q1 FY27", "Q4 FY26"),
 * otherwise a derived "YYYY-Qn" key from `event_iso_date`. Rows
 * without either field are dropped — the tuner cannot place them on
 * the timeline.
 *
 * Returns `[{ key, rows }]` in chronological order.
 */
export function bucketRowsByQuarter(rows) {
  const buckets = new Map();
  for (const r of rows || []) {
    const key = quarterKeyForRow(r);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return [...buckets.entries()]
    .map(([key, rs]) => ({ key, rows: rs }))
    .sort((a, b) => (quarterSortKey(a.key) < quarterSortKey(b.key) ? -1 : 1));
}

/**
 * Walk-forward (rolling-origin) cross-validation split.
 *
 * Buckets the rows into quarterly folds in chronological order, then
 * for each fold k = 1..N-1 returns a train set (quarters 1..k) and a
 * test set (quarter k+1). The very first quarter never appears as a
 * test set because its training set would be empty.
 *
 * Returns:
 *   {
 *     cv_method: "walk-forward",
 *     folds: [
 *       { fold_index, train_quarter_keys, test_quarter_key, train, test },
 *       ...
 *     ],
 *     quarter_keys,   // chronological quarter keys
 *     skipped_no_quarter,  // rows we couldn't place on the timeline
 *   }
 *
 * Empty buckets (e.g. the train side at fold 0) cause the fold to be
 * dropped silently — a fold with zero training rows would just echo
 * the verdict thresholds rather than test the predictor.
 */
export function splitTrainHoldoutWalkForward(rows) {
  const skipped = (rows || []).filter((r) => !quarterKeyForRow(r)).length;
  const buckets = bucketRowsByQuarter(rows);
  const quarterKeys = buckets.map((b) => b.key);

  const folds = [];
  for (let k = 0; k < buckets.length - 1; k++) {
    const train = buckets.slice(0, k + 1).flatMap((b) => b.rows);
    const test = buckets[k + 1].rows;
    // Skip degenerate folds: zero train rows would just measure the
    // verdict thresholds. (Shouldn't happen because we always include
    // at least one bucket on the train side, but defensive.)
    if (train.length === 0 || test.length === 0) continue;
    folds.push({
      fold_index: folds.length,
      train_quarter_keys: buckets.slice(0, k + 1).map((b) => b.key),
      test_quarter_key: buckets[k + 1].key,
      train,
      test,
    });
  }

  return {
    cv_method: "walk-forward",
    folds,
    quarter_keys: quarterKeys,
    skipped_no_quarter: skipped,
  };
}

/**
 * Aggregate the per-fold test metrics into a single hit-rate + Brier
 * by summing hits/sample-sizes across folds (so a fold with 50 test
 * rows counts 5x a fold with 10).
 *
 * Each fold result is the output of `evaluateConfig(fold.test, ...)`.
 */
export function aggregateWalkForwardFolds(foldResults) {
  let totalN = 0;
  let totalHits = 0;
  let weightedBrierSum = 0;
  for (const fr of foldResults || []) {
    const n = fr?.n ?? 0;
    const hr = fr?.hit_rate_pct;
    const br = fr?.brier;
    if (!n) continue;
    totalN += n;
    if (hr != null) totalHits += (hr / 100) * n;
    if (br != null) weightedBrierSum += br * n;
  }
  return {
    aggregated_n: totalN,
    aggregated_hit_rate_pct: totalN ? Math.round((totalHits / totalN) * 1000) / 10 : null,
    aggregated_brier: totalN ? Math.round((weightedBrierSum / totalN) * 1000) / 1000 : null,
  };
}

/**
 * Run a walk-forward CV against one multiplier config end-to-end:
 * bucket → for each fold evaluate the test set under `multipliers` →
 * aggregate. Returns:
 *
 *   {
 *     cv_method: "walk-forward",
 *     folds: [{ fold_index, train_quarter_keys, test_quarter_key,
 *               train_n, test_n, test_result }],
 *     aggregated_n,
 *     aggregated_hit_rate_pct,
 *     aggregated_brier,
 *     quarter_keys,
 *     skipped_no_quarter,
 *   }
 *
 * The train_n / test_n fields are kept (not the raw rows) so the
 * output is JSON-serialisable.
 */
export function walkForwardEvaluate(rows, multipliers) {
  const split = splitTrainHoldoutWalkForward(rows);
  const foldResults = split.folds.map((fold) => {
    const testResult = evaluateConfig(fold.test, multipliers);
    return {
      fold_index: fold.fold_index,
      train_quarter_keys: fold.train_quarter_keys,
      test_quarter_key: fold.test_quarter_key,
      train_n: fold.train.length,
      test_n: fold.test.length,
      test_result: testResult,
    };
  });
  const agg = aggregateWalkForwardFolds(foldResults.map((f) => f.test_result));
  return {
    cv_method: "walk-forward",
    folds: foldResults,
    quarter_keys: split.quarter_keys,
    skipped_no_quarter: split.skipped_no_quarter,
    ...agg,
  };
}

/* ──────────────── quarter-key parsing helpers ──────────────────── */

/**
 * Extract a quarter key from a row. Prefer the explicit
 * `fiscal_quarter` (e.g. "Q1 FY27") because that's the canonical
 * source of truth; fall back to deriving "YYYY-Qn" from
 * `event_iso_date` if absent.
 */
function quarterKeyForRow(r) {
  if (!r) return null;
  const fq = typeof r.fiscal_quarter === "string" ? r.fiscal_quarter.trim() : "";
  if (fq) return fq;
  const iso = typeof r.event_iso_date === "string" ? r.event_iso_date : "";
  const m = iso.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const qn = Math.floor((month - 1) / 3) + 1; // 1..4
  return `CY${year}-Q${qn}`;
}

/**
 * Sort key for quarter labels so "Q4 FY26" sorts before "Q1 FY27".
 * Indian fiscal-year convention: Q1 = Apr-Jun, Q2 = Jul-Sep,
 * Q3 = Oct-Dec, Q4 = Jan-Mar of FY label's calendar year.
 * Returns a string that lexicographically orders correctly.
 */
function quarterSortKey(key) {
  // FYxx-Qn style: "Q1 FY27" → calendar quarter = 2026-Q2 (Apr-Jun 2026)
  let m = String(key).match(/^Q([1-4])\s*FY(\d{2,4})$/i);
  if (m) {
    const qn = parseInt(m[1], 10);
    let fy = parseInt(m[2], 10);
    if (fy < 100) fy = 2000 + fy; // FY27 → 2027
    // FYxx means: Apr (xx-1) … Mar xx in calendar terms.
    // Q1 of FYxx = (xx-1) Apr-Jun, Q4 of FYxx = xx Jan-Mar.
    const calendarYear = qn === 4 ? fy : fy - 1;
    const calendarQuarter =
      qn === 1 ? 2 : qn === 2 ? 3 : qn === 3 ? 4 : 1;
    return `${calendarYear}-Q${calendarQuarter}`;
  }
  // Already a CY key
  m = String(key).match(/^CY?(\d{4})-Q([1-4])$/);
  if (m) return `${m[1]}-Q${m[2]}`;
  // Unknown — sort lexicographically as a last resort.
  return String(key);
}
