/**
 * earningsHistoryArchive.js
 *
 * Snapshot every refresh's predictions into per-day JSON files so the
 * backtest harness can later compute hit-rate, calibration, Brier
 * score, etc. once actual results land.
 *
 * Why per-day files (not append-to-one-blob):
 *   - File-system atomicity is per-write — a per-day file means a
 *     partial run or a clobbered write only affects one day.
 *   - Git diffs stay readable.
 *   - Backtest only loads the days it needs.
 *
 * Schema (per-day file):
 *   data/catalysts/earnings-history/<YYYY-MM-DD>.json
 *
 *   {
 *     schema_version: "earnings-history-v1",
 *     refresh_iso: "2026-05-09T07:30:00Z",
 *     event_count: int,
 *     predictions: [
 *       {
 *         symbol, fiscal_quarter, event_iso_date, days_until,
 *         data_quality, predictor_version, playbook_version,
 *         predicted_verdict, confidence_pct, score_100,
 *         price_at_snapshot_inr, runup_signal,
 *         actual_verdict: null,         // populated post-event by ingester
 *         actual_guidance_tone: null,   // populated post-event by ingester
 *         actual_t1_close_inr: null,
 *         actual_t1_open_gap_pct: null,
 *         resolved_at_iso: null,
 *         actual_source: null,          // v2 — "sws_news" | "yahoo"
 *         actual_evidence: null,        // v2 — human-readable provenance
 *         actual_revised_iso: null,     // v2 — set when a restatement flips it
 *         actual_history: [],           // v2 — prior verdicts on restatement
 *         backfilled: false,            // v2 — resolved retroactively, not live
 *         llm_signal: { ... } | null,   // v3 — predictor component 9 provenance
 *         score_breakdown: { ... },     // v4 — per-component points (weight tuner)
 *       }
 *     ]
 *   }
 *
 * The post-event ingester lives in services/earnings/actualsIngester.js,
 * driven by scripts/resolve-earnings-actuals.mjs (SWS news brief primary,
 * Yahoo earningsHistory fallback). It updates the `actual_*` fields
 * in-place. The 60-day SEBI lag means Q4 FY26 results land through
 * ~mid-June 2026.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const HISTORY_SCHEMA_VERSION = "earnings-history-v4";

function isoToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Take a snapshot of every prediction in the calendar and write it to
 * today's history file. Idempotent: re-running over the same day
 * overwrites the file with the latest predictions, preserving any
 * `actual_*` fields that were already filled in for prior events.
 *
 * Returns: { path, event_count, preserved_actuals }
 */
