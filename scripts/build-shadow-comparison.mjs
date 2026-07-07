#!/usr/bin/env node
/**
 * Shadow scoring comparison report (Tier-3).
 * =========================================
 *
 * Scores the current SWS universe with the LIVE V4 scorer and, side by side,
 * every SHADOW candidate (services/swsScoringV4Shadow.js). It writes a compact
 * JSON that the standalone Shadow Lab page renders so a human can SEE — before
 * any promotion — how each candidate moves scores and migrates verdicts.
 *
 * It never touches the live pipeline or picks-latest.json; it only reads deep
 * briefs + the persisted universe stats and writes data/shadow/…
 *
 * Usage:
 *   node scripts/build-shadow-comparison.mjs            # full universe
 *   node scripts/build-shadow-comparison.mjs --limit 500
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeV4Score, verdictV4FromScore } from "../services/swsScoringV4.js";
import {
  computeShadowVariantMatrix,
  SHADOW_VARIANT_KEYS,
} from "../services/swsScoringV4Shadow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DEEP_DIR = path.join(REPO, "data", "sws", "deep");
const STATS_PATH = path.join(REPO, "data", "sws", "v4-universe-stats.json");
const OUT_DIR = path.join(REPO, "data", "shadow");
const OUT_PATH = path.join(OUT_DIR, "shadow-comparison-latest.json");

const VERDICTS = ["TOP_PICK", "STRONG", "ACCEPTABLE", "WATCH", "AVOID"];

function loadUniverse() {
  const j = JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  return {
    r1y: j.r1y || [], r3m: j.r3m || [], r1m: j.r1m || [],
    fvBenchmark: j.fv_benchmark || null,
    fvCompositeIndustryAverages: j.fv_composite_industry_averages || j.fvCompositeIndustryAverages || {},
    generated_at: j.generated_at || null,
    universe_size: j.universe_size || null,
  };
}

function main() {
  const limIdx = process.argv.indexOf("--limit");
  const limit = limIdx !== -1 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;
  const universe = loadUniverse();
  const opts = { universe, now: Date.now() };

  const files = fs.readdirSync(DEEP_DIR).filter((f) => f.endsWith(".json"));
  const rows = [];
  // Per-variant accumulators.
  const variantKeys = [...SHADOW_VARIANT_KEYS, "__combined"];
  const agg = {};
  for (const k of variantKeys) {
    agg[k] = {
      scored: 0, changed_verdict: 0, moved_score: 0,
      sum_delta: 0, deltas: [],
      // migration[from][to] = count
      migration: Object.fromEntries(VERDICTS.map((v) => [v, Object.fromEntries(VERDICTS.map((w) => [w, 0]))])),
      up: [], down: [], // top movers by delta
    };
  }

  let scored = 0;
  for (const f of files) {
    if (scored >= limit) break;
    let stock;
    try { stock = JSON.parse(fs.readFileSync(path.join(DEEP_DIR, f), "utf8")); } catch { continue; }
    const ov = stock.overview;
    if (!ov || !ov.snowflake) continue; // need pillars to score
    let liveRes;
    try { liveRes = computeV4Score(stock, opts); } catch { continue; }
    const liveScore = liveRes.v4_score_100;
    const liveVerdict = verdictV4FromScore(liveScore);
    let matrix;
    try { matrix = computeShadowVariantMatrix(stock, opts); } catch { continue; }
    scored++;

    const sym = stock.ticker || ov.symbol || f.replace(/\.json$/, "");
    const name = ov.name || ov.company_name || sym;
    const rowVariants = {};
    for (const k of variantKeys) {
      const r = matrix[k];
      rowVariants[k] = { score: r.shadow_score, verdict: r.shadow_verdict, delta: r.delta };
      const a = agg[k];
      a.scored++;
      a.sum_delta += r.delta;
      a.deltas.push(r.delta);
      if (r.delta !== 0) a.moved_score++;
      if (r.shadow_verdict !== liveVerdict) a.changed_verdict++;
      if (VERDICTS.includes(liveVerdict) && VERDICTS.includes(r.shadow_verdict)) {
        a.migration[liveVerdict][r.shadow_verdict]++;
      }
      const mover = { symbol: sym, name, live: liveScore, shadow: r.shadow_score, delta: r.delta, live_verdict: liveVerdict, shadow_verdict: r.shadow_verdict };
      if (r.delta > 0) a.up.push(mover); else if (r.delta < 0) a.down.push(mover);
    }
    rows.push({ symbol: sym, name, sector: ov.sector || null, live_score: liveScore, live_verdict: liveVerdict, variants: rowVariants });
  }

  // Finalise aggregates.
  const summary = {};
  for (const k of variantKeys) {
    const a = agg[k];
    const ds = a.deltas.slice().sort((x, y) => x - y);
    const median = ds.length ? ds[Math.floor(ds.length / 2)] : 0;
    a.up.sort((x, y) => y.delta - x.delta);
    a.down.sort((x, y) => x.delta - y.delta);
    summary[k] = {
      scored: a.scored,
      changed_verdict: a.changed_verdict,
      changed_verdict_pct: a.scored ? +(100 * a.changed_verdict / a.scored).toFixed(1) : 0,
      moved_score: a.moved_score,
      mean_delta: a.scored ? +(a.sum_delta / a.scored).toFixed(2) : 0,
      median_delta: +median.toFixed(2),
      migration: a.migration,
      top_up: a.up.slice(0, 15),
      top_down: a.down.slice(0, 15),
    };
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    schema: "shadow-comparison-v1",
    generated_at: new Date(opts.now).toISOString(),
    universe_stats_at: universe.generated_at,
    scored,
    variant_keys: variantKeys,
    variant_labels: {
      A4_fv_deinflation: "A4 · FV de-inflation (extend near-max haircut)",
      A5_valuetrap_gradient: "A5 · Value-trap gradient (replace binary brake)",
      A2_momentum_divergence: "A2 · Momentum divergence penalty",
      A8_freshness_demotion: "A8 · Stale-brief freshness haircut",
      A1_reweight: "A1 · Pillar reweight (H/F/V/P)",
      A11_dcf_fallback: "A11 · DCF fair-value fallback (inert until ingested)",
      __combined: "Σ Combined candidate engine (all variants)",
    },
    summary,
    rows,
  };
  // Atomic write.
  const tmp = OUT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, OUT_PATH);

  console.log(`Shadow comparison: scored ${scored} stocks → ${path.relative(REPO, OUT_PATH)}`);
  for (const k of variantKeys) {
    const s = summary[k];
    console.log(`  ${k.padEnd(24)} verdict-changed ${String(s.changed_verdict).padStart(4)} (${s.changed_verdict_pct}%)  mean Δ ${s.mean_delta >= 0 ? "+" : ""}${s.mean_delta}`);
  }
}

main();
