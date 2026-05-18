/**
 * Regression test for the resolve-earnings-actuals.mjs wiring in
 * scripts/sws-nightly.sh.
 *
 * Wired in 2026-05-18 (P0-1) after the script — committed in the earnings
 * pipeline since Phase E — had never been scheduled. Actuals had not resolved
 * since 2026-05-09; 382 past-date events with `fiscal_quarter` set sat
 * unresolved across 2026-05-13 → 2026-05-15 archives, which in turn blocked
 * the cap-lift gate, the ablation harness, and the weight-tuner gate.
 *
 * This test guards against a future edit silently dropping either the
 * `SWS_SKIP_RESOLVE_ACTUALS` env-flag doc-block entry or the runtime
 * invocation. It reads the ACTUAL sws-nightly.sh, not a re-implementation.
 *
 * Run with: node test/swsNightlyResolveActuals.test.mjs
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const nightly = readFileSync(resolve(REPO_ROOT, "scripts/sws-nightly.sh"), "utf-8");

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

console.log("\nsws-nightly.sh — resolve-earnings-actuals.mjs wiring\n");

// 1. The env-flag doc block must document the SWS_SKIP_RESOLVE_ACTUALS toggle
//    so operators know how to opt out (e.g. when debugging the SWS news brief
//    parser without burning Yahoo quota).
assert(
  "SWS_SKIP_RESOLVE_ACTUALS is documented in the header env-block",
  /SWS_SKIP_RESOLVE_ACTUALS=1[\s\S]{0,120}skip post-earnings actuals-resolution/.test(nightly),
  null,
);

// 2. The script must actually invoke resolve-earnings-actuals.mjs as a
//    runtime step. Without this, the env-flag is documented but the step
//    never runs — the original bug.
assert(
  "node scripts/resolve-earnings-actuals.mjs is invoked at runtime",
  /node\s+scripts\/resolve-earnings-actuals\.mjs/.test(nightly),
  null,
);

// 3. Ordering constraint: actuals-resolution reads the archived predictions
//    refresh-earnings.mjs writes (data/catalysts/earnings-history/<date>.json),
//    so it MUST run AFTER refresh-earnings.mjs in the chain. A swap would
//    silently no-op against yesterday's archive.
const earningsIdx = nightly.indexOf("node scripts/refresh-earnings.mjs");
const actualsIdx = nightly.indexOf("node scripts/resolve-earnings-actuals.mjs");
assert(
  "resolve-earnings-actuals runs after refresh-earnings",
  earningsIdx > -1 && actualsIdx > earningsIdx,
  { earningsIdx, actualsIdx },
);

// 4. The runtime invocation must respect the skip-flag — without the
//    `if [ "${SWS_SKIP_RESOLVE_ACTUALS:-0}" = "1" ]` guard, the env-flag doc
//    is a lie and operators can't opt out.
assert(
  "runtime invocation honours the SWS_SKIP_RESOLVE_ACTUALS guard",
  /SWS_SKIP_RESOLVE_ACTUALS:-0[\s\S]{0,400}node\s+scripts\/resolve-earnings-actuals\.mjs/.test(nightly),
  null,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
