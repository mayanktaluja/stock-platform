// US batch scorer — the US fork of scripts/sws-scoring.mjs.
//
// Isolation: the India batch scorer is NEVER edited. The pure scoring MATH and
// the FV-reconcile / card / momentum-coverage helpers are imported from it
// verbatim, so US and India scores + card shapes stay aligned. Only the
// region-coupled pieces are re-implemented here:
//   - categoriseStockUS / buildLeaderboardUS: USD market-cap gates (vs ₹), the
//     pure-numeric (BSE) ticker filter dropped, and no `avoid` section.
//   - scoreStockUS: surveillance explicitly off (no NSE GSM/ASM for US).
//   - usCardFields: India card + a `currency` field so the renderer formats $.
//   - runFullScoringUS: writes the data/sws-us/ namespace.
//
// CLI:
//   node scripts/sws-scoring-us.mjs            # score all of data/sws-us/deep → picks-latest.json
//   node scripts/sws-scoring-us.mjs AAPL       # score one stock, print result

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./sws-config-us.mjs";
import {
  computeCompositeScore,
  verdictFromScore,
  computeV2Score,
  pickCardFields,
  buildUniverseStats,
  buildMomentumCoverageReport,
  collectExcludedForMomentum,
  buildRegulatoryFlags,
  buildRiskOverlay,
  buildCanonicalScore,
  PICKS_SCHEMA_VERSION,
  PICKS_SCORING_VERSION,
} from "./sws-scoring.mjs";
import { computeV4Score, verdictV4FromScore, buildFvCompositeIndustryAverages } from "./swsScoringV4.mjs";
import { buildFvUpsideBenchmark } from "../services/scoring/fvUpsideRelative.js";
import { reconcileFairValue, withReconciledFairValue } from "../services/fvReconciliation.js";

const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function writeJsonAtomic(filePath, value) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

// US market-cap gates (USD), replacing India's ₹ thresholds.
export const MIN_MCAP_USD = 50_000_000; // $50M floor — drops micro shells / dead SPACs
export const SMALLCAP_CEILING_USD = 2_000_000_000; // $2B — standard US small-cap line

