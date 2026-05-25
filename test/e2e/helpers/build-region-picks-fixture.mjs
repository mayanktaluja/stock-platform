// Build a small, deterministic region (KR/TW) picks fixture WITHOUT a live SWS
// scrape — the generalization of build-us-picks-fixture.mjs.
//
// Writes ~11 synthetic deep stocks (parser-output shape, native currency values
// in the *_inr-named keys) to data/sws-<code>/deep/, then runs the real region
// batch scorer (runFullScoringRegion) to produce
// data/sws-<code>/{picks-latest,sws-scored-universe,v3-universe-stats}.json.
//
// Each region's fixture spans every leaderboard section + the negative/null edge
// cases: a dividend payer, a smallcap (under the native ceiling), an unprofitable
// name with no analyst FV, a junk-FV name (price ≫ FV), a name priced above FV
// (negative upside), and a sub-floor name that must NOT make the top 30. All
// tickers are dotted (005930.KS / 2330.TW) to exercise the no-pure-numeric path.
//
// Run: node test/e2e/helpers/build-region-picks-fixture.mjs --region kr
// (invoked by the test:e2e npm script for kr + tw before Playwright runs)

import fs from "node:fs";
import path from "node:path";
import { makeRegionConfig } from "../../../scripts/sws-config-region.mjs";
import { getRegion } from "../../../scripts/sws-regions.mjs";
import { runFullScoringRegion } from "../../../scripts/sws-scoring-region.mjs";
import {
  MARKET_FUNDAMENTALS_FILE,
  MARKET_FUNDAMENTALS_SCHEMA_VERSION,
} from "../../../services/swsMarketFundamentals.js";

const TOKEN_BY_SUFFIX = { ".KS": "kose", ".KQ": "kosdaq", ".TW": "twse", ".TWO": "tpex" };

function makeDeep(o, region) {
  const sn = o.snowflake || { financial_health: 4, future: 4, valuation: 4, past: 4, dividends: 3 };
  const snowflake = {
    financial_health: sn.financial_health ?? 0,
    future: sn.future ?? 0,
    valuation: sn.valuation ?? 0,
    past: sn.past ?? 0,
    dividends: sn.dividends ?? 0,
    future_growth: sn.future ?? 0,
    past_performance: sn.past ?? 0,
    value: sn.valuation ?? 0,
    health: sn.financial_health ?? 0,
    dividend: sn.dividends ?? 0,
  };
  const snowflake_total =
    snowflake.financial_health + snowflake.future + snowflake.valuation + snowflake.past + snowflake.dividends;
  const price = o.price ?? 100;
  const fv = o.fv === undefined ? null : o.fv;
  const upside = o.upside !== undefined ? o.upside : fv != null && price > 0 ? ((fv - price) / price) * 100 : null;
  const suffix = (o.ticker.match(/\.[A-Z]+$/) || ["."])[0];
  const token = TOKEN_BY_SUFFIX[suffix] || "kose";
  const slug = o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    ticker: o.ticker,
    name: o.name,
    sector: o.sector || "tech",
    currency: region.currencyIso,
    sws_url: `https://simplywall.st/stocks/${region.code}/${o.sector || "tech"}/${token}-${o.ticker.toLowerCase()}/${slug}-shares`,
    parsed_at: new Date().toISOString(),
    overview: {
      snowflake,
      snowflake_total,
      current_price_inr: price,
      fair_value_inr: fv,
      upside_pct: upside,
      market_cap_inr: o.mcap,
      net_margin_pct: o.netMargin ?? 12,
      returns_pct: o.returns || { "1M": 3, "3M": 8, "1Y": 20, "5Y": 90 },
      multiples: o.multiples || { pe: 18, pb: 2, ps: 3, ev_ebitda: 12 },
      dividend: o.dividend || { yield_pct: 0.6, payout_pct: 20 },
      rewards: o.rewards || [],
      risks: o.risks || [],
      next_earnings_date: null,
      recent_news_count: 0,
      last_quarter_result: null,
      currency: region.currencyIso,
    },
    ownership: { top_holders: [], insider_ownership_pct: null, insider_activity: null },
    dividend: o.dividend || { yield_pct: 0.6, payout_pct: 20, listing_currency: region.currencyIso },
    news: [],
    _api_raw_path: `data/sws-${region.code}/deep-api/${o.ticker}.json`,
  };
}

