/**
 * Run with: node test/alertDispatcher.test.mjs
 */

import assert from "node:assert/strict";
import { dispatch } from "../services/alerts/alertDispatcher.js";

const quietLogger = { log() {}, warn() {} };

// Disabled env → self-skip, ok:true, never throws.
const skipped = await dispatch({ text: "hi" }, { env: {}, logger: quietLogger });
assert.deepEqual(skipped, { ok: true, skipped: true, reason: "TG_BOT_TOKEN missing" });

// Empty alert text → ok:false skipped.
const empty = await dispatch({ text: "  " }, { env: { TG_BOT_TOKEN: "t", TG_CHAT_ID: "c" }, logger: quietLogger });
assert.equal(empty.ok, false);
assert.equal(empty.skipped, true);
assert.equal(empty.reason, "empty_alert");

// Enabled + dryRun → does not hit network, resolves skipped/dry_run.
const dry = await dispatch(
  { text: "boom", breaking: true },
  { env: { TG_BOT_TOKEN: "t", TG_CHAT_ID: "c" }, dryRun: true, logger: quietLogger },
);
assert.equal(dry.ok, true);
assert.equal(dry.skipped, true);
assert.equal(dry.reason, "dry_run");

// Contract: NEVER throws. A bad env (null) makes alertsState throw internally;
// dispatch must catch and resolve, not propagate.
const caught = await dispatch({ text: "x" }, { env: null, logger: quietLogger });
assert.equal(caught.ok, false);
assert.match(caught.reason, /threw:/);

console.log("alertDispatcher.test.mjs OK");
