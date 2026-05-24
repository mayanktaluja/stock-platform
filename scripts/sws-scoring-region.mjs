// Region batch scorer — the generalization of sws-scoring-us.mjs.
//
// Isolation: the India batch scorer (sws-scoring.mjs) is NEVER edited. The pure
// scoring MATH + FV-reconcile / card / momentum-coverage helpers are imported
// from it verbatim, so every region's scores + card shapes stay aligned with
// India + US. Only the region-coupled pieces are re-implemented here, all
// parametrized by a REGIONS entry:
//   - categoriseStockRegion / buildLeaderboardRegion: native market-cap gates
//     (region.mcapFloorNative / .smallcapCeilingNative), the pure-numeric (BSE)
//     ticker filter dropped, and no `avoid` section.
//   - scoreStockRegion: surveillance off (region.surveillanceEnabled === false).
//   - regionCardFields: India card + a `currency` field (region.currencyIso) so
//     the renderer formats ₩ / NT$ — the C1 belt to the parser's currency stamp.
//   - runFullScoringRegion: writes the data/sws-<code>/ namespace.
//
// CLI:
//   node scripts/sws-scoring-region.mjs --region kr            # score all of data/sws-kr/deep → picks-latest.json
//   node scripts/sws-scoring-region.mjs --region kr 005930.KS  # score one stock, print result

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRegionConfig } from "./sws-config-region.mjs";
import { getRegion } from "./sws-regions.mjs";
import {
  computeCompositeScore,
  verdictFromScore,
  computeV2Score,
  pickCardFields,
  buildUniverseStats,
  buildMomentumCoverageReport,
  collectExcludedForMomentum,
  PICKS_SCHEMA_VERSION,
  PICKS_SCORING_VERSION,
} from "./sws-scoring.mjs";
import { computeV4Score, verdictV4FromScore } from "./swsScoringV4.mjs";
import { buildFvUpsideBenchmark } from "../services/scoring/fvUpsideRelative.js";

const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function writeJsonAtomic(filePath, value) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