// Native-currency values: KR in KRW (floor ₩50B / ceiling ₩2T), TW in TWD
// (floor NT$1B / ceiling NT$60B).
const STOCKS_BY_REGION = {
  kr: [
    { ticker: "005930.KS", name: "Samsung Electronics", mcap: 4.0e14, price: 70000, fv: 92000,
      snowflake: { financial_health: 6, future: 4, valuation: 5, past: 6, dividends: 3 },
      rewards: ["Trading below estimated fair value"], risks: [] },
    { ticker: "000660.KS", name: "SK Hynix", sector: "semiconductors", mcap: 1.2e14, price: 180000, fv: 210000,
      snowflake: { financial_health: 5, future: 6, valuation: 4, past: 6, dividends: 2 },
      returns: { "1M": 9, "3M": 20, "1Y": 60 } },
    { ticker: "005380.KS", name: "Hyundai Motor", sector: "automobiles", mcap: 5.0e13, price: 250000, fv: 320000,
      snowflake: { financial_health: 5, future: 4, valuation: 5, past: 5, dividends: 6 },
      dividend: { yield_pct: 4.2, payout_pct: 30, listing_currency: "KRW" }, rewards: ["Pays a reliable dividend of 4.2%"] },
    { ticker: "068270.KQ", name: "Celltrion", sector: "pharmaceuticals-biotech", mcap: 4.0e13, price: 180000, fv: 230000,
      snowflake: { financial_health: 6, future: 5, valuation: 4, past: 5, dividends: 1 },
      returns: { "1M": 5, "3M": 12, "1Y": 30 }, rewards: ["Earnings are forecast to grow 18% per year"] },
    { ticker: "035720.KQ", name: "Kakao Smallcap", sector: "software", mcap: 9.0e11, price: 45000, fv: 60000,
      snowflake: { financial_health: 5, future: 6, valuation: 5, past: 4, dividends: 0 },
      returns: { "1M": 6, "3M": 15, "1Y": 28 } },
    { ticker: "900110.KS", name: "Unprofitable Holdings", sector: "diversified-financials", mcap: 8.0e11, price: 12000, fv: null,
      snowflake: { financial_health: 3, future: 4, valuation: 3, past: 1, dividends: 0 },
      returns: { "1M": -6, "3M": -14, "1Y": -32 }, netMargin: -110,
      multiples: { pe: null, pb: -1.6, ps: 2.1, ev_ebitda: null }, risks: ["Currently unprofitable", "Less than a year of cash runway"] },
    { ticker: "900220.KS", name: "Junk Value Co", sector: "materials", mcap: 6.0e11, price: 100000, fv: 900000, upside: 800,
      snowflake: { financial_health: 2, future: 2, valuation: 6, past: 2, dividends: 0 } },
    { ticker: "900330.KS", name: "Overvalued Co", sector: "tech", mcap: 7.0e11, price: 200000, fv: 140000, upside: -30,
      snowflake: { financial_health: 3, future: 2, valuation: 1, past: 4, dividends: 0 } },
    { ticker: "910110.KQ", name: "Tiny Micro Co", sector: "tech", mcap: 1.0e10, price: 5000, fv: 8000,
      snowflake: { financial_health: 4, future: 4, valuation: 5, past: 3, dividends: 0 } },
  ],
  tw: [
    { ticker: "2330.TW", name: "Taiwan Semiconductor", sector: "semiconductors", mcap: 1.5e13, price: 600, fv: 760,
      snowflake: { financial_health: 6, future: 6, valuation: 4, past: 6, dividends: 3 },
      rewards: ["Trading below estimated fair value"], risks: [] },
    { ticker: "2317.TW", name: "Hon Hai Precision", sector: "tech", mcap: 2.0e12, price: 100, fv: 130,
      snowflake: { financial_health: 5, future: 4, valuation: 5, past: 5, dividends: 4 },
      dividend: { yield_pct: 3.0, payout_pct: 55, listing_currency: "TWD" } },
    { ticker: "2454.TW", name: "MediaTek", sector: "semiconductors", mcap: 2.0e12, price: 1000, fv: 1250,
      snowflake: { financial_health: 6, future: 5, valuation: 4, past: 5, dividends: 2 },
      returns: { "1M": 7, "3M": 16, "1Y": 40 } },
    { ticker: "2412.TW", name: "Chunghwa Telecom", sector: "telecom", mcap: 9.0e11, price: 120, fv: 132,
      snowflake: { financial_health: 5, future: 3, valuation: 4, past: 5, dividends: 6 },
      dividend: { yield_pct: 4.1, payout_pct: 65, listing_currency: "TWD" }, rewards: ["Pays a reliable dividend of 4.1%"] },
    { ticker: "6643.TWO", name: "M31 Smallcap Tech", sector: "semiconductors", mcap: 3.0e10, price: 580, fv: 720,
      snowflake: { financial_health: 5, future: 6, valuation: 5, past: 5, dividends: 1 },
      returns: { "1M": 6, "3M": 14, "1Y": 26 } },
    { ticker: "9990.TW", name: "Unprofitable Inc", sector: "automobiles", mcap: 8.0e9, price: 30, fv: null,
      snowflake: { financial_health: 3, future: 4, valuation: 3, past: 1, dividends: 0 },
      returns: { "1M": -5, "3M": -12, "1Y": -28 }, netMargin: -95,
      multiples: { pe: null, pb: -1.2, ps: 1.9, ev_ebitda: null }, risks: ["Currently unprofitable", "Less than a year of cash runway"] },
    { ticker: "9991.TW", name: "Junk Value Corp", sector: "materials", mcap: 5.0e9, price: 100, fv: 900, upside: 800,
      snowflake: { financial_health: 2, future: 2, valuation: 6, past: 2, dividends: 0 } },
    { ticker: "9992.TW", name: "Overvalued Corp", sector: "tech", mcap: 6.0e9, price: 200, fv: 140, upside: -30,
      snowflake: { financial_health: 3, future: 2, valuation: 1, past: 4, dividends: 0 } },
    { ticker: "1111.TWO", name: "Tiny Micro Corp", sector: "tech", mcap: 5.0e8, price: 12, fv: 18,
      snowflake: { financial_health: 4, future: 4, valuation: 5, past: 3, dividends: 0 } },
  ],
};

