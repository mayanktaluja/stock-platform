/**
 * scripts/sws-phase5-reminder.sh — bash 3.2 syntax regression
 *
 * The macOS default /bin/bash is 3.2 and has a parser bug where a heredoc
 * body inside $(...) chokes on apostrophes (the original "won't" tripped
 * it with `unexpected EOF while looking for matching '\''`). The script
 * was exit-2'ing silently on every launchd fire (5 runs accumulated)
 * because launchctl invokes /bin/bash via the shebang.
 *
 * This test runs `bash -n` against the script with the exact interpreter
 * launchd would use, asserting the script parses cleanly. If it ever
 * regresses (someone re-adds an apostrophe-in-cmdsub-heredoc) the test
 * fails immediately rather than waiting for the next nightly silent fail.
 *
 * Run with: node test/swsPhase5Reminder.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "sws-phase5-reminder.sh");

const r = spawnSync("/bin/bash", ["-n", SCRIPT], { encoding: "utf8" });
assert.equal(
  r.status,
  0,
  `bash 3.2 syntax check failed for ${SCRIPT}:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
);

console.log("swsPhase5Reminder.test.mjs: bash 3.2 syntax OK");
