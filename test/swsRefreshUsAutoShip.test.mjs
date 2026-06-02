import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/sws-refresh-us.sh", "utf8");
const autoShip = readFileSync("scripts/sws-auto-ship.sh", "utf8");

function assertOrder(source, labels) {
  let last = -1;
  for (const [label, needle] of labels) {
    const idx = source.indexOf(needle);
    assert.notEqual(idx, -1, `missing ${label}: ${needle}`);
    assert.ok(idx > last, `${label} is out of order`);
    last = idx;
  }
}

test("US SWS refresh auto-ships only full successful data runs", () => {
  assert.match(autoShip, /auto_pr_var="SWS_\$\{market_upper\}_AUTO_PR"/);
  assert.match(autoShip, /auto_merge_var="SWS_\$\{market_upper\}_AUTO_MERGE"/);
  assert.match(autoShip, /SWS_SCRAPE_LIMIT/);
  assert.match(autoShip, /SWS_SHIP_FAILED_SHARDS/);
  assert.match(autoShip, /SWS_SHIP_SCRAPE_SKIPPED/);
  assert.match(autoShip, /worktree add -B "\$\{branch\}" "\$\{tmpdir\}" origin\/main/);
  assert.ok(script.includes('SWS_SHIP_FAILED_SHARDS="$((FAIL + QUALITY_GATE_FAILED))"'));
});

test("US SWS refresh orders news, tarball, quality counters, gate, and auto-ship", () => {
  assertOrder(script, [
    ["parse", "sws-api-parser-us.mjs"],
    ["score", "sws-scoring-us.mjs"],
    ["news", "sws-news-sharded.sh us"],
    ["pack tarball", 'tar -czf "${DATA_DIR}/deep-us.tar.gz"'],
    ["quality summary", "sws-market-quality-summary.mjs"],
    ["last-refresh counters", "writeFileSync(PATHS.lastRefresh"],
    ["quality gate", "sws-market-quality-gate.mjs"],
    ["auto-ship", "sws_auto_ship_market"],
  ]);
  assert.ok(script.includes('--summary "${QUALITY_SUMMARY_TMP}"'));
  assert.ok(script.includes("...quality"));
});

test("US SWS refresh stages only deployable US data artifacts", () => {
  for (const path of [
    '"${DATA_DIR}/deep-us.tar.gz"',
    '"${DATA_DIR}/last-refresh.json"',
    '"${DATA_DIR}/picks-latest.json"',
    '"${DATA_DIR}/sws-scored-universe.json"',
    '"${DATA_DIR}/v3-universe-stats.json"',
  ]) {
    assert.ok(script.includes(path), `expected script to stage ${path}`);
  }

  assert.doesNotMatch(script, /git add\s+data\/catalysts/);
  assert.doesNotMatch(script, /git add\s+data\/risk-lab/);
});
