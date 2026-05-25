// scripts/refresh-earnings.mjs — focused stats tests.
//
// Keeps the rolling-window UI buckets honest without running the full
// refresh pipeline or touching predictor logic.

import assert from "node:assert/strict";
import { buildStats } from "../scripts/refresh-earnings.mjs";

const snapshot = {
  built_at: "2026-05-25T01:00:00.000Z",
  today_iso: "2026-05-25",
  window_days: 60,
  upstream_event_count: 6,
  upstream_fetched_at: "2026-05-25T00:55:00.000Z",
  event_count: 6,
  past_window_days: 14,
  recent_results: [{ symbol: "PENDING", actual_status: "PENDING" }],
  events: [
    { symbol: "D0", days_until: 0 },
    { symbol: "D3", days_until: 3 },
    { symbol: "D7", days_until: 7 },
    { symbol: "D14", days_until: 14 },
    { symbol: "D30", days_until: 30 },
    { symbol: "D60", days_until: 60 },
  ],
};

const stats = buildStats(snapshot, null);

assert.equal(stats.window_days, 60);
assert.equal(stats.past_window_days, 14);
assert.equal(stats.recent_results_count, 1);
assert.deepEqual(stats.bucket_by_days, {
  d0: 1,
  d1to3: 1,
  d4to7: 1,
  d8to14: 1,
  d15to30: 1,
  d31to60: 1,
});

console.log("✓ refresh earnings stats buckets include d31to60");
