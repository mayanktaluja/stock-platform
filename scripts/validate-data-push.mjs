#!/usr/bin/env node
/**
 * Fast integrity gate for pure-data pushes.
 *
 * WHY
 * ───
 * .githooks/pre-push used to run the entire `npm test` chain (200+ commands) on
 * EVERY push, including the nightly's pure-data pushes. That made an unrelated,
 * environment-dependent test failure able to block the shipping of freshly
 * scraped market data — which is exactly what happened on 2026-07-20/21/22 and
 * left prod showing a "Stale data" banner for three days.
 *
 * This script is the replacement gate for that case. It validates the DATA
 * actually being pushed, which the 200-command suite never did.
 *
 * EXIT CODES — the contract with the hook, and the fail-safe mechanism:
 *   0  every changed path is data AND every one is valid  → hook may skip the suite
 *   2  at least one changed path is NOT data              → hook runs the full suite
 *   3  all data, but at least one file is INVALID         → hook blocks the push
 *   *  anything else (crash, missing node, 127)           → hook runs the full suite
 *
 * "Invalid" is 3 rather than 1 on purpose: an accidental crash exits 1 or 127 and
 * therefore lands in the run-the-full-suite branch, never in a hard block. The
 * failure mode of this script is extra testing, never a wrongly-blocked push.
 *
 * Usage:
 *   node scripts/validate-data-push.mjs --files-from -      # newline list on stdin
 *   node scripts/validate-data-push.mjs path/a.json ...     # explicit paths
 *   node scripts/validate-data-push.mjs                     # all tracked data files
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isDataPushPath, isBinaryDataPath } from "./data-paths.mjs";

const EXIT_OK = 0;
const EXIT_NOT_DATA_ONLY = 2;
const EXIT_INVALID = 3;

// Full JSONL line-parsing is skipped above this size; there are 5,500+ .jsonl
// files under data/ and the hook must stay fast. Marker scanning still applies.
const JSONL_FULL_PARSE_MAX_BYTES = 2 * 1024 * 1024;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Returns { paths, scoped }.
 *
 * `scoped: true`  — these are the files of a specific PUSH, so a non-data path
 *                   is meaningful (it means "not a data-only push", exit 2).
 * `scoped: false` — audit mode (`npm run test:data`): sweep everything tracked
 *                   under data/ and just skip what isn't a data artifact. The
 *                   two tracked .gitignore files are denied for push-scoping
 *                   purposes but are not a validation failure.
 */
function collectInputPaths(argv) {
  const fromIdx = argv.indexOf("--files-from");
  if (fromIdx !== -1) {
    const src = argv[fromIdx + 1];
    const raw = src === "-" ? readStdin() : fs.readFileSync(src, "utf-8");
    return { paths: raw.split("\n").map((s) => s.trim()).filter(Boolean), scoped: true };
  }
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length) return { paths: positional, scoped: true };

  const out = execFileSync(
    "git",
    ["ls-files", "data", "fundamentals.json", "surveillance.json", "governance.json", "fundamentalsHistory.json"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
  );
  return { paths: out.split("\n").map((s) => s.trim()).filter(Boolean), scoped: false };
}

/**
 * Detect git conflict markers.
 *
 * On 2026-05 a `git stash pop` left `<<<<<<< Updated upstream` inside
 * data/macroRegime.json; it reached disk and broke a test at JSON.parse. Nothing
 * in the repo guarded against it — `grep -rn '<<<<<<<' scripts/ .githooks/`
 * returned zero hits. This closes that class permanently.
 *
 * `=======` is only treated as a marker AFTER a `<<<<<<< ` has been seen in the
 * same file. A bare row of equals signs is legal content (setext heading
 * underline, ASCII rule), and git never writes the middle marker without the
 * opener — so this gets full three-marker detection with no false positives.
 */
function findConflictMarker(text) {
  let sawOpen = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("<<<<<<< ") || line === "<<<<<<<") {
      sawOpen = true;
      return { line: i + 1, marker: "<<<<<<<" };
    }
    if (line.startsWith(">>>>>>> ") || line === ">>>>>>>") return { line: i + 1, marker: ">>>>>>>" };
    if (sawOpen && line.startsWith("=======")) return { line: i + 1, marker: "=======" };
  }
  return null;
}