export function archivePredictions(events, opts = {}) {
  const todayIso = opts.todayIso || isoToday();
  const filePath = path.join(HISTORY_DIR, `${todayIso}.json`);

  // Load existing so we can preserve actuals already populated.
  let existingByKey = new Map();
  if (fs.existsSync(filePath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const r of prior.predictions || []) {
        const key = `${r.symbol}|${r.event_iso_date}`;
        existingByKey.set(key, r);
      }
    } catch {
      // Bad file — start fresh.
    }
  }

  let preservedActuals = 0;
  const predictions = [];
  for (const e of events || []) {
    if (!e || !e.symbol) continue;
    const key = `${e.symbol}|${e.event_iso_date}`;
    const prior = existingByKey.get(key);

    const row = {
      symbol: e.symbol,
      fiscal_quarter: e.fiscal_quarter || null,
      event_iso_date: e.event_iso_date,
      days_until: num(e.days_until),
      data_quality: e.signals?.data_quality || null,
      predictor_version: e.prediction?.predictor_version || null,
      playbook_version: e.playbook?.version || null,
      predicted_verdict: e.prediction?.verdict || null,
      confidence_pct: num(e.prediction?.confidence_pct),
      score_100: num(e.prediction?.score_100),
      price_at_snapshot_inr: num(e.signals?.sws_upcoming_earnings?.current_price_inr),
      runup_signal: e.signals?.momentum?.pre_runup_signal || null,
      sector: e.signals?.sector || null,
      // Actuals — preserved across refreshes once populated.
      actual_verdict: prior?.actual_verdict ?? null,
      actual_guidance_tone: prior?.actual_guidance_tone ?? null,
      actual_t1_close_inr: prior?.actual_t1_close_inr ?? null,
      actual_t1_open_gap_pct: prior?.actual_t1_open_gap_pct ?? null,
      resolved_at_iso: prior?.resolved_at_iso ?? null,
      // v2 — provenance + restatement audit trail (see actualsIngester.js).
      actual_source: prior?.actual_source ?? null,
      actual_evidence: prior?.actual_evidence ?? null,
      actual_revised_iso: prior?.actual_revised_iso ?? null,
      actual_history: prior?.actual_history ?? [],
      backfilled: prior?.backfilled ?? false,
      // v3 — LLM qualitative signal provenance (predictor component 9).
      // A prediction-time input, so it reflects THIS refresh, not the
      // prior (unlike the post-event actual_* fields above).
      llm_signal: e.signals?.llm_signal
        ? {
            bias: e.signals.llm_signal.bias,
            confidence_delta_pct: num(e.signals.llm_signal.confidence_delta_pct),
            classifier_provider: e.signals.llm_signal.classifier_provider || null,
            model_id: e.signals.llm_signal.model_id || null,
          }
        : null,
      // v4 — per-component points. The weight tuner (scripts/tune-
      // earnings-weights.mjs) re-scores resolved rows under candidate
      // weight multipliers off this block, so it must be archived.
      score_breakdown: e.prediction?.score_breakdown || null,
    };
    if (prior?.actual_verdict) preservedActuals += 1;
    predictions.push(row);
  }

  const payload = {
    schema_version: HISTORY_SCHEMA_VERSION,
    refresh_iso: new Date().toISOString(),
    today_iso: todayIso,
    event_count: predictions.length,
    predictions,
  };

  writeJsonAtomic(filePath, payload);
  return {
    path: filePath,
    event_count: predictions.length,
    preserved_actuals: preservedActuals,
  };
}

/**
 * Read all history files in the directory and return them sorted by
 * date. Used by the backtest harness.
 */
export function loadAllHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files.sort()) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf8"));
      out.push({ filename: f, ...content });
    } catch {
      // skip corrupt
    }
  }
  return out;
}

/**
 * Deduplicate predictions across daily snapshots.
 *
 * The same (symbol, event_iso_date) event is archived into every
 * refresh's file until it passes, so a naive count triple-counts it.
 * We keep ONE row per event: a resolved row always beats an unresolved
 * one (the actuals resolver writes into every snapshot, but a re-archive
 * could re-null an older file); among rows of equal resolution status
 * the freshest snapshot (latest today_iso) wins.
 *
 * Returns a flat array of rows, each tagged with `_today_iso`.
 */
