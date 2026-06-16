#!/usr/bin/env node
/**
 * Risk Lab backtest — joins resolved earnings predictions to the lab's
 * macro, quality, and disagreement overlays and reports what would have
 * changed before promotion.
 *
 * Output sections:
 *   1. Baseline strict hit rate (production predictor only)
 *   2. Lens A/B blocks: macro, quality, llm_disagreement, combined
 *   3. Catastrophic BEAT->MISS avoidance for every lens
 *   4. Avoidance precision/recall for every lens
 *   5. Promotion gate requiring resolved count, bucket coverage, and
 *      catastrophic improvement
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
const REGIME_PATH = path.join(REPO_ROOT, "data", "macroRegime.json");
const REGIME_HISTORY_DIR = path.join(REPO_ROOT, "data", "macroRegime-history");

const { computeQualityScore } = await import("../services/riskLab/quality/qualityScorer.js");
const { adjustedScoreForRow } = await import("../services/riskLab/macro/adjustedScorer.js");
const { heuristicAssess } = await import("../services/riskLab/quality/llmDisagreementChecker.js");

const JSON_OUT = process.argv.includes("--json");

const MIN_RESOLVED_FOR_AB = 30;
const MIN_PER_BUCKET = 8;
const VERDICTS = ["BEAT", "INLINE", "MISS"];
const LENS_NAMES = ["macro", "quality", "llm_disagreement", "combined"];

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadDeep(ticker) {
  const filePath = path.join(DEEP_DIR, `${ticker}.json`);
  return readJsonSafe(filePath);
}

function collectResolvedPredictions() {
  const files = existsSync(HISTORY_DIR)
    ? readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort()
    : [];
  const byKey = new Map();
  for (const f of files) {
    const snapshot = readJsonSafe(path.join(HISTORY_DIR, f));
    if (!Array.isArray(snapshot?.predictions)) continue;
    for (const p of snapshot.predictions) {
      if (!p?.actual_verdict) continue;
      const key = `${p.symbol}|${p.fiscal_quarter || p.event_iso_date || ""}`;
      byKey.set(key, p);
    }
  }
  return Array.from(byKey.values());
}

function loadRegimeHistory() {
  const out = [];
  if (!existsSync(REGIME_HISTORY_DIR)) return out;
  for (const f of readdirSync(REGIME_HISTORY_DIR).filter((name) => name.endsWith(".jsonl")).sort()) {
    const text = readFileSync(path.join(REGIME_HISTORY_DIR, f), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const ts = new Date(parsed.generatedAt || parsed.generated_at || 0).getTime();
        if (Number.isFinite(ts)) out.push({ ts, regime: parsed });
      } catch {
        // Ignore malformed history lines; the backtest should be best-effort.
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function eventJoinTime(p) {
  const d = String(p?.event_iso_date || p?.resolved_at_iso || p?.actual_resolved_at || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  // 09:00 IST = 03:30 UTC, matching the macroRegimeHistory backtest note.
  const ts = new Date(`${d}T03:30:00.000Z`).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function makeRegimeResolver() {
  const history = loadRegimeHistory();
  const current = readJsonSafe(REGIME_PATH);
  return function regimeForPrediction(p) {
    const ts = eventJoinTime(p);
    if (ts === null || history.length === 0) return current;
    let lo = 0;
    let hi = history.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (history[mid].ts <= ts) {
        best = history[mid].regime;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best || current;
  };
}

function verdictFromScore(score) {
  if (score >= 56) return "BEAT";
  if (score < 34) return "MISS";
  return "INLINE";
}

function normaliseVerdict(verdict) {
  const v = String(verdict || "").toUpperCase();
  return VERDICTS.includes(v) ? v : null;
}

function isHit(predicted, actual) {
  const p = normaliseVerdict(predicted);
  const a = normaliseVerdict(actual);
  if (!p || !a) return null;
  return p === a;
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function pp(value) {
  return Number(value.toFixed(2));
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function minBucketCount(bucketCounts, keys) {
  return Math.min(...keys.map((key) => Number(bucketCounts?.[key] || 0)));
}

function deepInputsForPrediction(p) {
  const deep = loadDeep(p.symbol);
  const overview = deep?.overview || {};
  return {
    risks: Array.isArray(overview.risks) ? overview.risks : Array.isArray(deep?.risks) ? deep.risks : [],
    news: Array.isArray(deep?.news) ? deep.news : Array.isArray(overview.news) ? overview.news : [],
    counter_thesis: p.counter_thesis || p.counter_thesis_text || null,
  };
}

function buildQualityView(p, deepInputs) {
  const v4Breakdown = p.score_breakdown
    ? {
        fv_imputed: false,
        momentum_imputed: false,
      }
    : null;

  return computeQualityScore({
    ticker: p.symbol,
    original_score: Number(p.score_100 || 0),
    original_verdict: p.predicted_verdict,
    original_confidence: p.confidence_pct,
    v4_breakdown: v4Breakdown,
    sector: p.sector,
    counter_thesis: deepInputs.counter_thesis,
    risks: deepInputs.risks,
    news: deepInputs.news,
    event_iso_date: p.event_iso_date,
  });
}

function buildMacroView(p, regime) {
  const score = Number(p.score_100 || 0);
  return adjustedScoreForRow(
    {
      ticker: p.symbol,
      name: p.name || p.company_name || null,
      sector: p.sector || null,
      v4_score_100: score,
      score,
      // Macro vetoes are designed for TOP_PICK rows; for earnings predictions
      // we map BEAT to TOP_PICK so catastrophic-positive calls can be tested.
      v4_verdict: p.predicted_verdict === "BEAT" ? "TOP_PICK" : p.predicted_verdict,
      verdict: p.predicted_verdict,
    },
    regime,
    { now: eventJoinTime(p) ? new Date(eventJoinTime(p)) : new Date() },
  );
}

function buildLlmView(p, macro, quality, deepInputs) {
  return heuristicAssess(
    {
      ticker: p.symbol,
      sector: p.sector || null,
      predicted_verdict: p.predicted_verdict,
      predicted_confidence_pct: p.confidence_pct,
      v4_score: Number(p.score_100 || 0),
      counter_thesis_text: typeof deepInputs.counter_thesis === "string" ? deepInputs.counter_thesis : "",
      falsification_triggers: Array.isArray(deepInputs.counter_thesis?.falsification_triggers)
        ? deepInputs.counter_thesis.falsification_triggers
        : [],
      risks: deepInputs.risks,
      news: deepInputs.news,
      macro_veto: macro.macro_veto,
    },
    quality.quality_flags || [],
  );
}

function buildLensVerdicts(p, macro, quality, llm) {
  const baseline = normaliseVerdict(p.predicted_verdict);
  const baseScore = Number(p.score_100 || 0);
  const macroScore = Number.isFinite(macro.macro_adjusted_score) ? macro.macro_adjusted_score : baseScore;
  const qualityScore = Number.isFinite(quality.quality_adjusted_score) ? quality.quality_adjusted_score : baseScore;

  const macroAvoids = p.predicted_verdict === "BEAT" && (
    macro.macro_veto?.vetoed === true ||
    verdictFromScore(macroScore) !== "BEAT"
  );
  const qualityAvoids = p.predicted_verdict === "BEAT" && (
    quality.quality_veto?.vetoed === true ||
    quality.quality_verdict === "LOW" ||
    verdictFromScore(qualityScore) !== "BEAT"
  );
  const llmAvoids = p.predicted_verdict === "BEAT" && llm?.disagrees === true;
  const combinedScore = Math.max(0, Math.min(100, Number((baseScore + Number(macro.macro_score_delta || 0) + Number(quality.quality_score_delta || 0)).toFixed(2))));
  const combinedAvoids = macroAvoids || qualityAvoids || llmAvoids || verdictFromScore(combinedScore) !== "BEAT" && p.predicted_verdict === "BEAT";

  return {
    macro: {
      predicted: macroAvoids ? "INLINE" : baseline,
      flagged_avoidance: macroAvoids,
      bucket: macro.macro_veto?.vetoed ? "vetoed" : macro.macro_score_delta < 0 ? "negative" : macro.macro_score_delta > 0 ? "positive" : "neutral",
    },
    quality: {
      predicted: qualityAvoids ? "INLINE" : baseline,
      flagged_avoidance: qualityAvoids,
      bucket: quality.quality_verdict || "UNKNOWN",
    },
    llm_disagreement: {
      predicted: llmAvoids ? "INLINE" : baseline,
      flagged_avoidance: llmAvoids,
      bucket: !llm ? "unavailable" : llm.disagrees ? "disagrees" : "agrees",
    },
    combined: {
      predicted: combinedAvoids ? "INLINE" : baseline,
      flagged_avoidance: combinedAvoids,
      bucket: combinedAvoids ? "flagged_avoidance" : "not_flagged",
    },
  };
}

function summariseBaseline(rows) {
  const actual_bucket_counts = {};
  const predicted_bucket_counts = {};
  let scored = 0;
  let hits = 0;
  let beatMiss = 0;
  for (const row of rows) {
    const actual = normaliseVerdict(row.p.actual_verdict);
    const predicted = normaliseVerdict(row.p.predicted_verdict);
    if (actual) bump(actual_bucket_counts, actual);
    if (predicted) bump(predicted_bucket_counts, predicted);
    const h = isHit(predicted, actual);
    if (h === null) continue;
    scored++;
    if (h) hits++;
    if (predicted === "BEAT" && actual === "MISS") beatMiss++;
  }
  return {
    scored,
    hits,
    strict_hit_rate_pct: pct(hits, scored) ?? 0,
    hit_rate_pct: pct(hits, scored) ?? 0,
    actual_bucket_counts,
    predicted_bucket_counts,
    catastrophic_beat_miss_count: beatMiss,
  };
}

function summariseLens(rows, lensName, baseline) {
  let scored = 0;
  let hits = 0;
  let verdictChanged = 0;
  const bucket_counts = {};
  const predicted_bucket_counts = {};
  const avoidance_bucket_counts = { flagged_avoidance: 0, not_flagged: 0 };
  const confusion = { true_positive: 0, false_positive: 0, false_negative: 0, true_negative: 0 };
  let baselineBeatMiss = 0;
  let lensBeatMiss = 0;
  let avoidedBeatMiss = 0;
  let introducedBeatMiss = 0;

  for (const row of rows) {
    const baselinePred = normaliseVerdict(row.p.predicted_verdict);
    const actual = normaliseVerdict(row.p.actual_verdict);
    const lens = row.lenses[lensName];
    const lensPred = normaliseVerdict(lens?.predicted);
    if (lens?.bucket) bump(bucket_counts, lens.bucket);
    if (lensPred) bump(predicted_bucket_counts, lensPred);
    if (lens?.flagged_avoidance) avoidance_bucket_counts.flagged_avoidance += 1;
    else avoidance_bucket_counts.not_flagged += 1;

    const h = isHit(lensPred, actual);
    if (h !== null) {
      scored++;
      if (h) hits++;
    }
    if (baselinePred && lensPred && baselinePred !== lensPred) verdictChanged++;

    const isCatastrophic = baselinePred === "BEAT" && actual === "MISS";
    const flaggedAvoidance = baselinePred === "BEAT" && lens?.flagged_avoidance === true;
    if (isCatastrophic) baselineBeatMiss++;
    if (lensPred === "BEAT" && actual === "MISS") lensBeatMiss++;
    if (isCatastrophic && flaggedAvoidance) avoidedBeatMiss++;
    if (!isCatastrophic && baselinePred !== "BEAT" && lensPred === "BEAT" && actual === "MISS") introducedBeatMiss++;

    if (baselinePred === "BEAT") {
      if (flaggedAvoidance && actual === "MISS") confusion.true_positive++;
      else if (flaggedAvoidance) confusion.false_positive++;
      else if (actual === "MISS") confusion.false_negative++;
      else confusion.true_negative++;
    }
  }

  const strictHitRate = pct(hits, scored) ?? 0;
  const baselineRate = Number(baseline.hit_rate_pct || 0);
  const precision = pct(confusion.true_positive, confusion.true_positive + confusion.false_positive);
  const recall = pct(confusion.true_positive, confusion.true_positive + confusion.false_negative);
  const catastrophicImprovement = baselineBeatMiss - lensBeatMiss;

  return {
    scored,
    hits,
    strict_hit_rate_pct: strictHitRate,
    // Compatibility alias for older health consumers.
    hit_rate_pct: strictHitRate,
    hit_rate_diff_pct: pp(strictHitRate - baselineRate),
    verdict_changed_count: verdictChanged,
    bucket_counts,
    predicted_bucket_counts,
    avoidance_bucket_counts,
    catastrophic: {
      baseline_beat_miss_count: baselineBeatMiss,
      lens_beat_miss_count: lensBeatMiss,
      avoided_beat_miss_count: avoidedBeatMiss,
      introduced_beat_miss_count: introducedBeatMiss,
      improvement_count: catastrophicImprovement,
      improvement_pct: pct(catastrophicImprovement, baselineBeatMiss),
    },
    flagged_avoidance: {
      flagged_count: avoidance_bucket_counts.flagged_avoidance,
      precision_pct: precision,
      recall_pct: recall,
      confusion,
    },
  };
}

function buildCaseStudies(rows) {
  const kecClass = rows
    .filter((row) => row.p.predicted_verdict === "BEAT" && row.p.actual_verdict === "MISS")
    .map((row) => ({
      symbol: row.p.symbol,
      sector: row.p.sector,
      score: row.p.score_100,
      confidence: row.p.confidence_pct,
      actual: row.p.actual_verdict,
      lab_quality_verdict: row.quality.quality_verdict,
      lab_combined: row.quality.combined_verdict,
      lab_score_delta: row.quality.quality_score_delta,
      lab_flag_count: row.quality.quality_flags?.length || 0,
      lab_flagged_categories: (row.quality.quality_flags || []).map((f) => f.category || f.type || f.overlay),
      lab_would_have_caught: row.lenses.combined.flagged_avoidance === true,
      caught_by_lens: Object.fromEntries(LENS_NAMES.map((name) => [name, row.lenses[name].flagged_avoidance === true])),
    }));

  const anantrajClass = rows
    .filter((row) => {
      if (!row.p.actual_t1_close_inr || !row.p.price_at_snapshot_inr) return false;
      const ret = row.p.actual_t1_close_inr / row.p.price_at_snapshot_inr - 1;
      return row.p.predicted_verdict === "BEAT" && ret < -0.05;
    })
    .map((row) => {
      const ret = (row.p.actual_t1_close_inr / row.p.price_at_snapshot_inr - 1) * 100;
      return {
        symbol: row.p.symbol,
        sector: row.p.sector,
        score: row.p.score_100,
        t1_return_pct: Number(ret.toFixed(2)),
        actual_verdict: row.p.actual_verdict,
        lab_quality_verdict: row.quality.quality_verdict,
        lab_combined: row.quality.combined_verdict,
        lab_would_have_caught: row.lenses.combined.flagged_avoidance === true,
        caught_by_lens: Object.fromEntries(LENS_NAMES.map((name) => [name, row.lenses[name].flagged_avoidance === true])),
      };
    });

  return {
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

function buildAbStatus(summary, lenses) {
  const actualMin = minBucketCount(summary.original.actual_bucket_counts, VERDICTS);
  const combinedAvoidanceMin = minBucketCount(lenses.combined.avoidance_bucket_counts, ["flagged_avoidance", "not_flagged"]);
  const resolvedOk = summary.original.scored >= MIN_RESOLVED_FOR_AB;
  const actualBucketsOk = actualMin >= MIN_PER_BUCKET;
  const avoidanceBucketsOk = combinedAvoidanceMin >= MIN_PER_BUCKET;
  const catastrophicImproved = (lenses.combined.catastrophic?.improvement_count || 0) > 0;
  const checks = {
    min_resolved: {
      ok: resolvedOk,
      actual: summary.original.scored,
      required: MIN_RESOLVED_FOR_AB,
    },
    min_actual_verdict_bucket: {
      ok: actualBucketsOk,
      actual: actualMin,
      required: MIN_PER_BUCKET,
      buckets: summary.original.actual_bucket_counts,
    },
    min_combined_avoidance_bucket: {
      ok: avoidanceBucketsOk,
      actual: combinedAvoidanceMin,
      required: MIN_PER_BUCKET,
      buckets: lenses.combined.avoidance_bucket_counts,
    },
    catastrophic_improvement: {
      ok: catastrophicImproved,
      actual: lenses.combined.catastrophic?.improvement_count || 0,
      required: "> 0",
    },
  };
  const failed = Object.entries(checks)
    .filter(([, value]) => !value.ok)
    .map(([key]) => key);

  return {
    meaningful: failed.length === 0,
    min_resolved_required: MIN_RESOLVED_FOR_AB,
    min_per_bucket_required: MIN_PER_BUCKET,
    requires_catastrophic_improvement: true,
    checks,
    reason: failed.length === 0
      ? "sample, bucket coverage, and catastrophic BEAT->MISS improvement gates passed"
      : `promotion gate blocked: ${failed.join(", ")}`,
  };
}

function buildReport() {
  const resolved = collectResolvedPredictions();
  const regimeForPrediction = makeRegimeResolver();
  const rows = resolved.map((p) => {
    const deepInputs = deepInputsForPrediction(p);
    const macro = buildMacroView(p, regimeForPrediction(p));
    const quality = buildQualityView(p, deepInputs);
    const llm = buildLlmView(p, macro, quality, deepInputs);
    const lenses = buildLensVerdicts(p, macro, quality, llm);
    return { p, macro, quality, llm, lenses };
  });

  const original = summariseBaseline(rows);
  const lenses = Object.fromEntries(LENS_NAMES.map((name) => [name, summariseLens(rows, name, original)]));
  const summary = {
    total_resolved: resolved.length,
    original,
    // Compatibility: old consumers used `lab` for the lab-adjusted block.
    lab: lenses.combined,
    hit_rate_diff_pct: lenses.combined.hit_rate_diff_pct,
    verdict_changed_count: lenses.combined.verdict_changed_count,
  };
  const caseStudies = buildCaseStudies(rows);

  return {
    summary,
    lenses,
    ab_status: buildAbStatus(summary, lenses),
    ...caseStudies,
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
  console.log(`  Original strict hit rate: ${report.summary.original.hits}/${report.summary.original.scored} (${report.summary.original.strict_hit_rate_pct}%)`);
  for (const name of LENS_NAMES) {
    const lens = report.lenses[name];
    const delta = lens.hit_rate_diff_pct >= 0 ? `+${lens.hit_rate_diff_pct}` : String(lens.hit_rate_diff_pct);
    const improvement = lens.catastrophic.improvement_count >= 0 ? `+${lens.catastrophic.improvement_count}` : String(lens.catastrophic.improvement_count);
    console.log(`  ${name.padEnd(16)} ${lens.hits}/${lens.scored} (${lens.strict_hit_rate_pct}%, ${delta} pp), catastrophic improvement ${improvement}`);
  }
  console.log();
  console.log(`A/B status: ${report.ab_status.meaningful ? "meaningful" : "insufficient"} — ${report.ab_status.reason}`);
  console.log(`  Actual buckets: ${JSON.stringify(report.summary.original.actual_bucket_counts)}`);
  console.log(`  Combined avoidance buckets: ${JSON.stringify(report.lenses.combined.avoidance_bucket_counts)}`);
  console.log();
  console.log(`KEC-class case study (BEAT predicted, MISS resolved): ${report.kec_case_study.count} events`);
  console.log(`  Caught by combined Risk Lab: ${report.kec_case_study.caught_by_lab}/${report.kec_case_study.count}`);
  for (const c of report.kec_case_study.cases.slice(0, 5)) {
    console.log(`    ${c.symbol.padEnd(14)} score=${c.score} conf=${c.confidence}% quality=${c.lab_quality_verdict} delta=${c.lab_score_delta} caught=${c.lab_would_have_caught}`);
  }
  console.log();
  console.log(`ANANTRAJ-class case study (BEAT predicted, T+1 return < -5%): ${report.anantraj_case_study.count} events`);
  console.log(`  Caught by combined Risk Lab: ${report.anantraj_case_study.caught_by_lab}/${report.anantraj_case_study.count}`);
  for (const c of report.anantraj_case_study.cases.slice(0, 5)) {
    console.log(`    ${c.symbol.padEnd(14)} t1=${c.t1_return_pct}% actual=${c.actual_verdict} caught=${c.lab_would_have_caught}`);
  }
}
