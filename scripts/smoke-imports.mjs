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

import { readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

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

// Parse-check every .mjs under scripts/. Catches the May-11 incident class:
// scripts/sws-stamp-section-status.mjs landed with `await` inside a non-async
// `main()`, failing at parse time. The pipeline shell wrapped it in `|| true`
// so the SyntaxError went unnoticed for two days and prod's picks-latest.json
// shipped with zero section_status fields. `node --check` on every script
// here means the bug class can't slip through CI / pre-push again.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
function walkMjs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const fp = join(dir, entry);
    let st;
    try { st = statSync(fp); } catch { continue; }
    if (st.isDirectory()) out.push(...walkMjs(fp));
    else if (entry.endsWith(".mjs")) out.push(fp);
  }
  return out;
}
const scriptFiles = walkMjs(SCRIPTS_DIR);
for (const fp of scriptFiles) {
  const rel = relative(SCRIPTS_DIR, fp);
  try {
    execFileSync(process.execPath, ["--check", fp], { stdio: "pipe" });
    process.stdout.write(`  ✓ scripts/${rel} (parse)\n`);
  } catch (err) {
    failures++;
    const stderr = (err.stderr && err.stderr.toString()) || err.message;
    process.stdout.write(`  ✗ scripts/${rel} (parse)\n    ${stderr.split("\n").slice(0, 3).join("\n    ")}\n`);
  }
}

const elapsed = Date.now() - start;
if (failures > 0) {
  console.error(`\n[smoke] ${failures} module(s) failed to load or parse (${elapsed}ms)`);
  process.exit(1);
}
console.log(`\n[smoke] ${ENTRY_POINTS.length} prod modules + ${scriptFiles.length} scripts/*.mjs all OK (${elapsed}ms)`);
process.exit(0);
