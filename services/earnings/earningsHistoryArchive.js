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
 *       }
 *     ]
 *   }
 *
 * The post-event ingester (out of scope for V1; needed once
 * fundamentals + analyst commentary become available) updates the
 * `actual_*` fields in-place. The 75-day SEBI lag means we can't
 * close the loop on Q4 FY26 results until ~mid-July 2026.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const HISTORY_SCHEMA_VERSION = "earnings-history-v1";

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
 * Compute calibration metrics from the populated history.
 *
 * Returns:
 *   {
 *     resolved_count, unresolved_count,
 *     hit_rate_overall_pct,
 *     hit_rate_by_confidence_bucket: { "50-54": pct, "55-59": pct, ... },
 *     hit_rate_by_verdict: { BEAT: pct, INLINE: pct, MISS: pct },
 *     brier_score (lower is better; 0 = perfect),
 *     enough_data_to_lift_cap: bool (≥30 resolved + hit-rate ≥55% in the
 *                              60–65% bucket + Brier < 0.20 — V1 cap-lift gate)
 *   }
 */
export function computeCalibration(history) {
  let resolved = 0, unresolved = 0;
  let hits = 0;
  const byBucket = new Map(); // "60-64" → { hits, total }
  const byVerdict = new Map(); // "BEAT" → { hits, total }
  let brierSum = 0, brierCount = 0;

  for (const day of history || []) {
    for (const r of day.predictions || []) {
      if (!r.actual_verdict) {
        unresolved += 1;
        continue;
      }
      resolved += 1;
      const hit = r.predicted_verdict === r.actual_verdict;
      if (hit) hits += 1;

      // Bucket confidence into 5pt windows.
      const c = num(r.confidence_pct);
      if (c != null) {
        const lo = Math.floor(c / 5) * 5;
        const key = `${lo}-${lo + 4}`;
        const e = byBucket.get(key) || { hits: 0, total: 0 };
        e.total += 1;
        if (hit) e.hits += 1;
        byBucket.set(key, e);

        // Brier: (predicted_prob - actual_outcome)^2 averaged.
        // We treat confidence_pct as P(predicted_verdict). actual is
        // 1 if hit, 0 otherwise. This gives a Brier score for a
        // 3-class problem reduced to "are we right".
        const p = c / 100;
        brierSum += Math.pow(p - (hit ? 1 : 0), 2);
        brierCount += 1;
      }

      const v = r.predicted_verdict;
      if (v) {
        const e = byVerdict.get(v) || { hits: 0, total: 0 };
        e.total += 1;
        if (hit) e.hits += 1;
        byVerdict.set(v, e);
      }
    }
  }

  const hit_rate_overall_pct = resolved > 0 ? Math.round((hits / resolved) * 1000) / 10 : null;

  const bucketMap = {};
  for (const [k, v] of byBucket) {
    bucketMap[k] = v.total > 0 ? Math.round((v.hits / v.total) * 1000) / 10 : null;
  }
  const verdictMap = {};
  for (const [k, v] of byVerdict) {
    verdictMap[k] = v.total > 0 ? Math.round((v.hits / v.total) * 1000) / 10 : null;
  }

  const brier = brierCount > 0 ? Math.round((brierSum / brierCount) * 1000) / 1000 : null;

  // V1 cap-lift gate (per the original plan): ≥30 resolved AND
  // hit-rate ≥55% in the 60–64 confidence bucket AND Brier < 0.20.
  const bucket6064 = byBucket.get("60-64");
  const bucketHitRate = bucket6064 ? (bucket6064.hits / Math.max(bucket6064.total, 1)) * 100 : 0;
  const enough_data_to_lift_cap =
    resolved >= 30 && bucketHitRate >= 55 && (brier ?? 1) < 0.20;

  return {
    resolved_count: resolved,
    unresolved_count: unresolved,
    hit_rate_overall_pct,
    hit_rate_by_confidence_bucket: bucketMap,
    hit_rate_by_verdict: verdictMap,
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
