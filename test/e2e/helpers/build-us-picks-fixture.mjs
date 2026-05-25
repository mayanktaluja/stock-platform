// Build a small, deterministic US picks fixture WITHOUT a live SWS scrape.
//
// Writes ~12 synthetic US deep stocks (parser-output shape) to
// data/sws-us/deep/, then runs the real US batch scorer (runFullScoringUS) to
// produce data/sws-us/{picks-latest,sws-scored-universe,v3-universe-stats}.json.
// This unblocks the route/UI/e2e work before the real (multi-hour, live-account)
// scrape, and exercises runFullScoringUS end-to-end on controlled inputs.
//
// The fixture spans every leaderboard section + the negative/null edge cases US
// data hits hard: a dividend payer, a small cap, an unprofitable name with no
// analyst FV, a junk-FV name (price ≫ FV), a dotted-class ticker, a name priced
// above FV (negative upside), and a sub-$50M name that must NOT make the top 30.
//
// Run: node test/e2e/helpers/build-us-picks-fixture.mjs
// (also invoked by the test:e2e npm script before Playwright runs)

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../scripts/sws-config-us.mjs";
import { runFullScoringUS } from "../../../scripts/sws-scoring-us.mjs";
import {
  MARKET_FUNDAMENTALS_FILE,
  MARKET_FUNDAMENTALS_SCHEMA_VERSION,
} from "../../../services/swsMarketFundamentals.js";