export function dedupePredictions(history) {
  const byKey = new Map();
  for (const day of history || []) {
    const todayIso = day.today_iso || day.filename || "";
    for (const r of day.predictions || []) {
      if (!r || !r.symbol || !r.event_iso_date) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      const candidate = { ...r, _today_iso: todayIso };
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, candidate);
        continue;
      }
      const candResolved = !!candidate.actual_verdict;
      const exResolved = !!existing.actual_verdict;
      if (candResolved && !exResolved) byKey.set(key, candidate);
      else if (candResolved === exResolved && todayIso >= existing._today_iso) {
        byKey.set(key, candidate);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Bootstrap a 95%-CI on hit-rate for a set of resolved (predicted, actual)
 * pairs using resampling-with-replacement.
 *
 * Why this exists (P2.3 SEBI-RA roadmap): a bare `hit_rate = 0.55` over
 * n=47 resolved actuals cannot be statistically distinguished from random
 * chance (50%) — any SEBI-RA submission needs a CI alongside the point
 * estimate. The bootstrap is the right tool because hit-rate is bounded
 * (a Gaussian-approx CI like Wald can spill outside [0, 1]) and because
 * we have no closed-form for the per-bucket case where sample sizes are
 * small and skewed.
 *
 * Algorithm: draw `iterations` resamples of size n from `predictions`
 * with replacement, compute hit-rate for each, then take the empirical
 * percentiles at (1-ciLevel)/2 and 1-(1-ciLevel)/2 — the textbook
 * "percentile method" (Efron 1979). 1000 iterations is enough to
 * stabilise a 95% CI to ±~1pt; faster than O(n^2) jackknife.
 *
 * @param {Array<{predicted_verdict, actual_verdict}>} predictions  Resolved rows.
 * @param {{iterations?: number, ciLevel?: number}} [opts]
 * @returns {{hit_rate: number|null, ci_low: number|null, ci_high: number|null, sample_size: number}}
 *   Values are PROPORTIONS (0–1), NOT percentages. Callers that emit
 *   the `_pct` fields are expected to multiply by 100. For sample_size
 *   < 5 the CI is undefined and ci_low/ci_high are null (hit_rate is
 *   still computed for n ≥ 1; null only if n=0).
 */
export function bootstrapHitRateCI(predictions, opts = {}) {
  const iterations = opts.iterations ?? 1000;
  const ciLevel = opts.ciLevel ?? 0.95;

  const n = (predictions || []).length;
  if (n === 0) {
    return { hit_rate: null, ci_low: null, ci_high: null, sample_size: 0 };
  }

  // Pre-compute the per-row hit (0 or 1) so the inner loop is just an
  // array index + sum, not a string compare per iteration. With 1000
  // iterations × n rows that's the difference between ~milliseconds and
  // ~tens of milliseconds for the largest realistic samples.
  const hits = new Array(n);
  let totalHits = 0;
  for (let i = 0; i < n; i++) {
    const r = predictions[i];
    const isHit = r && r.predicted_verdict && r.actual_verdict && r.predicted_verdict === r.actual_verdict ? 1 : 0;
    hits[i] = isHit;
    totalHits += isHit;
  }
  const hitRate = totalHits / n;

  // For tiny samples the bootstrap CI is meaningless — a single resampled
  // index gives the same row repeatedly, so the percentile spread is
  // dominated by sampling-of-index noise rather than the underlying
  // accuracy. Return null and let the caller decide whether to display
  // "n too small" in the UI.
  if (n < 5) {
    return { hit_rate: hitRate, ci_low: null, ci_high: null, sample_size: n };
  }

  // All-hits or all-misses: every resample yields the same hit-rate,
  // so the CI collapses to the point estimate. Skip the loop — it's
  // not just an optimisation, it also guarantees the documented
  // identity behaviour (1.0/1.0/1.0 or 0.0/0.0/0.0) without any
  // floating-point rounding artefact.
  if (totalHits === 0 || totalHits === n) {
    return { hit_rate: hitRate, ci_low: hitRate, ci_high: hitRate, sample_size: n };
  }

  const samples = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      // Math.random is fine for bootstrap CIs — we're not doing
      // cryptography, just empirical resampling. Fast enough for
      // 1000 × n on the small samples this module operates on.
      s += hits[Math.floor(Math.random() * n)];
    }
    samples[it] = s / n;
  }
  samples.sort((a, b) => a - b);

  const alpha = (1 - ciLevel) / 2;
  const loIdx = Math.floor(alpha * iterations);
  // Use ceil-1 for the upper bound so a 95% CI at iterations=1000 reads
  // samples[974] (the 97.5th percentile cut-off) rather than spilling
  // past the array end.
  const hiIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1);

  return {
    hit_rate: hitRate,
    ci_low: samples[loIdx],
    ci_high: samples[hiIdx],
    sample_size: n,
  };
}

// Internal helper: format a bootstrap result as a `_pct` triple
// (hit_rate, ci_low, ci_high all scaled 0-100 and rounded to 1dp),
// matching the rest of this file's `_pct` convention. Returns null
// for fields that the bootstrap couldn't compute.
function ciToPct(ci) {
  return {
    hit_rate_pct: ci.hit_rate == null ? null : Math.round(ci.hit_rate * 1000) / 10,
    ci_low_pct: ci.ci_low == null ? null : Math.round(ci.ci_low * 1000) / 10,
    ci_high_pct: ci.ci_high == null ? null : Math.round(ci.ci_high * 1000) / 10,
    sample_size: ci.sample_size,
  };
}

/**
 * Compute the calibration block for one flat set of (deduped) rows.
 * Shape is stable — see computeCalibration's return docs.
 */
