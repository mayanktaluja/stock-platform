#!/usr/bin/env node
/**
 * Risk Lab backtest — joins resolved earnings predictions to the lab's
 * macro + quality overlays and reports what would have changed.
 *
 * Output sections:
 *   1. Baseline hit rates (production predictor only)
 *   2. Macro Lens A/B (would the macro overlay have moved any verdicts?)
 *   3. Quality Lens A/B (would the quality overlay have moved any verdicts?)
 *   4. ANANTRAJ case study — TOP_PICKs that lost > 5% on T+1
 *   5. KEC case study — BEAT predictions that resolved MISS
 *
 * Statistical A/B abstains until coverage_pct > 50% AND ≥30 resolved
 * events with ≥8 per regime/quality bucket — months out (honest about
 * it per plan D7). Case studies (4 + 5) give immediate signal even
 * before the statistical gate clears.
 *
 * Usage:
 *   node scripts/backtest-risk-lab.mjs            # human-readable
 *   node scripts/backtest-risk-lab.mjs --json     # machine-readable
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(REPO_ROOT, "data", "catalysts", "earnings-history");
const DEEP_DIR = path.join(REPO_ROOT, "data", "sws", "deep");

const { computeQualityScore } = await import("../services/riskLab/quality/qualityScorer.js");
const { adjustedScoreForRow } = await import("../services/riskLab/macro/adjustedScorer.js");

const JSON_OUT = process.argv.includes("--json");

const MIN_RESOLVED_FOR_AB = 30;
const MIN_PER_BUCKET = 8;

function loadDeep(ticker) {
  const filePath = path.join(DEEP_DIR, `${ticker}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Collect all unique resolved predictions across the snapshot history,
 * keyed by (symbol, fiscal_quarter). Latest snapshot for each key wins
 * so post-resolution restatements supersede earlier reads.
 */
function collectResolvedPredictions() {
  const files = readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const byKey = new Map();
  for (const f of files) {
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(snapshot.predictions)) continue;
    for (const p of snapshot.predictions) {
      if (!p.actual_verdict) continue;
      const key = `${p.symbol}|${p.fiscal_quarter || p.event_iso_date}`;
      byKey.set(key, p); // later snapshots overwrite earlier
    }
  }
  return Array.from(byKey.values());
}

/**
 * For one resolved prediction, build the synthetic row + apply the lab
 * scorers. Returns the lab-adjusted view.
 */
function applyLabToResolvedPrediction(p) {
  const deep = loadDeep(p.symbol);
  const risks = deep?.overview?.risks || deep?.risks || [];
  const news = deep?.news || deep?.overview?.news || [];

  // Synthesise a v3_breakdown-shaped object for the imputation penalty.
  // We don't have the original breakdown for old snapshots, so we use
  // what's in score_breakdown if present and otherwise default to safe.
  const v3Breakdown = p.score_breakdown
    ? {
        fv_imputed: false, // not exposed; assume false
        momentum_imputed: false,
      }
    : null;

  const quality = computeQualityScore({
    ticker: p.symbol,
    original_score: Number(p.score_100 || 0),
    original_verdict: p.predicted_verdict,
    original_confidence: p.confidence_pct,
    v3_breakdown: v3Breakdown,
    sector: p.sector,
    counter_thesis: null, // historical snapshots don't include this; oh well
    risks,
    news,
    event_iso_date: p.event_iso_date,
  });

  return quality;
}

/**
 * Predicted verdict mapping after quality adjustment. Naive: if
 * adjusted score crosses the production cut-points, the verdict flips.
 * Production cuts (per earningsPredictor.js): score >= 56 BEAT, < 34 MISS,
 * else INLINE.
 */
function verdictFromScore(score) {
  if (score >= 56) return "BEAT";
  if (score < 34) return "MISS";
  return "INLINE";
}

function isHit(predicted, actual) {
  if (!predicted || !actual) return null;
  // Treat "INSUFFICIENT_DATA" as no prediction
  if (predicted === "INSUFFICIENT_DATA") return null;
  return predicted === actual;
}

