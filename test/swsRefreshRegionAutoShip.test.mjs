import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/sws-refresh-region.sh", "utf8");
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

test("regional SWS refresh auto-ships full successful KR/TW runs through the shared helper", () => {
  assert.match(autoShip, /auto_pr_var="SWS_\$\{market_upper\}_AUTO_PR"/);
  assert.match(autoShip, /auto_merge_var="SWS_\$\{market_upper\}_AUTO_MERGE"/);
  assert.match(autoShip, /SWS_SCRAPE_LIMIT/);
  assert.match(autoShip, /SWS_SHIP_FAILED_SHARDS/);
  assert.match(autoShip, /SWS_SHIP_SCRAPE_SKIPPED/);
  assert.match(autoShip, /worktree add -B "\$\{branch\}" "\$\{tmpdir\}" origin\/main/);
  assert.ok(script.includes('SWS_SHIP_FAILED_SHARDS="$((FAIL + QUALITY_GATE_FAILED))"'));
});

test("regional SWS refresh orders news, tarball, quality counters, gate, and auto-ship", () => {
  assertOrder(script, [
    ["parse", "sws-api-parser-region.mjs"],
    ["score", "sws-scoring-region.mjs"],
    ["news", 'sws-news-sharded.sh "${CODE}"'],
    ["pack tarball", 'tar -czf "${DATA_DIR}/deep-${CODE}.tar.gz"'],
    ["quality summary", "sws-market-quality-summary.mjs"],
    ["last-refresh counters", "writeFileSync(cfg.PATHS.lastRefresh"],
    ["quality gate", "sws-market-quality-gate.mjs"],
    ["auto-ship", "sws_auto_ship_market"],
  ]);
  assert.ok(script.includes('--market "${CODE}"'));
  assert.ok(script.includes('--summary "${QUALITY_SUMMARY_TMP}"'));
  assert.ok(script.includes("...quality"));
});

test("regional SWS refresh stages only deployable region data artifacts", () => {
  for (const path of [
    '"${DATA_DIR}/deep-${CODE}.tar.gz"',
    '"${DATA_DIR}/last-refresh.json"',
    '"${DATA_DIR}/picks-latest.json"',
    '"${DATA_DIR}/sws-scored-universe.json"',
    '"${DATA_DIR}/v3-universe-stats.json"',
  ]) {
    assert.ok(script.includes(path), `expected script to stage ${path}`);
  }

  assert.doesNotMatch(script, /git (?:-C "\$\{AUTO_WT\}" )?add\s+data\/catalysts/);
  assert.doesNotMatch(script, /git (?:-C "\$\{AUTO_WT\}" )?add\s+data\/risk-lab/);
  assert.doesNotMatch(script, /git (?:-C "\$\{AUTO_WT\}" )?add\s+data\/sws-us/);
});

test("regional SWS refresh keeps market-specific minimum scored count gates", () => {
  assert.match(script, /kr\) MIN_SCORED=2000/);
  assert.match(script, /tw\) MIN_SCORED=1800/);
});
