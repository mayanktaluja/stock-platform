import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sws-news-market-"));
process.env.SWS_REPO_ROOT_OVERRIDE = tmpRoot;

const mod = await import(`../scripts/sws-news-scrape.mjs?repo=${encodeURIComponent(tmpRoot)}`);

function writeJson(fp, value) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(value, null, 2));
}

function seedMarket(market, { universe, sections }) {
  const dir = market === "in" ? path.join(tmpRoot, "data", "sws") : path.join(tmpRoot, "data", `sws-${market}`);
  writeJson(path.join(dir, "universe.json"), universe);
  writeJson(path.join(dir, "picks-latest.json"), { sections });
  fs.mkdirSync(path.join(dir, "deep"), { recursive: true });
  return dir;
}

test("market config keeps India default and resolves regional paths", () => {
  const india = mod.makeNewsMarketConfig();
  assert.equal(india.market, "in");
  assert.equal(india.picksPath, path.join(tmpRoot, "data", "sws", "picks-latest.json"));
  assert.equal(india.includePortfolioWatchlist, true);

  const us = mod.makeNewsMarketConfig("us");
  assert.equal(us.market, "us");
  assert.equal(us.picksPath, path.join(tmpRoot, "data", "sws-us", "picks-latest.json"));
  assert.equal(us.includePortfolioWatchlist, false);

  const kr = mod.makeNewsMarketConfig("kr");
  assert.equal(kr.market, "kr");
  assert.equal(kr.deepDir, path.join(tmpRoot, "data", "sws-kr", "deep"));

  const tw = mod.makeNewsMarketConfig("tw");
  assert.equal(tw.market, "tw");
  assert.equal(tw.newsLatestPath, path.join(tmpRoot, "data", "sws-tw", "news-latest.json"));
});

test("regional coverage uses all displayed section cards and dedupes", () => {
  seedMarket("us", {
    universe: [
      { ticker: "AAPL", name: "Apple", sector: "tech", sws_url: "https://simplywall.st/stocks/us/tech/nasdaq-aapl/apple" },
      { ticker: "MSFT", name: "Microsoft", sector: "tech", sws_url: "https://simplywall.st/stocks/us/tech/nasdaq-msft/microsoft" },
      { ticker: "NVDA", name: "NVIDIA", sector: "semiconductors", sws_url: "https://simplywall.st/stocks/us/semiconductors/nasdaq-nvda/nvidia" },
    ],
    sections: {
      top_ranked_30_v3: [{ ticker: "MSFT" }, { ticker: "AAPL" }],
      deep_value: [{ ticker: "AAPL" }],
      quality_growth: [{ ticker: "NVDA" }],
    },
  });

  const cfg = mod.makeNewsMarketConfig("us");
  const coverage = mod.buildCoverageList({}, cfg);
  assert.deepEqual(coverage.map((s) => s.ticker), ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(coverage.map((s) => s.canonicalUrl), [
    "/stocks/us/tech/nasdaq-aapl/apple",
    "/stocks/us/tech/nasdaq-msft/microsoft",
    "/stocks/us/semiconductors/nasdaq-nvda/nvidia",
  ]);
});

test("merge updates only news fields on an existing deep brief", () => {
  const dir = seedMarket("kr", {
    universe: [],
    sections: {},
  });
  const deepPath = path.join(dir, "deep", "005930.KS.json");
  writeJson(deepPath, {
    ticker: "005930.KS",
    currency: "KRW",
    overview: {
      current_price_inr: 70000,
      fair_value_inr: 92000,
      recent_news_count: 0,
    },
    news: [{ title: "old", date: "2026-01-01T00:00:00.000Z" }],
  });

  const cfg = mod.makeNewsMarketConfig("kr");
  const news = [{ title: "Samsung Electronics updates guidance", date: "2026-05-28T00:00:00.000Z" }];
  assert.equal(mod.mergeParsedNewsIntoDeep(cfg, "005930.KS", news, 1), true);

  const updated = JSON.parse(fs.readFileSync(deepPath, "utf8"));
  assert.equal(updated.currency, "KRW");
  assert.equal(updated.overview.current_price_inr, 70000);
  assert.equal(updated.overview.fair_value_inr, 92000);
  assert.equal(updated.overview.recent_news_count, 1);
  assert.deepEqual(updated.news, news);
});