function validateFile(rel, problems) {
  const abs = path.resolve(rel);
  // Not on disk = a deletion. Deleting a data file is still a data-only change.
  if (!fs.existsSync(abs)) return;

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return;

  if (isBinaryDataPath(rel)) {
    // Scanning the two ~30MB tarballs costs ~1.2s and 62MB per push for zero
    // signal (measured: no marker can appear in compressed bytes anyway).
    if (stat.size === 0) problems.push(`${rel}: binary artifact is empty`);
    return;
  }

  let text;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    problems.push(`${rel}: unreadable — ${err.message}`);
    return;
  }

  const marker = findConflictMarker(text);
  if (marker) {
    problems.push(`${rel}:${marker.line}: git conflict marker ${marker.marker}`);
    return; // a conflicted file will also fail to parse; one clear reason is enough
  }

  if (rel.endsWith(".json")) {
    try {
      JSON.parse(text);
    } catch (err) {
      problems.push(`${rel}: invalid JSON — ${err.message}`);
    }
    return;
  }

  if (rel.endsWith(".jsonl")) {
    if (stat.size > JSONL_FULL_PARSE_MAX_BYTES) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        JSON.parse(line);
      } catch (err) {
        problems.push(`${rel}:${i + 1}: invalid JSONL line — ${err.message}`);
        return;
      }
    }
  }
}

/**
 * The content checks the full suite WOULD have run on these files.
 *
 * Dropping the suite on a data push must not drop real prod protection.
 * vercel-include-files is the load-bearing one: it asserts every shipped data
 * path is covered by vercel.json includeFiles. Without it a new data file ships
 * to prod and is silently unreadable there.
 */
const DATA_CONTENT_TESTS = [
  "test/vercel-include-files.test.mjs",
  "test/swsFailedSchema.test.mjs",
  "test/nseBulkBlockSchema.test.mjs",
  "test/indexConstituents.test.mjs",
];

function runDataContentTests(problems) {
  for (const t of DATA_CONTENT_TESTS) {
    if (!fs.existsSync(path.resolve(t))) continue;
    try {
      execFileSync(process.execPath, [t], { stdio: "pipe", encoding: "utf-8" });
    } catch (err) {
      const detail = `${err.stdout || ""}${err.stderr || ""}`.trim().split("\n").slice(-8).join("\n");
      problems.push(`${t}: FAILED\n${detail}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let collected;
try {
  collected = collectInputPaths(argv);
} catch (err) {
  console.error(`[validate-data-push] could not read the changed-file list: ${err.message}`);
  process.exit(1); // → hook falls through to the full suite
}

let { paths: inputs } = collected;
const { scoped } = collected;

if (!inputs.length) {
  console.log("[validate-data-push] no changed files to validate");
  process.exit(EXIT_OK);
}

const nonData = inputs.filter((p) => !isDataPushPath(p));
if (nonData.length && !scoped) {
  // Audit mode: just skip anything that isn't a data artifact.
  inputs = inputs.filter((p) => isDataPushPath(p));
} else if (nonData.length) {
  // Log WHY, so a silent fall-through to the slow path is observable rather than
  // a mystery slowdown (e.g. if a code file is ever added under data/).
  console.log(`[validate-data-push] not a pure-data push — ${nonData.length} non-data path(s):`);
  for (const p of nonData.slice(0, 20)) console.log(`    ${p}`);
  if (nonData.length > 20) console.log(`    …and ${nonData.length - 20} more`);
  process.exit(EXIT_NOT_DATA_ONLY);
}

const problems = [];
for (const rel of inputs) validateFile(rel, problems);
runDataContentTests(problems);

if (problems.length) {
  console.error(`[validate-data-push] ${problems.length} problem(s) in the data being pushed:`);
  for (const p of problems) console.error(`    ${p}`);
  process.exit(EXIT_INVALID);
}

console.log(`[validate-data-push] OK — ${inputs.length} data file(s) validated, ${DATA_CONTENT_TESTS.length} content check(s) passed`);
for (const p of inputs.slice(0, 20)) console.log(`    ${p}`);
if (inputs.length > 20) console.log(`    …and ${inputs.length - 20} more`);
process.exit(EXIT_OK);
