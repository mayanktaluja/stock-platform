/**
 * Run with: node test/swsInputAlertLedgerStorage.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getSwsInputAlertLedgerStorage,
  swsInputAlertEventId,
} from "../swsInputAlertLedgerStorage.js";

const ledgerPath = path.join(process.cwd(), "sws-input-alert-ledger.json");
const prior = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf-8") : null;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

try {
  fs.rmSync(ledgerPath, { force: true });
  const a = swsInputAlertEventId({ sub: "s1", run_id: "r1", digest: "d1", type: "EMAIL_SENT" });
  const b = swsInputAlertEventId({ sub: "s1", run_id: "r1", digest: "d1", type: "EMAIL_SENT" });
  assert.equal(a, b);

  const storage = getSwsInputAlertLedgerStorage();
  const first = await storage.appendEvents("s1", [{ type: "EMAIL_SENT", run_id: "r1", digest: "d1" }]);
  assert.equal(first.appended, 1);
  const second = await storage.appendEvents("s1", [{ type: "EMAIL_SENT", run_id: "r1", digest: "d1" }]);
  assert.equal(second.appended, 0);
  assert.equal(await storage.hasEvent("s1", { type: "EMAIL_SENT", run_id: "r1", digest: "d1" }), true);
  assert.equal(await storage.hasEmailSentForRun("s1", "r1"), true);

  await storage.appendEvents("s1", [{
    type: "EMAIL_SENT",
    run_id: "r2",
    digest: "d2",
    transition_keys: ["transition-a", "transition-b"],
    at: new Date().toISOString(),
  }]);
  const recent = await storage.recentTransitionKeys("s1", 14 * 24 * 60 * 60 * 1000);
  assert.equal(recent.has("transition-a"), true);
  assert.equal(recent.has("transition-b"), true);

  const failedFirst = await storage.appendEvents("s2", [{ type: "EMAIL_FAILED", run_id: "r1", digest: "d1", email: "reader@example.com", reason: "resend_error" }]);
  const failedSecond = await storage.appendEvents("s2", [{ type: "EMAIL_FAILED", run_id: "r1", digest: "d1", email: "reader@example.com", reason: "resend_error" }]);
  assert.equal(failedFirst.appended, 1);
  assert.equal(failedSecond.appended, 1, "failed attempts are auditable separately");
  const failedEntry = await storage.read("s2");
  assert.equal(failedEntry.events.length, 2);
  assert.notEqual(failedEntry.events[0].id, failedEntry.events[1].id);
  assert.equal(await storage.hasEmailSentForRun("s2", "r1"), false, "failed sends do not dedupe future sends");
  console.log("swsInputAlertLedgerStorage tests passed");
} finally {
  if (prior === null) fs.rmSync(ledgerPath, { force: true });
  else fs.writeFileSync(ledgerPath, prior);
}
