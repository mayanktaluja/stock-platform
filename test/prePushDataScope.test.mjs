/**
 * .githooks/pre-push — data-only scoping.
 *
 * The hook gates every push. A bug here blocks ALL pushes, so this pins both the
 * structure (one stdin loop, correct zero-sha handling, no network) and the
 * actual end-to-end behaviour against real commits in this repo.
 *
 * Run with: node test/prePushDataScope.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(REPO_ROOT, ".githooks", "pre-push");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}

const src = fs.readFileSync(HOOK, "utf-8");

console.log("prePushDataScope: hook structure");
{
  const loops = (src.match(/while read -r local_ref/g) || []).length;
  // Stdin is readable exactly once. A second loop would silently read nothing.
  assert("exactly one stdin ref loop", loops === 1, loops);

  assert("handles an all-zero local_sha (branch deletion)", /ZERO_RE/.test(src) && /continue/.test(src));
  assert("uses merge-base for a new branch (all-zero remote_sha)", /git merge-base/.test(src));
  assert("verifies remote_sha exists locally before diffing", /git cat-file -e/.test(src));
  assert("computes the changed set with git diff --name-only", /git diff --name-only/.test(src));

  // Network inside a pre-push hook is a new failure mode; the nightly wrapper
  // already fetches origin/main and hard-fails if it cannot.
  const fetches = (src.match(/^\s*git fetch/gm) || []).length;
  assert("never runs git fetch", fetches === 0, fetches);

  assert("delegates validation to scripts/validate-data-push.mjs", /validate-data-push\.mjs/.test(src));
  assert("still runs the full npm test on the slow path", /npm test/.test(src));
}

console.log("prePushDataScope: exit-code dispatch is fail-safe");
{
  // 0 → skip suite, 3 → block, everything else → full suite. Using 3 (not 1) for
  // "invalid" means a crash/127 lands in the fall-through branch, never a block.
  assert("rc 0 exits the hook successfully", /0\)[\s\S]{0,400}?exit 0/.test(src));
  assert("rc 3 blocks the push", /3\)[\s\S]{0,300}?exit 1/.test(src));
  assert("a wildcard case falls through to the full suite", /\*\)[\s\S]{0,200}?running the full suite/i.test(src));
}

console.log("prePushDataScope: end-to-end against real commits");

function runHook(localSha, remoteSha, { timeoutMs = 90_000 } = {}) {
  const res = spawnSync("bash", [HOOK, "origin", "git@github.com:mayanktaluja/stock-platform.git"], {
    input: `refs/heads/t ${localSha} refs/heads/t ${remoteSha}\n`,
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

// A real nightly auto-refresh commit — the exact shape that has been blocked.
let dataCommit = null;
try {
  dataCommit = git("rev-list", "-1", "--grep=auto-refresh", "origin/main");
} catch {}

if (!dataCommit) {
  console.log("  ↷ skip — no auto-refresh commit found on origin/main");
} else {
  const parent = git("rev-parse", `${dataCommit}^`);
  const changed = git("diff", "--name-only", parent, dataCommit).split("\n").filter(Boolean);
  const allData = changed.every((f) => f.startsWith("data/") || /^(fundamentals|surveillance|governance|fundamentalsHistory)\.json$/.test(f));
  assert(`the sampled commit ${dataCommit.slice(0, 8)} is genuinely data-only`, allData, changed.filter((f) => !f.startsWith("data/")));

  const r = runHook(dataCommit, parent);
  assert("a real data-only push takes the fast path", r.code === 0, { code: r.code, out: r.out.slice(-400) });
  assert("the fast path says it skipped the suite", /skipping the full suite/.test(r.out), r.out.slice(0, 300));
  assert("the fast path reports what it validated", /validate-data-push\] OK/.test(r.out));
  assert("the fast path did NOT run the unit suite", !/Running unit tests/.test(r.out));
}

{
  // A commit that touches code must never take the fast path. The hook then runs
  // the full suite, which is slow — assert on the classification line and stop.
  const head = git("rev-parse", "HEAD");
  const prev = git("rev-parse", "HEAD~1");
  const r = runHook(head, prev, { timeoutMs: 25_000 }); // killed mid-suite by design
  assert("a code push is classified as not-pure-data", /Not a pure-data push/.test(r.out), r.out.slice(0, 300));
  assert("a code push proceeds to the unit suite", /Running unit tests/.test(r.out), r.out.slice(0, 400));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
