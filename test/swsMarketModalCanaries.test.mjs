import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractMemberFromTarball } from "../services/swsDal/deepTarball.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXTRACT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sws-modal-canaries-"));

const MARKET_CANARIES = {
  us: ["ZVRA", "FSM", "TOYO", "IMPP"],
  kr: ["000660.KS", "071970.KS", "482630.KQ"],
  tw: ["2451.TW", "6669.TW", "3189.TW"],
};

function readCanaryDeep(market, ticker) {
  const dataDir = path.join(REPO_ROOT, "data", `sws-${market}`);
  const tarballPath = path.join(dataDir, `deep-${market}.tar.gz`);
  const extractBase = path.join(EXTRACT_ROOT, market);
  const extracted = extractMemberFromTarball({
    tarballPath,
    extractBase,
    member: `deep/${ticker}.json`,
  });
  assert.ok(extracted, `${market} tarball contains ${ticker}`);
  return JSON.parse(fs.readFileSync(extracted, "utf8"));
}

for (const [market, tickers] of Object.entries(MARKET_CANARIES)) {
  test(`${market.toUpperCase()} deployable deep tarball carries modal rewards and news canaries`, () => {
    for (const ticker of tickers) {
      const deep = readCanaryDeep(market, ticker);
      const news = Array.isArray(deep.news) ? deep.news : [];
      const rewards = Array.isArray(deep.overview?.rewards) ? deep.overview.rewards : [];
      const risks = Array.isArray(deep.overview?.risks) ? deep.overview.risks : [];

      assert.ok(news.length > 0, `${market} ${ticker} has SWS Recent News & Updates`);
      assert.ok(rewards.length > 0, `${market} ${ticker} has SWS rewards`);
      assert.ok(Array.isArray(risks), `${market} ${ticker} has a risks array, even when empty`);
      assert.ok(deep.sws_url || deep.overview?.sws_url, `${market} ${ticker} keeps source SWS URL`);

      const firstNews = news[0] || {};
      assert.ok(firstNews.title, `${market} ${ticker} news item has title`);
      assert.ok(firstNews.date, `${market} ${ticker} news item has date`);
    }
  });
}