// Build a parser-shaped deep stock. snowflake_total is derived; upside is
// derived from price/FV when both are present (mirrors the parser).
function makeDeep(o) {
  const sn = o.snowflake || { financial_health: 4, future: 4, valuation: 4, past: 4, dividends: 3 };
  const snowflake = {
    financial_health: sn.financial_health ?? 0,
    future: sn.future ?? 0,
    valuation: sn.valuation ?? 0,
    past: sn.past ?? 0,
    dividends: sn.dividends ?? 0,
    // long-form + native aliases the parser emits
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
  return {
    ticker: o.ticker,
    name: o.name,
    sector: o.sector || "tech",
    currency: "USD",
    sws_url: `https://simplywall.st/stocks/us/${o.sector || "tech"}/nasdaq-${o.ticker.toLowerCase()}/${o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
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
      multiples: o.multiples || { pe: 24, pb: 5, ps: 6, ev_ebitda: 18 },
      dividend: o.dividend || { yield_pct: 0.6, payout_pct: 20 },
      rewards: o.rewards || [],
      risks: o.risks || [],
      next_earnings_date: null,
      recent_news_count: o.news ? o.news.length : 0,
      last_quarter_result: null,
    },
    ownership: { top_holders: [], insider_ownership_pct: null, insider_activity: null },
    dividend: o.dividend || { yield_pct: 0.6, payout_pct: 20, listing_currency: "USD" },
    news: o.news || [],
    _api_raw_path: `data/sws-us/deep-api/${o.ticker}.json`,
  };
}

const STOCKS = [
  { ticker: "AAPL", name: "Apple", mcap: 3.2e12, price: 220, fv: 250,
    snowflake: { financial_health: 5, future: 4, valuation: 3, past: 6, dividends: 2 },
    rewards: ["Trading at 12% below estimated fair value"], risks: [] },
  { ticker: "MSFT", name: "Microsoft", mcap: 3.0e12, price: 420, fv: 500,
    snowflake: { financial_health: 6, future: 5, valuation: 4, past: 6, dividends: 3 },
    rewards: ["Earnings are forecast to grow 14% per year"], risks: [] },
  { ticker: "NVDA", name: "NVIDIA", mcap: 2.8e12, price: 130, fv: 140,
    snowflake: { financial_health: 6, future: 6, valuation: 2, past: 6, dividends: 1 },
    returns: { "1M": 12, "3M": 25, "1Y": 180, "5Y": 2200 }, netMargin: 48, risks: ["Significant insider selling over the past 3 months"] },
  { ticker: "JPM", name: "JPMorgan Chase", sector: "banks", mcap: 6.0e11, price: 210, fv: 230,
    snowflake: { financial_health: 4, future: 3, valuation: 4, past: 5, dividends: 5 },
    dividend: { yield_pct: 2.3, payout_pct: 28, listing_currency: "USD" } },
  { ticker: "KO", name: "Coca-Cola", sector: "food-beverage-tobacco", mcap: 2.6e11, price: 62, fv: 70,
    snowflake: { financial_health: 4, future: 3, valuation: 4, past: 5, dividends: 6 },
    dividend: { yield_pct: 3.1, payout_pct: 68, listing_currency: "USD" }, rewards: ["Pays a reliable dividend of 3.1%"] },
  { ticker: "CELH", name: "Celsius Holdings", sector: "food-beverage-tobacco", mcap: 1.4e9, price: 30, fv: 42,
    snowflake: { financial_health: 6, future: 5, valuation: 5, past: 6, dividends: 0 },
    returns: { "1M": 8, "3M": 18, "1Y": 35, "5Y": 900 }, netMargin: 14 },
  { ticker: "RIVN", name: "Rivian Automotive", sector: "automobiles", mcap: 1.3e10, price: 13, fv: null,
    snowflake: { financial_health: 3, future: 4, valuation: 3, past: 1, dividends: 0 },
    returns: { "1M": -5, "3M": -12, "1Y": -30 }, netMargin: -110,
    multiples: { pe: null, pb: 1.4, ps: 2.1, ev_ebitda: null }, risks: ["Currently unprofitable", "Has less than a year of cash runway"] },
  { ticker: "JNKCO", name: "Junk Data Co", sector: "diversified-financials", mcap: 8e8, price: 100, fv: 900, upside: 800,
    snowflake: { financial_health: 2, future: 2, valuation: 6, past: 2, dividends: 0 } },
  { ticker: "BRK.B", name: "Berkshire Hathaway", sector: "insurance", mcap: 9.0e11, price: 460, fv: 500,
    snowflake: { financial_health: 6, future: 3, valuation: 4, past: 5, dividends: 0 } },
  { ticker: "XYZ", name: "Overvalued Inc", sector: "tech", mcap: 4e10, price: 200, fv: 140, upside: -30,
    snowflake: { financial_health: 3, future: 2, valuation: 1, past: 4, dividends: 0 },
    returns: { "1M": -2, "3M": 5, "1Y": 40 } },
  { ticker: "TINYCO", name: "Tiny Micro Co", sector: "tech", mcap: 4e7, price: 5, fv: 8,
    snowflake: { financial_health: 4, future: 4, valuation: 5, past: 3, dividends: 0 } },
  { ticker: "GROWTH", name: "Quality Growth Co", sector: "tech", mcap: 8e10, price: 80, fv: 110,
    snowflake: { financial_health: 6, future: 6, valuation: 4, past: 5, dividends: 1 },
    returns: { "1M": 6, "3M": 14, "1Y": 45, "5Y": 400 }, rewards: ["Earnings are forecast to grow 22% per year"] },
];

function makeFallbackFundamentals(spec) {
  return {
    source: "yahoo-finance2",
    ticker: spec.ticker,
    yahoo_symbol: spec.ticker === "BRK.B" ? "BRK-B" : spec.ticker,
    fetched_at: new Date().toISOString(),
    pe: 31.2,
    forward_pe: 24.6,
    pb: 6.4,
    ps: 7.8,
    ev_ebitda: 18.4,
    peg_ratio: 1.91,
    eps: 7.25,
    roe_pct: 28.4,
    roa_pct: 13.7,
    debt_to_equity_pct: 42.0,
    current_ratio: 2.15,
    interest_cover_x: 14.8,
    net_margin_pct: 21.5,
    gross_margin_pct: 45.6,
    operating_margin_pct: 29.7,
    revenue_growth_pct: 8.9,
    earnings_growth_yoy_pct: 12.4,
    beta: 1.26,
    dividend_yield_pct: 0.72,
    payout_pct: 18.0,
    annual_dividend: 1.04,
    latest_revenue: 1.2e11,
    latest_net_income: 2.6e10,
    total_debt: 9.0e10,
    total_cash: 6.0e10,
    net_cash: -3.0e10,
    week52_low_inr: 180,
    week52_high_inr: 260,
  };
}

function writeFallbackFundamentals(stocks) {
  const records = {};
  for (const spec of stocks) records[spec.ticker] = makeFallbackFundamentals(spec);
  fs.writeFileSync(path.join(PATHS.dataDir, MARKET_FUNDAMENTALS_FILE), JSON.stringify({
    schema_version: MARKET_FUNDAMENTALS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    region: "US",
    currency: "USD",
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
  fs.mkdirSync(PATHS.deepDir, { recursive: true });
  for (const spec of STOCKS) {
    const deep = makeDeep(spec);
    fs.writeFileSync(path.join(PATHS.deepDir, `${spec.ticker}.json`), JSON.stringify(deep, null, 2));
  }
  writeFallbackFundamentals(STOCKS);
  const out = runFullScoringUS();
  console.log(`[us-fixture] wrote ${STOCKS.length} synthetic deep stocks → scored ${out.scored_count}`);
  console.log(`[us-fixture] wrote ${MARKET_FUNDAMENTALS_FILE} fallback metrics`);
  console.log(`[us-fixture] picks-latest.json sections:`);
  for (const [k, v] of Object.entries(out.sections)) console.log(`  ${k}: ${v.length}`);
}

main();