// Faithful copy of sws-scoring.mjs::categoriseStock with the ₹ market-cap gate
// swapped for the region's native ceiling (market_cap_inr holds the native value)
// and the insider-buy count inlined. Everything else is currency-agnostic.
export function categoriseStockRegion(stock, region) {
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
  const mcap = num(ov.market_cap_inr, 0); // native units
  const insiderBuys = (ov.insider_activity || []).filter((x) => x?.direction === "buy").length;
  const nextEarnings = ov.next_earnings_date;

  const cats = [];

  if (v4Verdict === "TOP_PICK" && valSnow >= 4 && hasUpside && upside >= 20) cats.push("deep_value");
  if (["TOP_PICK", "STRONG"].includes(v4Verdict) && healthSnow >= 5 && futureSnow >= 4) cats.push("quality_growth");
  const positiveMomentum = (ret1y != null && ret1y > 0) || (ret3m != null && ret3m > 5);
  if (
    ["TOP_PICK", "STRONG", "ACCEPTABLE"].includes(v4Verdict) &&
    positiveMomentum &&
    hasUpside &&
    upside >= 15 &&
    futureSnow >= 3
  )
    cats.push("midterm");
  if (divSnow >= 5 && divPayout < 70 && divYield >= 1.5 && (upside >= 0 || valSnow >= 4)) cats.push("dividend_aristocrats");
  if (mcap > 0 && mcap < region.smallcapCeilingNative && snowTotal >= 22 && hasUpside && upside >= 15)
    cats.push("smallcap_gems");
  if (insiderBuys >= 1) cats.push("insider_buying");
  if (nextEarnings) {
    const days = Math.ceil((new Date(nextEarnings + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 75) cats.push("upcoming_earnings");
  }
  return cats;
}

// Mirror of sws-scoring.mjs::scoreStock with region categorisation and surveillance
// driven by the region flag. `surveillanceFlag: false` short-circuits the India
// surveillance-table fallback so it is never consulted for a KR/TW ticker. Score
// MATH is the imported India implementation, so scores stay aligned.
export function scoreStockRegion(stock, region, opts = {}) {
  const sc = computeCompositeScore(stock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);

  const surveillanceFlag = region.surveillanceEnabled ? undefined : false;

  const v2 = computeV2Score(stock, { surveillanceFlag });
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;

  // v4 — the platform's sole composite score (region surveillance flag).
  const v4 = computeV4Score(stock, { ...opts, surveillanceFlag });
  stock.v4_score_100 = v4.v4_score_100;
  stock.v4_breakdown = v4.v4_breakdown;
  stock.v4_verdict = verdictV4FromScore(v4.v4_score_100);

  stock.categories = categoriseStockRegion(stock, region);
  return stock;
}

// Region card = India card (with FV reconcile) + explicit currency.
export function regionCardFields(stock, region) {
  return {
    ...pickCardFields(stock),
    currency: stock.currency || stock.overview?.currency || region.currencyIso,
  };
}

// Slim search-index entry — mirror of sws-scoring.mjs::slimUniverseEntry + currency.
function slimUniverseEntryRegion(stock, region, inSections) {
  const card = regionCardFields(stock, region);
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
    v4_verdict: card.v4_verdict,
    composite_verdict: card.composite_verdict,
    valuation_band: card.valuation_band,
    verdict: card.verdict,
    snowflake_total: card.snowflake_total,
    current_price_inr: card.current_price_inr,
    fair_value_inr: card.fair_value_inr,
    upside_pct: card.upside_pct,
    market_cap_inr: card.market_cap_inr,
    one_line: card.one_line,
    data_freshness_at: card.data_freshness_at,
    data_completeness_pct: card.data_completeness_pct,
    in_sections: inSections,
  };
}

// Mirror of sws-scoring.mjs::buildLeaderboard: native hygiene floor, NO pure-numeric
// (BSE) ticker filter, region card fields, and no `avoid` section.
export function buildLeaderboardRegion(scoredStocks, region) {
  const ordered = [...scoredStocks].sort((a, b) => (b.v4_score_100 || 0) - (a.v4_score_100 || 0));
  const hygiene = (s) => num(s.overview?.market_cap_inr, 0) >= region.mcapFloorNative;
  const card = (s) => regionCardFields(s, region);

  const bestToBuy = ordered
    .filter((s) => (s.overview?.risks?.length ?? 0) === 0 && (s.overview?.snowflake_total ?? 0) >= 18)
    .slice(0, 25)
    .map(card);

  const cat = (key) => ordered.filter((s) => (s.categories || []).includes(key)).map(card);

  const upcoming = ordered
    .filter((s) => (s.categories || []).includes("upcoming_earnings"))
    .sort((a, b) =>
      (a.overview?.next_earnings_date || "9999").localeCompare(b.overview?.next_earnings_date || "9999"),
    )
    .map((s) => {
      const c = card(s);
      const d = s.overview?.next_earnings_date;
      c.days_until = d ? Math.ceil((new Date(d + "T00:00:00Z") - new Date()) / 86400000) : null;
      return c;
    });

  const top30 = ordered.filter(hygiene).slice(0, 30).map(card);

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
    .map(card);

  return {
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

export function runFullScoringRegion(code) {
  const region = getRegion(code);
  const cfg = makeRegionConfig(code);
  const files = fs.readdirSync(cfg.PATHS.deepDir).filter((f) => f.endsWith(".json"));

  const loaded = [];
  let failed = 0;
  for (const f of files) {
    try {
      loaded.push(JSON.parse(fs.readFileSync(path.join(cfg.PATHS.deepDir, f), "utf-8")));
    } catch (e) {
      failed++;
      console.error(`Failed to load ${f}: ${e.message}`);
    }
  }
  const universe = buildUniverseStats(loaded);
  // Relative FV-upside benchmark (PR #426) — region-native market-cap floor
  // excludes micro-caps. Currency-neutral: floor + market_cap_inr both native.
  universe.fvBenchmark = buildFvUpsideBenchmark(
    loaded.map((s) => ({ upside_pct: s?.overview?.upside_pct, market_cap_inr: s?.overview?.market_cap_inr })),
    { microCapFloorInr: region.mcapFloorNative },
  );

  const scored = [];
  for (const stock of loaded) {
    try {
      scored.push(scoreStockRegion(stock, region, { universe }));
    } catch (e) {
      failed++;
      console.error(`Failed to score ${stock?.ticker || "?"}: ${e.message}`);
    }
  }
  const sections = buildLeaderboardRegion(scored, region);

  const out = {
    schema_version: PICKS_SCHEMA_VERSION,
    scoring_version: PICKS_SCORING_VERSION,
    region: region.code.toUpperCase(),
    currency: region.currencyIso,
    scanned_at: new Date().toISOString(),
    universe_size: scored.length + failed,
    scored_count: scored.length,
    failed_count: failed,
    sections,
  };
  fs.mkdirSync(path.dirname(cfg.PATHS.picksLatest), { recursive: true });
  writeJsonAtomic(cfg.PATHS.picksLatest, out);

  const tickerToSections = new Map();
  for (const [sectionKey, items] of Object.entries(sections)) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || !it.ticker) continue;
      if (!tickerToSections.has(it.ticker)) tickerToSections.set(it.ticker, []);
      tickerToSections.get(it.ticker).push(sectionKey);
    }
  }
  const universeStocks = scored.map((s) => slimUniverseEntryRegion(s, region, tickerToSections.get(s.ticker) || []));
  writeJsonAtomic(cfg.PATHS.scoredUniverse, {
    generated_at: new Date().toISOString(),
    region: region.code.toUpperCase(),
    currency: region.currencyIso,
    scored_count: universeStocks.length,
    stocks: universeStocks,
  });

  const coverage = buildMomentumCoverageReport(loaded);
  const excludedForMomentum = collectExcludedForMomentum(loaded);
  writeJsonAtomic(cfg.PATHS.v3Stats, {
    generated_at: new Date().toISOString(),
    region: region.code.toUpperCase(),
    universe_size: universe.r1m.length,
    counts: { r1m: universe.r1m.length, r3m: universe.r3m.length, r1y: universe.r1y.length },
    fv_benchmark: universe.fvBenchmark,
    momentum_coverage: coverage,
    excluded_for_momentum: excludedForMomentum,
    r1m: universe.r1m,
    r3m: universe.r3m,
    r1y: universe.r1y,
  });

  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const code = args.indexOf("--region") >= 0 ? args[args.indexOf("--region") + 1] : null;
  if (!code) {
    console.error("usage: --region <kr|tw> [TICKER]");
    process.exit(2);
  }
  const region = getRegion(code);
  const cfg = makeRegionConfig(code);
  const positionals = args.filter((a, i) => a !== "--region" && args[i - 1] !== "--region");
  const ticker = positionals[0];
  if (ticker) {
    const fp = path.join(cfg.PATHS.deepDir, `${ticker}.json`);
    if (!fs.existsSync(fp)) {
      console.error(`No such stock file: ${fp}`);
      process.exit(1);
    }
    const stock = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const scored = scoreStockRegion(stock, region);
    console.log(
      JSON.stringify(
        {
          ticker: scored.ticker,
          currency: scored.currency,
          composite_score_100: scored.composite_score_100,
          v4_score_100: scored.v4_score_100,
          v4_verdict: scored.v4_verdict,
          categories: scored.categories,
        },
        null,
        2,
      ),
    );
  } else {
    const out = runFullScoringRegion(code);
    console.log(`[scoring-${code}] scored ${out.scored_count} (${out.failed_count} failed). Wrote ${cfg.PATHS.picksLatest}`);
    for (const [k, v] of Object.entries(out.sections)) console.log(`  ${k}: ${v.length}`);
  }
}
