/**
 * loadV3UniverseStats.js
 *
 * Loads data/sws/v3-universe-stats.json — the sorted {r1m, r3m, r1y}
 * return arrays the SWS V3 scorer needs as `opts.universe` to turn raw
 * returns into momentum percentiles.
 *
 * Why a dedicated loader: the Earnings Watch predictor's V3 adapter may
 * have to inline-compute a stock's V3 breakdown (for events not in any
 * picks-latest section). computeV3Score() degrades gracefully without
 * universe stats — momentum just gets imputed at the 50th percentile —
 * but the file IS committed by the SWS refresh pipeline, so we load it
 * and warn loudly if it's gone stale rather than silently impute.
 *
 * Critically: the predictor only consumes the future/past/valuation/
 * overlay V3 components, none of which depend on the universe stats —
 * so a missing file degrades v3_score_100 accuracy slightly but never
 * breaks the components the predictor actually scores on.
 *
 * Coverage gap (expected, not an error): `counts.r1m/r3m/r1y` will be
 * smaller than `universe_size` whenever the deep dir has stocks whose
 * SWS profile carries `overview.returns_pct: null` — typically thinly-
 * traded BSE-only numeric-code tickers and delisted names. The producer
 * emits a `momentum_coverage` block alongside the arrays naming those
 * stocks so the gap is auditable rather than mysterious. Those stocks
 * are still scored by computeV3Score; momentum just gets imputed (50th
 * percentile) and `breakdown.momentum_imputed: true` is stamped.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const V3_UNIVERSE_STATS_PATH = path.join(ROOT, "data", "sws", "v3-universe-stats.json");
const STALE_AFTER_DAYS = 7;

/**
 * @param {object} [opts]
 * @param {string} [opts.filePath]  override (tests)
 * @returns {{r1m:number[], r3m:number[], r1y:number[]}|null}
 *          null when the file is missing or unparseable — callers pass
 *          this straight to computeV3Score, which treats null as
 *          "impute momentum".
 */
export function loadV3UniverseStats(opts = {}) {
  const filePath = opts.filePath || V3_UNIVERSE_STATS_PATH;
  if (!fs.existsSync(filePath)) {
    console.warn(
      `[v3-universe-stats] ${path.relative(ROOT, filePath)} missing — ` +
        `V3 momentum percentiles will be imputed (run the SWS refresh pipeline)`,
    );
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`[v3-universe-stats] unparseable, imputing momentum: ${err.message}`);
    return null;
  }
  if (!Array.isArray(parsed.r1m) || !Array.isArray(parsed.r3m) || !Array.isArray(parsed.r1y)) {
    console.warn(`[v3-universe-stats] missing r1m/r3m/r1y arrays — imputing momentum`);
    return null;
  }

  // Staleness is a warning, not a hard fail — stale percentile bands
  // still beat a flat 50th-percentile impute, and the predictor's V3
  // components don't read momentum at all.
  if (parsed.generated_at) {
    const ageDays = (Date.now() - new Date(parsed.generated_at).getTime()) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > STALE_AFTER_DAYS) {
      console.warn(
        `[v3-universe-stats] ${ageDays.toFixed(1)}d old — re-run the SWS refresh pipeline`,
      );
    }
  }

  return { r1m: parsed.r1m, r3m: parsed.r3m, r1y: parsed.r1y };
}
