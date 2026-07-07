#!/usr/bin/env node
/**
 * V4 verdict-cutoff drift monitor (defence-in-depth, non-blocking).
 * =================================================================
 *
 * The V4 verdict cutoffs (TOP_PICK>=59 / STRONG>=47 / ACCEPTABLE>=37 / WATCH>=28)
 * are ABSOLUTE and FROZEN — calibrated once from the 2026-05 India universe
 * distribution (top-pick~=92nd pct, strong~=75th, acceptable~=50th, watch~=25th)
 * and deliberately never auto-recalibrated (see services/swsScoringV4.js
 * verdictV4FromScore). That is correct for verdict stability, but it means that
 * if the universe distribution drifts materially over time, the frozen cutoffs
 * stop mapping to their intended percentiles — and nobody would notice.
 *
 * This monitor reads the current scored universe, measures where each intended
 * percentile actually lands today, and warns if it has drifted past a threshold.
 * It NEVER edits the score or the cutoffs — a drift alert is a prompt for a
 * DELIBERATE human re-freeze + migration, exactly as the frozen-cutoff design
 * requires. Always exits 0 so it can sit in the nightly chain harmlessly.
 *
 * Usage:
 *   node scripts/monitor-v4-cutoff-drift.mjs            # human report
 *   node scripts/monitor-v4-cutoff-drift.mjs --json     # machine-readable
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const UNIVERSE_PATH = path.join(REPO, "data", "sws", "sws-scored-universe.json");

// The frozen cutoffs and the percentile each was calibrated to represent (2026-05).
const FROZEN = [
  { verdict: "TOP_PICK", cutoff: 59, intendedPct: 92 },
  { verdict: "STRONG", cutoff: 47, intendedPct: 75 },
  { verdict: "ACCEPTABLE", cutoff: 37, intendedPct: 50 },
  { verdict: "WATCH", cutoff: 28, intendedPct: 25 },
];
// A cutoff whose intended percentile now maps to a score this many points away
// from the frozen value is flagged as material drift (a re-freeze candidate).
const DRIFT_POINTS_THRESHOLD = 5;

// scoreAtPercentile(scores, p) — the score value at the p-th percentile (0..100),
// linear interpolation on the sorted distribution. Pure + testable.
export function scoreAtPercentile(sortedAsc, p) {
  const s = sortedAsc;
  if (!s.length) return null;
  if (p <= 0) return s[0];
  if (p >= 100) return s[s.length - 1];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// computeDrift(scores) — pure. Returns the per-cutoff drift + overall flag.
export function computeDrift(scores) {
  const clean = scores.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  const rows = FROZEN.map((f) => {
    const scoreAtIntended = clean.length ? scoreAtPercentile(clean, f.intendedPct) : null;
    const drift = scoreAtIntended == null ? null : +(scoreAtIntended - f.cutoff).toFixed(2);
    return {
      verdict: f.verdict,
      frozen_cutoff: f.cutoff,
      intended_percentile: f.intendedPct,
      score_at_intended_percentile_now: scoreAtIntended == null ? null : +scoreAtIntended.toFixed(2),
      drift_points: drift,
      material: drift != null && Math.abs(drift) >= DRIFT_POINTS_THRESHOLD,
    };
  });
  return {
    universe_size: clean.length,
    threshold_points: DRIFT_POINTS_THRESHOLD,
    rows,
    drift_detected: rows.some((r) => r.material),
  };
}

function loadUniverseScores() {
  if (!fs.existsSync(UNIVERSE_PATH)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8")); } catch { return null; }
  const arr = Array.isArray(j) ? j : (j.stocks || j.universe || Object.values(j.byTicker || {}) || []);
  return arr.map((r) => (typeof r.v4_score_100 === "number" ? r.v4_score_100 : null)).filter((x) => x != null);
}

function main() {
  const asJson = process.argv.includes("--json");
  const scores = loadUniverseScores();
  if (!scores) {
    const msg = { ok: false, reason: "scored universe absent — nothing to check", drift_detected: false };
    console.log(asJson ? JSON.stringify(msg) : "[drift-monitor] scored universe absent — skipping (non-fatal).");
    process.exit(0);
  }
  const report = { ok: true, checked_at_source: UNIVERSE_PATH.replace(REPO + "/", ""), ...computeDrift(scores) };
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  console.log("\n=== V4 verdict-cutoff drift monitor (non-blocking, no auto-recalibration) ===");
  console.log(`universe: ${report.universe_size} scored stocks | material-drift threshold: ${report.threshold_points} pts\n`);
  console.log("verdict".padEnd(12), "frozen".padStart(7), "intended%".padStart(11), "score@%now".padStart(12), "drift".padStart(8));
  for (const r of report.rows) {
    console.log(
      r.verdict.padEnd(12),
      String(r.frozen_cutoff).padStart(7),
      String(r.intended_percentile).padStart(11),
      String(r.score_at_intended_percentile_now ?? "—").padStart(12),
      String(r.drift_points ?? "—").padStart(8) + (r.material ? "  ⚠️ MATERIAL" : "")
    );
  }
  console.log(report.drift_detected
    ? "\n⚠️  Material drift detected — the frozen cutoffs no longer map to their 2026-05 percentiles.\n   This is a prompt for a DELIBERATE human re-freeze + migration, not an auto-recalibration."
    : "\n✓ No material drift — frozen cutoffs still map close to their intended percentiles.");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
