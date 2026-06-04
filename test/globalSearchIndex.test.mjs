import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dedupeGlobalSearchResults,
  hasIndiaSearchResult,
  searchSwsMarkets,
} from "../services/globalSearchIndex.js";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("✓", name);
  } catch (err) {
    fail++;
    console.log("✗", name, "→", err.message);
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "global-search-index-"));
writeJson(path.join(root, "data/sws/sws-scored-universe.json"), {
  stocks: [
    { ticker: "CHENNPETRO", name: "Chennai Petroleum Corporation Limited", sector: "Energy", v4_score_100: 84.7, v4_verdict: "TOP_PICK" },
    { ticker: "RELIANCE", name: "Reliance Industries", sector: "Energy", v4_score_100: 50, v4_verdict: "STRONG" },
  ],
});
writeJson(path.join(root, "data/sws-us/sws-scored-universe.json"), {
  currency: "USD",
  stocks: [
    { ticker: "AAPL", name: "Apple Inc.", sector: "Technology", v4_score_100: 71, v4_verdict: "TOP_PICK", currency: "USD" },
    { ticker: "AAP", name: "Advance Auto Parts", sector: "Retail", v4_score_100: 20, v4_verdict: "WATCH", currency: "USD" },
  ],
});
writeJson(path.join(root, "data/sws-kr/sws-scored-universe.json"), {
  currency: "KRW",
  stocks: [
    { ticker: "q500036.KS", name: "Shinhan Financial Group Co., Ltd.", sector: "Financials", v4_score_100: 44, currency: "KRW" },
    { ticker: "0001a0.KQ", name: "Deokyang Energen Corporation", sector: "Materials", v4_score_100: 35, currency: "KRW" },
  ],
});
writeJson(path.join(root, "data/sws-tw/sws-scored-universe.json"), {
  currency: "TWD",
  stocks: [
    { ticker: "01001t.TW", name: "Fubon No.1 Real Estate Investment Trust", sector: "Real Estate", v4_score_100: 9, currency: "TWD" },
  ],
});

check("India SWS row emits NSE-style symbol", () => {
  const [row] = searchSwsMarkets("chennpetro", { root });
  assert.equal(row.market, "india");
  assert.equal(row.ticker, "CHENNPETRO");
  assert.equal(row.symbol, "CHENNPETRO.NS");
  assert.equal(row.source, "sws");
});

check("US exact ticker ranks above weaker ticker prefix matches", () => {
  const rows = searchSwsMarkets("aapl", { root });
  assert.equal(rows[0].market, "us");
  assert.equal(rows[0].ticker, "AAPL");
});

check("KR lowercase canonical ticker is preserved", () => {
  const [row] = searchSwsMarkets("Q500036", { root });
  assert.equal(row.market, "kr");
  assert.equal(row.ticker, "q500036.KS");
  assert.equal(row.symbol, "q500036.KS");
});

check("TW lowercase canonical ticker is preserved", () => {
  const [row] = searchSwsMarkets("01001T", { root });
  assert.equal(row.market, "tw");
  assert.equal(row.ticker, "01001t.TW");
});

check("missing market files fail open", () => {
  const partialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "global-search-index-partial-"));
  writeJson(path.join(partialRoot, "data/sws-us/sws-scored-universe.json"), {
    stocks: [{ ticker: "MSFT", name: "Microsoft Corporation", sector: "Technology" }],
  });
  const rows = searchSwsMarkets("msft", { root: partialRoot });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "MSFT");
});

check("global dedup is market-aware", () => {
  const rows = dedupeGlobalSearchResults([
    { market: "india", symbol: "ABC.NS", ticker: "ABC" },
    { market: "india", symbol: "ABC.BO", ticker: "ABC" },
    { market: "us", symbol: "ABC", ticker: "ABC" },
  ]);
  assert.deepEqual(rows.map((r) => `${r.market}:${r.symbol}`), ["india:ABC.NS", "us:ABC"]);
});

check("Yahoo fallback predicate is India-scoped", () => {
  assert.equal(hasIndiaSearchResult([{ market: "us", ticker: "AAPL" }]), false);
  assert.equal(hasIndiaSearchResult([{ market: "india", ticker: "RELIANCE" }]), true);
});

if (fail) {
  console.error(`\n${fail} global search index test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} global search index tests passed`);
