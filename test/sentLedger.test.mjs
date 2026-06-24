/**
 * Run with: node test/sentLedger.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { markIfNew, ledgerKey, ledgerPath, ledgerDir, hasKey, recordSent } from "../services/alerts/sentLedger.js";

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

  // --- hasKey / recordSent: the check-before-send, record-after-delivery pair ---
  const env2 = { ALERTS_LEDGER_DIR: mkdtempSync(path.join(os.tmpdir(), "ledger2-")) };
  try {
    const t = Date.UTC(2026, 5, 24, 7, 0, 0);
    // Unsent key: hasKey false. The bug fix — we must NOT claim before sending.
    assert.equal(hasKey("k1", { env: env2, now: t }), false);
    // Simulate a skipped send: caller does NOT record → key stays unclaimed → still retryable.
    assert.equal(hasKey("k1", { env: env2, now: t + 100 }), false);
    // After a confirmed delivery, record it → now seen.
    assert.deepEqual(recordSent("k1", { env: env2, now: t + 200 }), { recorded: true });
    assert.equal(hasKey("k1", { env: env2, now: t + 300 }), true);
    // Outside TTL → no longer seen (can re-alert).
    assert.equal(hasKey("k1", { env: env2, ttlMs: 50, now: t + 1000 }), false);
  } finally {
    rmSync(env2.ALERTS_LEDGER_DIR, { recursive: true, force: true });
  }

  console.log("sentLedger.test.mjs OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