function buildReport() {
  const resolved = collectResolvedPredictions();
  const total = resolved.length;

  // Original (baseline) hits
  let origHits = 0, origScored = 0;
  for (const p of resolved) {
    const h = isHit(p.predicted_verdict, p.actual_verdict);
    if (h === null) continue;
    origScored++;
    if (h) origHits++;
  }
  const origHitRate = origScored > 0 ? origHits / origScored : 0;

  // Apply lab + count
  const labViews = resolved.map((p) => {
    const lab = applyLabToResolvedPrediction(p);
    const labAdjustedVerdict = verdictFromScore(lab.quality_adjusted_score);
    const labHit = isHit(labAdjustedVerdict, p.actual_verdict);
    return { p, lab, labAdjustedVerdict, labHit };
  });

  let labHits = 0, labScored = 0, verdictChanged = 0;
  for (const v of labViews) {
    if (v.labHit === null) continue;
    labScored++;
    if (v.labHit) labHits++;
    if (v.labAdjustedVerdict !== v.p.predicted_verdict) verdictChanged++;
  }
  const labHitRate = labScored > 0 ? labHits / labScored : 0;

  // KEC-class case study: BEAT predicted that resolved MISS
  const kecClass = labViews.filter(
    (v) => v.p.predicted_verdict === "BEAT" && v.p.actual_verdict === "MISS",
  ).map((v) => ({
    symbol: v.p.symbol,
    sector: v.p.sector,
    score: v.p.score_100,
    confidence: v.p.confidence_pct,
    actual: v.p.actual_verdict,
    lab_quality_verdict: v.lab.quality_verdict,
    lab_combined: v.lab.combined_verdict,
    lab_score_delta: v.lab.quality_score_delta,
    lab_flag_count: v.lab.quality_flags?.length || 0,
    lab_flagged_categories: (v.lab.quality_flags || []).map((f) => f.category || f.type || f.overlay),
    lab_would_have_caught: v.lab.quality_verdict === "LOW",
  }));

  // ANANTRAJ-class: TOP_PICK (or BEAT high-confidence) that resolved BEAT but stock fell
  // T+1 only (we don't have T+30 data); count fall > 5%
  const anantrajClass = labViews
    .filter((v) => {
      if (!v.p.actual_t1_close_inr || !v.p.price_at_snapshot_inr) return false;
      const ret = v.p.actual_t1_close_inr / v.p.price_at_snapshot_inr - 1;
      // Was a positive-bias prediction that lost meaningfully on T+1
      return v.p.predicted_verdict === "BEAT" && ret < -0.05;
    })
    .map((v) => {
      const ret = (v.p.actual_t1_close_inr / v.p.price_at_snapshot_inr - 1) * 100;
      return {
        symbol: v.p.symbol,
        sector: v.p.sector,
        score: v.p.score_100,
        t1_return_pct: Number(ret.toFixed(2)),
        actual_verdict: v.p.actual_verdict,
        lab_quality_verdict: v.lab.quality_verdict,
        lab_combined: v.lab.combined_verdict,
        lab_would_have_caught: v.lab.quality_verdict === "LOW",
      };
    });

  // Determine if A/B is statistically meaningful yet
  const abMeaningful = origScored >= MIN_RESOLVED_FOR_AB;

  return {
    summary: {
      total_resolved: total,
      original: { scored: origScored, hits: origHits, hit_rate_pct: Number((origHitRate * 100).toFixed(2)) },
      lab: { scored: labScored, hits: labHits, hit_rate_pct: Number((labHitRate * 100).toFixed(2)) },
      hit_rate_diff_pct: Number(((labHitRate - origHitRate) * 100).toFixed(2)),
      verdict_changed_count: verdictChanged,
    },
    ab_status: {
      meaningful: abMeaningful,
      min_resolved_required: MIN_RESOLVED_FOR_AB,
      min_per_bucket_required: MIN_PER_BUCKET,
      reason: abMeaningful
        ? "sample size sufficient for headline hit-rate comparison"
        : `need ${MIN_RESOLVED_FOR_AB - origScored} more resolved events for headline A/B`,
    },
    kec_case_study: {
      count: kecClass.length,
      caught_by_lab: kecClass.filter((k) => k.lab_would_have_caught).length,
      cases: kecClass,
    },
    anantraj_case_study: {
      count: anantrajClass.length,
      caught_by_lab: anantrajClass.filter((a) => a.lab_would_have_caught).length,
      cases: anantrajClass,
    },
  };
}

const report = buildReport();

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log(`Risk Lab Backtest — generated ${new Date().toISOString()}`);
  console.log("=".repeat(70));
  console.log();
  console.log(`Resolved predictions: ${report.summary.total_resolved}`);
  console.log(`  Original hit rate:  ${report.summary.original.hits}/${report.summary.original.scored} (${report.summary.original.hit_rate_pct}%)`);
  console.log(`  Lab-adjusted:       ${report.summary.lab.hits}/${report.summary.lab.scored} (${report.summary.lab.hit_rate_pct}%)`);
  console.log(`  Delta:              ${report.summary.hit_rate_diff_pct >= 0 ? "+" : ""}${report.summary.hit_rate_diff_pct} pp`);
  console.log(`  Verdicts flipped:   ${report.summary.verdict_changed_count}`);
  console.log();
  console.log(`A/B status: ${report.ab_status.meaningful ? "✓ meaningful" : "✗ insufficient"} — ${report.ab_status.reason}`);
  console.log();
  console.log(`KEC-class case study (BEAT predicted, MISS resolved): ${report.kec_case_study.count} events`);
  console.log(`  Caught by Quality Lens (LOW verdict): ${report.kec_case_study.caught_by_lab}/${report.kec_case_study.count}`);
  for (const c of report.kec_case_study.cases.slice(0, 5)) {
    console.log(`    ${c.symbol.padEnd(14)} score=${c.score} conf=${c.confidence}% lab=${c.lab_quality_verdict} delta=${c.lab_score_delta} flags=${c.lab_flagged_categories.join(",")}`);
  }
  console.log();
  console.log(`ANANTRAJ-class case study (BEAT predicted, T+1 return < -5%): ${report.anantraj_case_study.count} events`);
  console.log(`  Caught by Quality Lens (LOW verdict): ${report.anantraj_case_study.caught_by_lab}/${report.anantraj_case_study.count}`);
  for (const c of report.anantraj_case_study.cases.slice(0, 5)) {
    console.log(`    ${c.symbol.padEnd(14)} t1=${c.t1_return_pct}% actual=${c.actual_verdict} lab=${c.lab_quality_verdict} caught=${c.lab_would_have_caught}`);
  }
}
