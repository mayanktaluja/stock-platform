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

test("coverage shards partition displayed tickers without overlap", () => {
  seedMarket("tw", {
    universe: [
      { ticker: "2330.TW", name: "TSMC", sector: "semiconductors", sws_url: "https://simplywall.st/stocks/tw/semiconductors/twse-2330/taiwan-semiconductor-shares" },
      { ticker: "2317.TW", name: "Hon Hai", sector: "tech", sws_url: "https://simplywall.st/stocks/tw/tech/twse-2317/hon-hai-shares" },
      { ticker: "2454.TW", name: "MediaTek", sector: "semiconductors", sws_url: "https://simplywall.st/stocks/tw/semiconductors/twse-2454/mediatek-shares" },
      { ticker: "2412.TW", name: "Chunghwa", sector: "telecom", sws_url: "https://simplywall.st/stocks/tw/telecom/twse-2412/chunghwa-telecom-shares" },
      { ticker: "6643.TWO", name: "M31", sector: "semiconductors", sws_url: "https://simplywall.st/stocks/tw/semiconductors/tpex-6643/m31-shares" },
    ],
    sections: {
      top_ranked_30_v3: [{ ticker: "2330.TW" }, { ticker: "2317.TW" }, { ticker: "2454.TW" }],
      deep_value: [{ ticker: "2412.TW" }, { ticker: "6643.TWO" }],
    },
  });

  const cfg = mod.makeNewsMarketConfig("tw");
  const coverage = mod.buildCoverageList({}, cfg);
  const shard1 = mod.shardCoverageList(coverage, { shardId: 1, shardCount: 3 }).map((s) => s.ticker);
  const shard2 = mod.shardCoverageList(coverage, { shardId: 2, shardCount: 3 }).map((s) => s.ticker);
  const shard3 = mod.shardCoverageList(coverage, { shardId: 3, shardCount: 3 }).map((s) => s.ticker);
  assert.deepEqual([...shard1, ...shard2, ...shard3].sort(), coverage.map((s) => s.ticker).sort());
  assert.equal(new Set([...shard1, ...shard2, ...shard3]).size, coverage.length);
  assert.deepEqual(shard1, ["2317.TW", "2454.TW"]);
  assert.deepEqual(shard2, ["2330.TW", "6643.TWO"]);
  assert.deepEqual(shard3, ["2412.TW"]);
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

test("sharded aggregate merge writes canonical news-latest", () => {
  const dir = seedMarket("us", {
    universe: [],
    sections: {},
  });
  const cfg = mod.makeNewsMarketConfig("us");
  writeJson(mod.newsLatestPathForRun(cfg, { shardId: 1, shardCount: 2 }), {
    generated_at: "2026-05-30T00:00:00.000Z",
    coverage_count: 2,
    items: [
      { ticker: "AAPL", date: "2026-05-29T00:00:00.000Z", title: "Apple headline" },
    ],
  });
  writeJson(mod.newsLatestPathForRun(cfg, { shardId: 2, shardCount: 2 }), {
    generated_at: "2026-05-30T00:00:00.000Z",
    coverage_count: 1,
    items: [
      { ticker: "MSFT", date: "2026-05-28T00:00:00.000Z", title: "Microsoft headline" },
      { ticker: "AAPL", date: "2026-05-29T00:00:00.000Z", title: "Apple headline" },
    ],
  });
  writeJson(mod.progressPathForRun(cfg, { shardId: 1, shardCount: 2 }), { done_count: 2, failed: [] });
  writeJson(mod.progressPathForRun(cfg, { shardId: 2, shardCount: 2 }), { done_count: 1, failed: [{ ticker: "BAD" }] });

  const merged = mod.mergeShardAggregates(cfg, 2);
  assert.equal(merged.coverage_count, 3);
  assert.equal(merged.items_count, 2);
  assert.deepEqual(merged.items.map((i) => i.ticker), ["AAPL", "MSFT"]);

  const canonical = JSON.parse(fs.readFileSync(path.join(dir, "news-latest.json"), "utf8"));
  assert.equal(canonical.shard_count, 2);
  assert.equal(canonical.items_count, 2);
  const progress = JSON.parse(fs.readFileSync(path.join(dir, "news-progress.json"), "utf8"));
  assert.equal(progress.done_count, 3);
  assert.equal(progress.failed_count, 1);
});
