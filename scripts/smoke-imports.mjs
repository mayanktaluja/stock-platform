#!/usr/bin/env node
/**
 * Module-load smoke test.
 *
 * Catches the class of bug that took prod down when PR #39 merged: an
 * `import { getExpandedUniverse }` landed in server.js before the matching
 * export landed in stockList.js. Node links ES modules at import time, so a
 * missing named export throws SyntaxError before any request is served — the
 * whole serverless function fails cold-start with 500.
 *
 * This script `import()`s every entry point that runs in production. If any
 * named import can't resolve, the promise rejects and the process exits 1,
 * failing CI and blocking the merge.
 *
 * VERCEL=1 is set so server.js skips `app.listen()` and just resolves after
 * its top-level awaits (KV prime attempts, each Promise.race-timeout-guarded
 * to ~2s, so total wall clock is bounded even without network).
 *
 * Keep this tiny and dependency-free: it runs before `npm test` in CI.
 */

process.env.VERCEL = process.env.VERCEL || "1";

const ENTRY_POINTS = [
  "../server.js",
  "../stockList.js",
  "../fundamentals.js",
  "../fundamentalsV2.js",
  "../enrichFundamentals.js",
  "../scorerMode.js",
  "../governance.js",
  "../surveillance.js",
  "../nse.js",
  "../portfolioAnalyzer.js",
  "../portfolioParser.js",
];

const start = Date.now();
let failures = 0;

for (const entry of ENTRY_POINTS) {
  try {
    await import(entry);
    process.stdout.write(`  ✓ ${entry}\n`);
  } catch (err) {
    failures++;
    process.stdout.write(`  ✗ ${entry}\n    ${err.message}\n`);
  }
}

const elapsed = Date.now() - start;
if (failures > 0) {
  console.error(`\n[smoke] ${failures} module(s) failed to load (${elapsed}ms)`);
  process.exit(1);
}
console.log(`\n[smoke] All ${ENTRY_POINTS.length} modules imported cleanly (${elapsed}ms)`);
process.exit(0);