function calibrationFor(rows) {
  let resolved = 0, unresolved = 0, hits = 0;
  // Per-bucket / per-verdict accumulators now keep the RAW row list
  // (slim {predicted_verdict, actual_verdict} pairs) so we can pass
  // each subset to bootstrapHitRateCI separately — a per-bucket CI
  // is the whole point of P2.3. The {hits, total} counters are kept
  // alongside for the existing point-estimate path.
  const byBucket = new Map(); // "60-64" → { hits, total, rows: [] }
  const byVerdict = new Map(); // "BEAT" → { hits, total, rows: [] }
  const resolvedRows = [];     // slim list of all resolved rows
  let brierSum = 0, brierCount = 0;

  for (const r of rows || []) {
    if (!r.actual_verdict) {
      unresolved += 1;
      continue;
    }
    resolved += 1;
    const hit = r.predicted_verdict === r.actual_verdict;
    if (hit) hits += 1;
    const slim = { predicted_verdict: r.predicted_verdict, actual_verdict: r.actual_verdict };
    resolvedRows.push(slim);

    // Bucket confidence into 5pt windows.
    const c = num(r.confidence_pct);
    if (c != null) {
      const lo = Math.floor(c / 5) * 5;
      const key = `${lo}-${lo + 4}`;
      const e = byBucket.get(key) || { hits: 0, total: 0, rows: [] };
      e.total += 1;
      if (hit) e.hits += 1;
      e.rows.push(slim);
      byBucket.set(key, e);

      // Brier: (predicted_prob - actual_outcome)^2 averaged. We treat
      // confidence_pct as P(predicted_verdict); actual is 1 if hit,
      // 0 otherwise — a 3-class problem reduced to "are we right".
      const p = c / 100;
      brierSum += Math.pow(p - (hit ? 1 : 0), 2);
      brierCount += 1;
    }

    const v = r.predicted_verdict;
    if (v) {
      const e = byVerdict.get(v) || { hits: 0, total: 0, rows: [] };
      e.total += 1;
      if (hit) e.hits += 1;
      e.rows.push(slim);
      byVerdict.set(v, e);
    }
  }

  const hit_rate_overall_pct = resolved > 0 ? Math.round((hits / resolved) * 1000) / 10 : null;

  // Bootstrap CIs. The overall CI is computed once over the full
  // resolved set; per-bucket / per-verdict CIs are computed
  // independently over each subset (a small subset gets its own
  // sample_size and may legitimately return null bounds for n<5).
  const overallCI = bootstrapHitRateCI(resolvedRows);

  const bucketMap = {};
  const bucketCIMap = {};
  for (const [k, v] of byBucket) {
    bucketMap[k] = v.total > 0 ? Math.round((v.hits / v.total) * 1000) / 10 : null;
    bucketCIMap[k] = ciToPct(bootstrapHitRateCI(v.rows));
  }
  const verdictMap = {};
  const verdictCIMap = {};
  for (const [k, v] of byVerdict) {
    verdictMap[k] = v.total > 0 ? Math.round((v.hits / v.total) * 1000) / 10 : null;
    verdictCIMap[k] = ciToPct(bootstrapHitRateCI(v.rows));
  }

  const brier = brierCount > 0 ? Math.round((brierSum / brierCount) * 1000) / 1000 : null;

  // V1 cap-lift gate: ≥30 resolved AND hit-rate ≥55% in the 60–64
  // confidence bucket AND Brier < 0.20.
  const bucket6064 = byBucket.get("60-64");
  const bucketHitRate = bucket6064 ? (bucket6064.hits / Math.max(bucket6064.total, 1)) * 100 : 0;
  const enough_data_to_lift_cap =
    resolved >= 30 && bucketHitRate >= 55 && (brier ?? 1) < 0.20;

  // CI fields are ADDITIVE — every existing field above stays exactly
  // where it was, so existing callers (scripts/backtest-earnings-
  // predictions.mjs, /api/earnings/backtest, computeCalibration's
  // recursive by_predictor_version) keep working unchanged.
  return {
    resolved_count: resolved,
    unresolved_count: unresolved,
    hit_rate_overall_pct,
    // P2.3 — bootstrap CI on the overall hit-rate. `*_ci_*_pct` mirrors
    // the existing `_pct` convention; `sample_size` is equal to
    // `resolved_count` but documenting it explicitly keeps the CI block
    // self-contained for serialisation.
    hit_rate_overall_ci_low_pct: overallCI.ci_low == null ? null : Math.round(overallCI.ci_low * 1000) / 10,
    hit_rate_overall_ci_high_pct: overallCI.ci_high == null ? null : Math.round(overallCI.ci_high * 1000) / 10,
    hit_rate_overall_sample_size: overallCI.sample_size,
    hit_rate_by_confidence_bucket: bucketMap,
    // P2.3 — per-bucket CIs. Map shape is `{ bucket: { hit_rate_pct,
    // ci_low_pct, ci_high_pct, sample_size } }`. Buckets with n<5
    // get null low/high (sample_size carried regardless).
    hit_rate_by_confidence_bucket_ci: bucketCIMap,
    hit_rate_by_verdict: verdictMap,
    // P2.3 — per-predicted-verdict CIs. Same shape as
    // `_by_confidence_bucket_ci`.
    hit_rate_by_verdict_ci: verdictCIMap,
    brier_score: brier,
    enough_data_to_lift_cap,
    cap_lift_gate: {
      resolved_required: 30,
      bucket_60_64_hit_rate_required: 55,
      max_brier_required: 0.20,
      current_resolved: resolved,
      current_bucket_60_64_hit_rate: Math.round(bucketHitRate * 10) / 10,
      current_brier: brier,
    },
  };
}

