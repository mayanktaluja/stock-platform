/**
 * Regression test for the snapshot-health monitoring surface (PR D).
 *
 * /api/health/snapshots grew from 5 monitored fixtures to 11. The real
 * regression risk is a key/label mismatch: server.js adds a snapshot key but
 * gated/app.js forgets the human label, so the banner shows a raw key like
 * "oi_deltas" instead of "F&O OI deltas". This test cross-checks the two
 * files so that can't ship.
 *
 * Run with: node test/snapshotHealth.test.mjs
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const serverJs = readFileSync(resolve(REPO_ROOT, "server.js"), "utf-8");
const appJs = readFileSync(resolve(REPO_ROOT, "gated/app.js"), "utf-8");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

console.log("\nsnapshot-health monitoring — server.js ↔ app.js consistency\n");

const EXPECTED_KEYS = [
  "fundamentals",
  "surveillance",
  "governance",
  "picks_latest",
  "macro_regime",
  "fundamentals_history",
  "macro_calendar",
  "events_latest",
  "oi_deltas",
  "earnings_watch",
  "universe",
];

// Extract the snapshot keys actually built in server.js's /api/health/snapshots.
const snapBlock = (serverJs.match(/const snapshots = \{[\s\S]*?\n {2}\};/) || [""])[0];
assert("found the `const snapshots = {...}` block in server.js", snapBlock.length > 0, null);
const serverKeys = [...snapBlock.matchAll(/^ {4}(\w+): \{$/gm)].map((m) => m[1]);

// Extract the labels-map keys from gated/app.js loadSnapshotHealth.
const labelsBlock = (appJs.match(/const labels = \{[\s\S]*?\n {2}\};/) || [""])[0];
assert("found the `const labels = {...}` block in gated/app.js", labelsBlock.length > 0, null);
const labelKeys = [...labelsBlock.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);

// Every expected fixture is monitored server-side AND has a banner label.
for (const k of EXPECTED_KEYS) {
  assert(`server.js monitors '${k}'`, serverKeys.includes(k), serverKeys);
  assert(`app.js labels '${k}'`, labelKeys.includes(k), labelKeys);
}

// No server-side snapshot key may lack a label — that's the exact bug this
// test exists to catch (raw key leaking into the user-facing banner).
for (const k of serverKeys) {
  assert(`server key '${k}' has a banner label`, labelKeys.includes(k), labelKeys);
}

// macro_calendar's `_updated` stamp is date-only ("2026-05-01"); the endpoint's
// ageHours helper must still parse it to a finite age. Guard the language
// behaviour the endpoint relies on.
assert(
  "date-only timestamp parses to a finite age",
  Number.isFinite(new Date("2026-05-01").getTime()),
  new Date("2026-05-01").getTime(),
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
