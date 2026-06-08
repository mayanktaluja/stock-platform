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
  console.log("swsInputAlertLedgerStorage tests passed");
} finally {
  if (prior === null) fs.rmSync(ledgerPath, { force: true });
  else fs.writeFileSync(ledgerPath, prior);
}