function makeFallbackFundamentals(spec, region) {
  const isKr = region.code === "kr";
  return {
    source: "yahoo-finance2",
    ticker: spec.ticker,
    yahoo_symbol: spec.ticker,
    fetched_at: new Date().toISOString(),
    pe: isKr ? 14.8 : 19.6,
    forward_pe: isKr ? 11.2 : 15.4,
    pb: isKr ? 1.62 : 5.31,
    ps: isKr ? 2.4 : 7.1,
    ev_ebitda: isKr ? 8.9 : 12.8,
    peg_ratio: isKr ? 1.2 : 1.5,
    eps: isKr ? 7250 : 36.5,
    roe_pct: isKr ? 24.8 : 31.6,
    roa_pct: isKr ? 12.4 : 16.1,
    debt_to_equity_pct: isKr ? 31.5 : 18.4,
    current_ratio: isKr ? 1.84 : 2.51,
    interest_cover_x: isKr ? 18.6 : 42.3,
    net_margin_pct: isKr ? 18.7 : 43.2,
    gross_margin_pct: isKr ? 39.6 : 57.9,
    operating_margin_pct: isKr ? 24.9 : 49.1,
    revenue_growth_pct: isKr ? 9.8 : 12.6,
    earnings_growth_yoy_pct: isKr ? 14.2 : 18.9,
    beta: isKr ? 1.18 : 1.26,
    dividend_yield_pct: isKr ? 1.84 : 1.06,
    payout_pct: isKr ? 27.0 : 32.0,
    annual_dividend: isKr ? 1400 : 12.5,
    latest_revenue: isKr ? 1.2e14 : 2.2e12,
    latest_net_income: isKr ? 2.2e13 : 9.5e11,
    total_debt: isKr ? 2.4e13 : 4.1e11,
    total_cash: isKr ? 8.1e13 : 1.1e12,
    net_cash: isKr ? 5.7e13 : 6.9e11,
    week52_low_inr: isKr ? 55000 : 480,
    week52_high_inr: isKr ? 96000 : 880,
  };
}

function writeFallbackFundamentals(stocks, region, dataDir) {
  const records = {};
  for (const spec of stocks) records[spec.ticker] = makeFallbackFundamentals(spec, region);
  fs.writeFileSync(path.join(dataDir, MARKET_FUNDAMENTALS_FILE), JSON.stringify({
    schema_version: MARKET_FUNDAMENTALS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    region: region.code.toUpperCase(),
    currency: region.currencyIso,
    source: "yahoo-finance2",
    scope: "picks",
    ttl_days: 7,
    requested: stocks.length,
    refreshed: stocks.length,
    skipped: 0,
    failed: 0,
    stocks: records,
    failures: {},
  }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  const code = args.indexOf("--region") >= 0 ? args[args.indexOf("--region") + 1] : null;
  if (!code || !STOCKS_BY_REGION[code]) {
    console.error("usage: --region <kr|tw>");
    process.exit(2);
  }
  const region = getRegion(code);
  const cfg = makeRegionConfig(code);
  fs.mkdirSync(cfg.PATHS.deepDir, { recursive: true });
  const stocks = STOCKS_BY_REGION[code];
  for (const spec of stocks) {
    const deep = makeDeep(spec, region);
    fs.writeFileSync(path.join(cfg.PATHS.deepDir, `${spec.ticker}.json`), JSON.stringify(deep, null, 2));
  }
  writeFallbackFundamentals(stocks, region, cfg.PATHS.dataDir);
  const out = runFullScoringRegion(code);
  console.log(`[${code}-fixture] wrote ${stocks.length} synthetic deep stocks → scored ${out.scored_count}`);
  console.log(`[${code}-fixture] wrote ${MARKET_FUNDAMENTALS_FILE} fallback metrics`);
  for (const [k, v] of Object.entries(out.sections)) console.log(`  ${k}: ${v.length}`);
}

main();
