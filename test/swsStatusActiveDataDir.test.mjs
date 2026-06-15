import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/sws-status.sh", "utf8");

test("India SWS status resolves the active data dir from live process cwd", () => {
  assert.match(script, /process_cwd\(\)/);
  assert.match(script, /lsof -Fn -a -p "\$\{pid\}" -d cwd/);
  assert.match(script, /active_data_dir\(\)/);
  assert.match(script, /sws-api-scrape\\\.mjs\[\[:space:\]\]\+\[123\]/);
  assert.match(script, /scripts\/sws-refresh-api\\\.sh/);
  assert.match(script, /status source/);
  assert.match(script, /live isolated worktree/);
});

test("India SWS status reads mutable SWS artifacts from the detected data dir", () => {
  for (const rel of [
    "data/sws/pipeline.lock",
    "data/sws/refresh-api-shard-$s.log",
    "data/sws/last-refresh.json",
    "data/sws/sws-nightly.log",
  ]) {
    assert.ok(script.includes(`data_path "${rel}"`), `missing data_path for ${rel}`);
  }

  assert.match(script, /tail -f "\$\{DATA_DIR\}\/data\/sws\/refresh-api\.log"/);
  assert.doesNotMatch(script, /tail -6 data\/sws\/sws-nightly\.log/);
  assert.doesNotMatch(script, /\[ -f data\/sws\/pipeline\.lock \]/);
});