/**
 * Compute calibration metrics from the populated history.
 *
 * Rows are deduped by (symbol, event_iso_date) first — the same event
 * is snapshotted into every refresh's file, so a raw count would
 * triple-count it.
 *
 * Returns the overall (deduped) block PLUS:
 *   - by_predictor_version: { "<version>": <calibration block> } — a
 *     weight change makes v(N) and v(N+1) predictions incomparable, so
 *     they are never averaged together. Each version's block carries
 *     its own bootstrap CIs.
 *   - latest_predictor_version: the highest version tag seen.
 *
 * The top-level cap-lift gate (`enough_data_to_lift_cap`, `cap_lift_gate`)
 * is computed over the LATEST predictor version's rows only, so a
 * stale-version sample can never green-light a cap lift for the
 * current model.
 *
 * P2.3 (SEBI-RA roadmap): every hit-rate field carries a 95% bootstrap
 * CI sibling — `hit_rate_overall_pct` gets `hit_rate_overall_ci_low_pct`
 * / `hit_rate_overall_ci_high_pct` / `hit_rate_overall_sample_size`;
 * `hit_rate_by_confidence_bucket` gets a parallel `_ci` map keyed by
 * the same bucket labels; `hit_rate_by_verdict` similarly. CIs at
 * sample_size < 5 are null; CIs collapse to the point estimate when
 * the sample is all-hits or all-misses (the bootstrap is degenerate
 * there by definition). Existing point-estimate fields are untouched —
 * the CI fields are strictly additive.
 */
export function computeCalibration(history) {
  const rows = dedupePredictions(history);

  // Per-predictor-version breakdown.
  const byVersionRows = new Map();
  for (const r of rows) {
    const v = r.predictor_version || "unknown";
    if (!byVersionRows.has(v)) byVersionRows.set(v, []);
    byVersionRows.get(v).push(r);
  }
  const by_predictor_version = {};
  for (const [v, vrows] of byVersionRows) by_predictor_version[v] = calibrationFor(vrows);

  // Top-level block = overall (deduped) calibration — backward compatible
  // with the backtest script and /api/earnings/backtest.
  const overall = calibrationFor(rows);

  // Gate reflects the latest predictor version only.
  const versions = [...byVersionRows.keys()].filter((v) => v !== "unknown").sort();
  const latestVersion = versions.length ? versions[versions.length - 1] : null;
  const gateSource = latestVersion ? by_predictor_version[latestVersion] : overall;

  return {
    ...overall,
    enough_data_to_lift_cap: gateSource.enough_data_to_lift_cap,
    cap_lift_gate: { ...gateSource.cap_lift_gate, predictor_version: latestVersion },
    by_predictor_version,
    latest_predictor_version: latestVersion,
  };
}
