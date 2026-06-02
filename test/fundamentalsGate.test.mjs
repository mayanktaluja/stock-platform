/**
 * Regression test for the fundamentals.json freshness gate in
 * scripts/sws-nightly.sh.
 *
 * The gate decides whether each nightly fire re-runs refresh-fundamentals.mjs.
 * It must be tight enough that the daily 00:30 IST fire refreshes the file
 * while same-day manual reruns can coast — otherwise fundamentals.json drifts past the
 * 48h staleness banner, which is the "Fundamentals (2d old)" incident this
 * test exists to prevent.
 *
 * It reads the ACTUAL gate threshold out of sws-nightly.sh (not a
 * re-implementation), so a future loosening of the gate fails here.
 *
 * Run with: node test/fundamentalsGate.test.mjs
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

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

const nightly = readFileSync(resolve(REPO_ROOT, "scripts/sws-nightly.sh"), "utf-8");

console.log("\nfundamentals.json freshness gate\n");

// Extract the actual `-lt N` threshold from the gate condition.
const m = nightly.match(/FUND_AGE_HOURS\}"?\s*-lt\s+(\d+)/);
assert("gate condition found in sws-nightly.sh", m != null, m);
const threshold = m ? Number(m[1]) : null;

// The scheduled launchd gap is now 24h. The gate must sit comfortably below
// that gap so every daily fire refreshes.
assert(
  `threshold ${threshold}h < 24h daily fire gap`,
  threshold != null && threshold < 24,
  threshold,
);

// Age arithmetic — mirrors the node one-liner in the gate. A file left by the
// previous daily fire must read as "run"; a file just refreshed a few hours
// ago must read as "skip".
const ageHours = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
const isoAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

assert("24h-old file → run (age ≥ threshold)", ageHours(isoAgo(24)) >= threshold, ageHours(isoAgo(24)));
assert("3h-old file → skip (age < threshold)", ageHours(isoAgo(3)) < threshold, ageHours(isoAgo(3)));

// The aux_status hook must be wired so step-3c outcomes reach the PR body.
assert("aux_status helper defined in sws-nightly.sh", /aux_status\(\)\s*\{/.test(nightly), null);
assert(
  "fundamentals step records an aux_status outcome",
  /aux_status "fundamentals\.json"/.test(nightly),
  null,
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
