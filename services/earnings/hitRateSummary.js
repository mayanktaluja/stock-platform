// On-demand 3-metric hit-rate summary for the Earnings Watch header (PR A3).
//
// Reads data/catalysts/earnings-history/<date>.json files, dedupes by
// (symbol, event_iso_date), and computes the strict / lenient /
// catastrophic hit-rates with bootstrap CIs by delegating to
// calibrationFor() in earningsHistoryArchive.js.
//
// Why: /api/earnings/upcoming/stats currently reads earnings-watch-stats.json
// which doesn't include calibration metrics. The 3-metric header needs them
// without waiting for the next backtest cron. This loader does the lightweight
// recomputation (47 resolved rows in the current snapshot → <50ms) on demand,
// cached behind file mtime.
//
// The summary also flags `catastrophic_alert: true` when the catastrophic rate
// exceeds 12% over rolling 30 — the threshold from the Phase 2 plan that the
// Risk Lab promotion gate uses.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { calibrationFor } from "./earningsHistoryArchive.js";
import { earningsHistoryReadDir } from "./earningsHistoryStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const HISTORY_DIR = path.join(REPO_ROOT, "data", "catalysts", "earnings-history");
export const CATASTROPHIC_ALERT_THRESHOLD_PCT = 12;
export const ROLLING_WINDOW_SIZE = 30;

let _cache = null;

function _resetCache() {
  _cache = null;
}

function _maxMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  let m = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const s = fs.statSync(path.join(dir, f));
    if (s.mtimeMs > m) m = s.mtimeMs;
  }
  return m;
}

function _loadAndDedup(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const seen = new Map();
  for (const f of files) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    const rows = Array.isArray(obj?.predictions) ? obj.predictions : [];
    for (const r of rows) {
      if (!r?.symbol || !r?.event_iso_date) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      // Later snapshot wins (preserves the freshest actual_verdict
      // resolution if it shipped late, e.g. resolved 5 days after event).
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}

// Build the summary from pre-loaded history file objects (the shape the
// nightly runner already loads via loadAllHistory()). Each file is
// expected to look like { schema_version, today_iso, predictions: [] }.
// Pure-function entrypoint — earningsHealth.js calls this with whatever
// history it was handed and never touches disk.
export function summarizeFromHistoryFiles(historyFiles) {
  const seen = new Map();
  for (const f of historyFiles || []) {
    const rows = Array.isArray(f?.predictions) ? f.predictions : [];
    for (const r of rows) {
      if (!r?.symbol || !r?.event_iso_date) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      seen.set(key, r);
    }
  }
  return _buildSummary([...seen.values()]);
}

// historyDir defaults lazily (evaluated per call, not at module load) so the
// Vercel tarball extract happens on first read rather than at import time.
export function loadHitRateSummary({ historyDir = earningsHistoryReadDir(), force = false } = {}) {
  const mtime = _maxMtime(historyDir);
  if (!force && _cache && _cache.mtime === mtime && _cache.historyDir === historyDir) {
    return _cache.value;
  }
  const rows = _loadAndDedup(historyDir);
  const value = _buildSummary(rows);
  _cache = { mtime, historyDir, value };
  return value;
}

function _buildSummary(rows) {
  const cal = calibrationFor(rows);

  const rollingCatastrophic = (() => {
    // Last ROLLING_WINDOW_SIZE resolved by event_iso_date desc — gives
    // the trailing window the alert rule cares about.
    const resolved = rows.filter((r) => r.actual_verdict && r.predicted_verdict);
    resolved.sort((a, b) => (b.event_iso_date || "").localeCompare(a.event_iso_date || ""));
    const recent = resolved.slice(0, ROLLING_WINDOW_SIZE);
    if (recent.length === 0) return null;
    const VO = { MISS: 0, INLINE: 1, BEAT: 2 };
    let cat = 0;
    for (const r of recent) {
      const pi = VO[r.predicted_verdict];
      const ai = VO[r.actual_verdict];
      if (pi === undefined || ai === undefined) continue;
      if (Math.abs(pi - ai) === 2) cat += 1;
    }
    return {
      window: recent.length,
      catastrophic_count: cat,
      catastrophic_rate_pct: Math.round((cat / recent.length) * 1000) / 10,
    };
  })();

  const value = {
    schema_version: "hit-rate-summary-v1",
    generated_at: new Date().toISOString(),
    resolved_count: cal.resolved_count,
    unresolved_count: cal.unresolved_count,
    strict: {
      hit_rate_pct: cal.hit_rate_overall_pct,
      ci_low_pct: cal.hit_rate_overall_ci_low_pct,
      ci_high_pct: cal.hit_rate_overall_ci_high_pct,
      sample_size: cal.hit_rate_overall_sample_size,
    },
    lenient: {
      hit_rate_pct: cal.hit_rate_lenient_pct,
      ci_low_pct: cal.hit_rate_lenient_ci_low_pct,
      ci_high_pct: cal.hit_rate_lenient_ci_high_pct,
      sample_size: cal.hit_rate_lenient_sample_size,
    },
    catastrophic: {
      rate_pct: cal.hit_rate_catastrophic_pct,
      ci_low_pct: cal.hit_rate_catastrophic_ci_low_pct,
      ci_high_pct: cal.hit_rate_catastrophic_ci_high_pct,
      sample_size: cal.hit_rate_catastrophic_sample_size,
    },
    rolling_30: rollingCatastrophic,
    catastrophic_alert:
      rollingCatastrophic !== null &&
      rollingCatastrophic.catastrophic_rate_pct > CATASTROPHIC_ALERT_THRESHOLD_PCT,
    catastrophic_alert_threshold_pct: CATASTROPHIC_ALERT_THRESHOLD_PCT,
  };

  return value;
}

// Test hook — clears the module-level cache so tests can mutate the
// history dir and reload without bouncing the process.
export function _resetSummaryCacheForTests() {
  _resetCache();
}

export default {
  loadHitRateSummary,
  summarizeFromHistoryFiles,
  HISTORY_DIR,
  CATASTROPHIC_ALERT_THRESHOLD_PCT,
  _resetSummaryCacheForTests,
};
