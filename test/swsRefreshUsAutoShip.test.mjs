import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/sws-refresh-us.sh", "utf8");

test("US SWS refresh auto-ships only full successful data runs", () => {
  assert.match(script, /SWS_US_AUTO_PR:-1/);
  assert.match(script, /SWS_US_AUTO_MERGE:-1/);
  assert.match(script, /\[ -z "\$\{SWS_SCRAPE_LIMIT:-\}" \]/);
  assert.match(script, /\[ "\$\{FAIL\}" -eq 0 \]/);
  assert.match(script, /\[ "\$\{SCRAPE_SKIPPED\}" != "true" \]/);
  assert.match(script, /BASE_REF="origin\/main"/);
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
