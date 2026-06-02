import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const statusScripts = [
  ["us", readFileSync("scripts/sws-status-us.sh", "utf8")],
  ["kr", readFileSync("scripts/sws-status-kr.sh", "utf8")],
  ["tw", readFileSync("scripts/sws-status-tw.sh", "utf8")],
];

test("market status scripts display stored quality counters from last-refresh.json", () => {
  for (const [market, script] of statusScripts) {
    assert.match(script, /-- stored quality counters \(last-refresh\.json\) --/, market);
    for (const field of [
      "deep_files_scanned",
      "news_populated_count",
      "news_items_total",
      "rewards_populated_count",
      "risks_populated_count",
      "news_aggregate_generated_at",
      "news_aggregate_coverage_count",
      "news_aggregate_items_count",
      "news_progress_done_count",
      "news_progress_failed_count",
    ]) {
      assert.ok(script.includes(field), `${market} status missing ${field}`);
    }
  }
});

test("market status scripts do not rescan deep directories or tarballs for quality", () => {
  for (const [market, script] of statusScripts) {
    assert.doesNotMatch(script, /deep brief counts/, market);
    assert.doesNotMatch(script, /ls "\$DATA_DIR\/deep(?:-api)?"/, market);
    assert.doesNotMatch(script, /tar\s+-(?:t|x|z)/, market);
  }
});