// Faithful copy of sws-scoring.mjs::categoriseStock with the two ₹ market-cap
// gates swapped for USD (market_cap_inr holds the native USD value) and the
// insider-buy count inlined. Everything else is currency-agnostic.
export function categoriseStockUS(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const v4Verdict = stock.v4_verdict || "WATCH";
  const upsideRaw = num(ov.upside_pct, null);
  const upside = upsideRaw != null ? upsideRaw : 0;
  const hasUpside = upsideRaw != null;
  const ret1y = num((ov.returns_pct || {})["1Y"], null);
  const ret3m = num((ov.returns_pct || {})["3M"], null);
  const valSnow = num(sn.valuation ?? sn.value, 0);
  const futureSnow = num(sn.future ?? sn.future_growth, 0);
  const healthSnow = num(sn.financial_health ?? sn.health, 0);
  const divSnow = num(sn.dividends ?? sn.dividend, 0);
  const snowTotal = num(ov.snowflake_total, 0);
  const divYield = num(ov.dividend?.yield_pct, 0);
  const divPayout = num(ov.dividend?.payout_pct, 100);
  const mcap = num(ov.market_cap_inr, 0); // native USD
  const insiderBuys = (ov.insider_activity || []).filter((x) => x?.direction === "buy").length;
  const nextEarnings = ov.next_earnings_date;

  const cats = [];

  if (v4Verdict === "TOP_PICK" && valSnow >= 4 && hasUpside && upside >= 20) cats.push("deep_value");
  if (["TOP_PICK", "STRONG"].includes(v4Verdict) && healthSnow >= 5 && futureSnow >= 4) cats.push("quality_growth");
  const positiveMomentum = (ret1y != null && ret1y > 0) || (ret3m != null && ret3m > 5);
  if (["TOP_PICK", "STRONG", "ACCEPTABLE"].includes(v4Verdict) && positiveMomentum && hasUpside && upside >= 15 && futureSnow >= 3)
    cats.push("midterm");
  if (divSnow >= 5 && divPayout < 70 && divYield >= 1.5 && (upside >= 0 || valSnow >= 4)) cats.push("dividend_aristocrats");
  if (mcap > 0 && mcap < SMALLCAP_CEILING_USD && snowTotal >= 22 && hasUpside && upside >= 15) cats.push("smallcap_gems");
  if (insiderBuys >= 1) cats.push("insider_buying");
  if (nextEarnings) {
    const days = Math.ceil((new Date(nextEarnings + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 75) cats.push("upcoming_earnings");
  }
  return cats;
}

// Mirror of sws-scoring.mjs::scoreStock with US categorisation and surveillance
// explicitly off. `surveillanceFlag: false` short-circuits the
// `opts.surveillanceFlag ?? _getSurveillanceFlag(ticker)` fallback so the India
// surveillance table is never consulted for a US ticker (no concept; also
// avoids a freak ticker-string collision). Score MATH is the imported India
// implementation, so US/India scores stay aligned.
export function scoreStockUS(stock, opts = {}) {
  const scoringStock = withReconciledFairValue(stock);
  const sc = computeCompositeScore(scoringStock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);

  scoringStock.composite_score_100 = sc.composite_score_100;
  const v2 = computeV2Score(scoringStock, { surveillanceFlag: false });
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;

  // v4 — the platform's sole composite score (surveillance off for US).
  const v4 = computeV4Score(scoringStock, { ...opts, surveillanceFlag: false });
  stock.v4_score_100 = v4.v4_score_100;
  stock.v4_breakdown = v4.v4_breakdown;
  stock.v4_verdict = verdictV4FromScore(v4.v4_score_100);
  stock.regulatory_flags = buildRegulatoryFlags(stock);
  stock.risk_overlay = buildRiskOverlay(stock);
  stock.canonical_score = buildCanonicalScore(stock);

  scoringStock.v4_score_100 = v4.v4_score_100;
  scoringStock.v4_breakdown = v4.v4_breakdown;
  scoringStock.v4_verdict = stock.v4_verdict;
  stock.categories = categoriseStockUS(scoringStock);
  return stock;
}

// US card = India card (with FV reconcile) + explicit currency.
export function usCardFields(stock) {
  return {
    ...pickCardFields(stock),
    currency: stock.currency || stock.overview?.currency || "USD",
  };
}

// Slim search-index entry — mirror of sws-scoring.mjs::slimUniverseEntry
// (which is module-private there) + currency.
function slimUniverseEntryUS(stock, inSections) {
  const card = usCardFields(stock);
  return {
    ticker: card.ticker,
    name: card.name,
    sector: card.sector,
    sws_url: card.sws_url,
    currency: card.currency,
    score: card.score,
    v2_score: card.v2_score,
    v4_score: card.v4_score,
    v4_score_100: card.v4_score_100,
    v4_breakdown: card.v4_breakdown,
    v4_verdict: card.v4_verdict,
    canonical_score: card.canonical_score,
    score_model: card.score_model,
    score_source: card.score_source,
    regulatory_flags: card.regulatory_flags,
    risk_overlay: card.risk_overlay,
    composite_verdict: card.composite_verdict,
    valuation_band: card.valuation_band,
    verdict: card.verdict,
    snowflake_total: card.snowflake_total,
    current_price_inr: card.current_price_inr,
    fair_value_inr: card.fair_value_inr,
    upside_pct: card.upside_pct,
    fv_reconcile_reason: card.fv_reconcile_reason,
    fair_value_confidence: card.fair_value_confidence,
    fair_value_source: card.fair_value_source,
    upside_source: card.upside_source,
    market_cap_inr: card.market_cap_inr,
    one_line: card.one_line,
    data_freshness_at: card.data_freshness_at,
    data_completeness_pct: card.data_completeness_pct,
    in_sections: inSections,
  };
}

// Mirror of sws-scoring.mjs::buildLeaderboard: USD hygiene floor, no
// pure-numeric (BSE) ticker filter, US card fields, and no `avoid` section
// (matching the India tab's recent removal of the avoid list).
export function buildLeaderboardUS(scoredStocks) {
  const ordered = [...scoredStocks].sort((a, b) => (b.v4_score_100 || 0) - (a.v4_score_100 || 0));
  const hygiene = (s) => num(s.overview?.market_cap_inr, 0) >= MIN_MCAP_USD;

  const bestToBuy = ordered
    .filter((s) => (s.overview?.risks?.length ?? 0) === 0 && (s.overview?.snowflake_total ?? 0) >= 18)
    .slice(0, 25)
    .map(usCardFields);

  const cat = (key) => ordered.filter((s) => (s.categories || []).includes(key)).map(usCardFields);

  const upcoming = ordered
    .filter((s) => (s.categories || []).includes("upcoming_earnings"))
    .sort((a, b) =>
      (a.overview?.next_earnings_date || "9999").localeCompare(b.overview?.next_earnings_date || "9999"),
    )
    .map((s) => {
      const c = usCardFields(s);
      const d = s.overview?.next_earnings_date;
      c.days_until = d ? Math.ceil((new Date(d + "T00:00:00Z") - new Date()) / 86400000) : null;
      return c;
    });

  const top30 = ordered.filter(hygiene).slice(0, 30).map(usCardFields);

  const fundamentalsSum = (s) => {
    const b = s.v4_breakdown || {};
    return (
      (b.pts_health || 0) +
      (b.pts_future || 0) +
      (b.pts_valuation || 0) +
      (b.pts_past || 0) +
      (b.pts_fv_total || 0)
    );
  };
  const bestFundamentals = ordered
    .filter(hygiene)
    .slice()
    .sort((a, b) => fundamentalsSum(b) - fundamentalsSum(a))
    .slice(0, 100)
    .map(usCardFields);

  return {
    top_ranked_30_v4: top30,
    // Temporary compatibility alias. New first-party readers use V4.
    top_ranked_30_v3: top30,
    best_to_buy_now: bestToBuy,
    deep_value: cat("deep_value"),
    quality_growth: cat("quality_growth"),
    best_fundamentals: bestFundamentals,
    midterm: cat("midterm"),
    dividend_aristocrats: cat("dividend_aristocrats"),
    smallcap_gems: cat("smallcap_gems"),
    insider_buying: cat("insider_buying"),
    upcoming_earnings: upcoming,
  };
}

export function runFullScoringUS() {
  const files = fs.readdirSync(PATHS.deepDir).filter((f) => f.endsWith(".json"));

  // Two-pass: v3 momentum percentiles need the full US universe distribution.
  const loaded = [];
  let failed = 0;
  for (const f of files) {
    try {
      loaded.push(JSON.parse(fs.readFileSync(path.join(PATHS.deepDir, f), "utf-8")));
    } catch (e) {
      failed++;
      console.error(`Failed to load ${f}: ${e.message}`);
    }
  }
  const universe = buildUniverseStats(loaded);
  // Relative FV-upside benchmark (PR #426/#431) — the US $50M floor excludes
  // shells/dead SPACs. Currency-neutral: floor + market_cap_inr both native USD.
  universe.fvBenchmark = buildFvUpsideBenchmark(
    loaded.map((s) => ({
      upside_pct: reconcileFairValue(s?.overview).upside_pct,
      market_cap_inr: s?.overview?.market_cap_inr,
    })),
    { microCapFloorInr: MIN_MCAP_USD },
  );
  universe.fvCompositeIndustryAverages = buildFvCompositeIndustryAverages(loaded, universe.fvBenchmark);

  const scored = [];
  for (const stock of loaded) {
    try {
      scored.push(scoreStockUS(stock, { universe }));
    } catch (e) {
      failed++;
      console.error(`Failed to score ${stock?.ticker || "?"}: ${e.message}`);
    }
  }
  const sections = buildLeaderboardUS(scored);

  const out = {
    schema_version: PICKS_SCHEMA_VERSION,
    scoring_version: PICKS_SCORING_VERSION,
    region: "US",
    currency: "USD",
    scanned_at: new Date().toISOString(),
    universe_size: scored.length + failed,
    scored_count: scored.length,
    failed_count: failed,
    sections,
  };
  fs.mkdirSync(path.dirname(PATHS.picksLatest), { recursive: true });
  writeJsonAtomic(PATHS.picksLatest, out);

  // Scored-universe index for the picks-tab global search.
  const tickerToSections = new Map();
  for (const [sectionKey, items] of Object.entries(sections)) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || !it.ticker) continue;
      if (!tickerToSections.has(it.ticker)) tickerToSections.set(it.ticker, []);
      tickerToSections.get(it.ticker).push(sectionKey);
    }
  }
  const universeStocks = scored.map((s) => slimUniverseEntryUS(s, tickerToSections.get(s.ticker) || []));
  writeJsonAtomic(PATHS.scoredUniverse, {
    generated_at: new Date().toISOString(),
    region: "US",
    currency: "USD",
    scored_count: universeStocks.length,
    stocks: universeStocks,
  });

  // v3 universe distribution (calibrated momentum percentiles) + coverage audit.
  const coverage = buildMomentumCoverageReport(loaded);
  const excludedForMomentum = collectExcludedForMomentum(loaded);
  const universeStatsPayload = {
    generated_at: new Date().toISOString(),
    region: "US",
    universe_size: universe.r1m.length,
    counts: { r1m: universe.r1m.length, r3m: universe.r3m.length, r1y: universe.r1y.length },
    fv_benchmark: universe.fvBenchmark,
    fv_composite_industry_averages: universe.fvCompositeIndustryAverages,
    momentum_coverage: coverage,
    excluded_for_momentum: excludedForMomentum,
    r1m: universe.r1m,
    r3m: universe.r3m,
    r1y: universe.r1y,
  };
  writeJsonAtomic(PATHS.v4Stats, universeStatsPayload);
  writeJsonAtomic(PATHS.v3Stats, universeStatsPayload);

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ticker = process.argv[2];
  if (ticker) {
    const fp = path.join(PATHS.deepDir, `${ticker}.json`);
    if (!fs.existsSync(fp)) {
      console.error(`No such stock file: ${fp}`);
      process.exit(1);
    }
    const stock = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const scored = scoreStockUS(stock);
    console.log(
      JSON.stringify(
        {
          ticker: scored.ticker,
          currency: scored.currency,
          composite_score_100: scored.composite_score_100,
          v4_score_100: scored.v4_score_100,
          v4_verdict: scored.v4_verdict,
          categories: scored.categories,
          breakdown_v4: scored.v4_breakdown,
        },
        null,
        2,
      ),
    );
  } else {
    const out = runFullScoringUS();
    console.log(`[scoring-us] scored ${out.scored_count} (${out.failed_count} failed). Wrote ${PATHS.picksLatest}`);
    for (const [k, v] of Object.entries(out.sections)) console.log(`  ${k}: ${v.length}`);
  }
}
