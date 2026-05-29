import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

test("US manual refresh enriches news before packing the prod tarball", () => {
  const script = read("scripts/sws-refresh-us.sh");
  const newsIdx = script.indexOf("sws-news-scrape.mjs --market us");
  const packIdx = script.indexOf("packing deep-us.tar.gz");
  assert.ok(newsIdx > -1, "US news enrichment command is missing");
  assert.ok(packIdx > -1, "US tarball pack step is missing");
  assert.ok(newsIdx < packIdx, "US news enrichment must run before tarball packing");
  assert.match(script, /news enrichment failed — non-fatal/);
});

test("KR/TW manual refresh enriches news before packing region tarballs", () => {
  const script = read("scripts/sws-refresh-region.sh");
  const newsIdx = script.indexOf('sws-news-scrape.mjs --market "${CODE}"');
  const packIdx = script.indexOf('packing deep-${CODE}.tar.gz');
  assert.ok(newsIdx > -1, "region news enrichment command is missing");
  assert.ok(packIdx > -1, "region tarball pack step is missing");
  assert.ok(newsIdx < packIdx, "region news enrichment must run before tarball packing");
  assert.match(script, /news enrichment failed — non-fatal/);
});

test("nightly launchd path runs India, US, KR, and TW news non-fatally", () => {
  const nightly = read("scripts/sws-nightly.sh");
  const inIdx = nightly.indexOf("run_market_news_refresh in");
  const usIdx = nightly.indexOf("run_market_news_refresh us");
  const krIdx = nightly.indexOf("run_market_news_refresh kr");
  const twIdx = nightly.indexOf("run_market_news_refresh tw");
  assert.ok(inIdx > -1 && usIdx > inIdx && krIdx > usIdx && twIdx > krIdx);
  assert.match(nightly, /extract_regional_deep_from_tarball/);
  assert.match(nightly, /pack_regional_deep_tarball/);
  assert.match(nightly, /\$\{label\} news refresh failed — non-fatal/);

  for (const fp of [
    "data/sws-us/deep-us.tar.gz",
    "data/sws-kr/deep-kr.tar.gz",
    "data/sws-tw/deep-tw.tar.gz",
  ]) {
    assert.ok(nightly.includes(fp), `${fp} must be checked/staged by nightly`);
  }
});

