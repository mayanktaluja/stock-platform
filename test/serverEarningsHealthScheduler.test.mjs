/**
 * Static regression test for the in-process hourly earnings-health refresh
 * scheduler (P1-8 fix).
 *
 * data/catalysts/earnings-health.json was previously regenerated only inside
 * scripts/sws-nightly.sh (2x/day), so the UI banners that read the file went
 * up to 14h stale between runs. server.js now schedules an in-process
 * refresh every 60 minutes inside the app.listen() callback, seeded 30s after
 * boot. We assert on the source text rather than booting the server because
 * the cadence + env-gating are the actual contract we're protecting.
 *
 * Run with: node test/serverEarningsHealthScheduler.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const serverJs = readFileSync(resolve(REPO_ROOT, "server.js"), "utf-8");

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

console.log("server.js hourly earnings-health scheduler");
console.log("==========================================");

// The helper name is load-bearing: it's what shows up in the
// "[earnings-health] hourly refresh failed" log line and what humans grep
// for when triaging the staleness banner.
const helperName = "refreshEarningsHealthInProcess";
const helperDeclared = serverJs.includes(`const ${helperName} = async`);
assert("helper refreshEarningsHealthInProcess is declared", helperDeclared, helperDeclared);

// 60-minute cadence is the contract — drift to 5 or 15 min would burn
// disk + CPU; drift to 6h would re-open the staleness window.
const hourlyCadence = serverJs.includes("setInterval(refreshEarningsHealthInProcess, 60 * 60 * 1000)");
assert("setInterval fires refreshEarningsHealthInProcess at 60 * 60 * 1000 ms", hourlyCadence, hourlyCadence);

// 30s seed timer so the file is fresh on boot without blocking the
// listener-callback critical path.
const bootSeed = serverJs.includes("setTimeout(refreshEarningsHealthInProcess, 30_000)");
assert("setTimeout seeds refreshEarningsHealthInProcess 30s after boot", bootSeed, bootSeed);

// NODE_ENV=test must be skipped — the Playwright harness rewrites the
// tracked file and leaves the working tree dirty otherwise (same rationale
// as the macro-regime block right above this one in server.js).
const guardedOnTestEnv = /if\s*\(\s*!isTestEnv\s*&&\s*process\.env\.SKIP_HEALTH_REFRESH\s*!==\s*"1"\s*\)/.test(serverJs);
assert("scheduler is gated on !isTestEnv && SKIP_HEALTH_REFRESH !== '1'", guardedOnTestEnv, guardedOnTestEnv);

// Dynamic-import pattern mirrors the existing in-listener idiom and avoids
// a top-of-file import cycle. Both modules must be loaded.
const importsHistory = serverJs.includes('import("./services/earnings/earningsHistoryArchive.js")');
const importsHealth = serverJs.includes('import("./services/earnings/earningsHealth.js")');
assert("dynamically imports earningsHistoryArchive.js", importsHistory, importsHistory);
assert("dynamically imports earningsHealth.js", importsHealth, importsHealth);

// Output file path — the banner consumers are hard-coded on this exact
// filename, so a rename would silently break the surface.
const writesHealthJson = serverJs.includes('"earnings-health.json"');
assert("writes data/catalysts/earnings-health.json", writesHealthJson, writesHealthJson);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
