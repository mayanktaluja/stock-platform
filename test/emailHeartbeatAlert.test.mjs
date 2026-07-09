/**
 * Run with: node test/emailHeartbeatAlert.test.mjs
 */

import assert from "node:assert/strict";
import {
  istDateString,
  formatEmailHeartbeat,
  buildStalenessVerdict,
  formatStalenessAlert,
} from "../services/alerts/emailHeartbeatAlert.js";

// --- istDateString: UTC ms → IST calendar date, crossing IST midnight ---
assert.equal(istDateString(Date.parse("2026-07-08T20:02:38.000Z")), "2026-07-09",
  "20:02 UTC is 01:32 IST the next day");
assert.equal(istDateString(Date.parse("2026-07-06T03:00:00.000Z")), "2026-07-06");
assert.equal(istDateString(Number.NaN), null);

// --- buildStalenessVerdict: the load-bearing signal ---
// The real 2026-07-10 outage: on-disk run_id is 2026-07-08T20:02:38Z (IST 07-09),
// checked at 12:00 UTC on 07-10 (17:30 IST) → yesterday's run → STALE.
{
  const v = buildStalenessVerdict(
    { run_id: "2026-07-08T20:02:38.000Z" },
    Date.parse("2026-07-10T12:00:00.000Z"),
  );
  assert.equal(v.stale, true);
  assert.equal(v.reason, "no-fresh-run-today");
  assert.equal(v.run_id_ist_date, "2026-07-09");
  assert.equal(v.today_ist_date, "2026-07-10");
}

// Regression for adversarial finding #1: the healthy-but-LATE 2026-07-06 nightly.
// Its artifact's generated_at was ~30h old at 07:00 UTC (a build-age threshold
// would false-positive), but its run_id (2026-07-05T19:21:41Z → IST 07-06) is
// today's when checked at 12:00 UTC on 07-06 → NOT stale. Proves run_id-date
// separates healthy-late from a real outage where build-age cannot.
{
  const v = buildStalenessVerdict(
    { run_id: "2026-07-05T19:21:41.000Z", generated_at: "2026-07-05T00:56:59.000Z" },
    Date.parse("2026-07-06T12:00:00.000Z"),
  );
  assert.equal(v.stale, false);
  assert.equal(v.reason, null);
  assert.equal(v.run_id_ist_date, "2026-07-06");
}

// artifact_email_eligible=false alone (fresh run, pending confirmation) is NOT stale.
{
  const v = buildStalenessVerdict(
    { run_id: "2026-07-05T19:21:41.000Z", artifact_email_eligible: false },
    Date.parse("2026-07-06T12:00:00.000Z"),
  );
  assert.equal(v.stale, false, "a fresh-run day pending confirmation is not an outage");
}

// Missing / unparseable run_id → stale.
assert.equal(buildStalenessVerdict({}, Date.parse("2026-07-10T12:00:00Z")).reason, "missing-run-id");
assert.equal(buildStalenessVerdict({ run_id: "not-a-date" }, Date.parse("2026-07-10T12:00:00Z")).reason, "unparseable-run-id");
assert.equal(buildStalenessVerdict(null, Date.parse("2026-07-10T12:00:00Z")).stale, true);

// --- formatEmailHeartbeat: only fires when nobody got mail ---
assert.equal(formatEmailHeartbeat({ runId: "r1", recipientCount: 2 }), null,
  "delivered to >0 recipients → nothing wrong → null");
{
  const a = formatEmailHeartbeat({ runId: "run-x", recipientCount: 0, counts: { deduped: 3 } });
  assert.equal(a.breaking, true);
  assert.ok(a.text.includes("run-x"));
  assert.ok(/deduped/.test(a.text));
  assert.ok(Array.isArray(a.buttons) && a.buttons.length === 1);
}
{
  const a = formatEmailHeartbeat({ runId: "run-y", recipientCount: 0, reason: "artifact-not-email-eligible" });
  assert.ok(a.text.includes("artifact-not-email-eligible"));
}

// --- formatStalenessAlert ---
assert.equal(formatStalenessAlert({ stale: false }), null);
assert.equal(formatStalenessAlert(null), null);
{
  const a = formatStalenessAlert(buildStalenessVerdict({ run_id: "2026-07-08T20:02:38.000Z" }, Date.parse("2026-07-10T12:00:00Z")));
  assert.equal(a.breaking, true);
  assert.ok(a.text.includes("no-fresh-run-today"));
  assert.ok(a.text.includes("2026-07-08T20:02:38.000Z"));
}

console.log("emailHeartbeatAlert tests passed");
