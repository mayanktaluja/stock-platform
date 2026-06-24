/**
 * Run with: node test/sentLedger.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { markIfNew, ledgerKey, ledgerPath, ledgerDir } from "../services/alerts/sentLedger.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
const env = { ALERTS_LEDGER_DIR: dir };

try {
  // ledgerKey is stable + truncated.
  const k = ledgerKey(["news", "RELIANCE", "headline"]);
  assert.equal(k.length, 24);
  assert.equal(k, ledgerKey(["news", "RELIANCE", "headline"]));
  assert.notEqual(k, ledgerKey(["news", "INFY", "headline"]));

  // Default dir is an absolute canonical path (NOT cwd-relative — adversarial C2).
  assert.ok(path.isAbsolute(ledgerDir({})));
  assert.ok(ledgerDir({}).endsWith(path.join("data", "alerts")));
  assert.equal(ledgerDir(env), dir);

  const now = Date.UTC(2026, 5, 24, 6, 0, 0);

  // First sighting → fresh; file gets created.
  assert.deepEqual(markIfNew("abc", { env, now }), { fresh: true });
  assert.ok(existsSync(ledgerPath(dir, now)));

  // Repeat within TTL → not fresh.
  assert.deepEqual(markIfNew("abc", { env, now: now + 1000 }), { fresh: false });

  // Different key → fresh.
  assert.deepEqual(markIfNew("xyz", { env, now: now + 2000 }), { fresh: true });

  // Past the TTL window → the old key re-alerts.
  assert.deepEqual(markIfNew("abc", { env, ttlMs: 1000, now: now + 5000 }), { fresh: true });

  console.log("sentLedger.test.mjs OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
