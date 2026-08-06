/**
 * Guard against the expired-secret truthiness trap in GitHub Actions.
 *
 * `${{ secrets.SOME_PAT || secrets.GITHUB_TOKEN }}` reads like a fallback but
 * is not one: an EXPIRED or revoked PAT is still a non-empty string, so the
 * `||` never yields, and every run hands the step a credential that 401s. The
 * macro-regime backup workflow died that way and stayed dead — each scheduled
 * run failing at `fatal: could not read Username for 'https://github.com'`
 * while the staleness banner it exists to prevent was live in the UI.
 *
 * A real fallback has to probe the credential first and branch on the result.
 *
 * Run with: node test/workflowSecretFallback.test.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(REPO_ROOT, ".github", "workflows");

// `secrets.X || secrets.Y` — an unconditional fallback between two secrets.
const UNPROBED_FALLBACK = /\$\{\{\s*secrets\.[A-Z0-9_]+\s*\|\|\s*secrets\.[A-Z0-9_]+\s*\}\}/g;

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

console.log("\nworkflow secret fallbacks\n");

const workflows = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
assert("there are workflows to check", workflows.length > 0, workflows.length);

const offenders = [];
for (const file of workflows) {
  const src = readFileSync(path.join(WORKFLOW_DIR, file), "utf-8");
  for (const match of src.matchAll(UNPROBED_FALLBACK)) {
    const line = src.slice(0, match.index).split("\n").length;
    offenders.push(`${file}:${line} ${match[0]}`);
  }
}
assert(
  "no workflow relies on `secrets.A || secrets.B` as a credential fallback",
  offenders.length === 0,
  offenders,
);

// The macro backup is the workflow that was bitten; pin its probe explicitly so
// the fix cannot be reverted into an equivalent-looking one-liner.
const macroBackupPath = path.join(WORKFLOW_DIR, "refresh-macro-regime.yml");
const macroBackup = readFileSync(macroBackupPath, "utf-8");
assert(
  "the macro backup probes MACRO_REFRESH_PAT before using it",
  /api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}/.test(macroBackup) && /pat_valid=1/.test(macroBackup) && /pat_valid=0/.test(macroBackup),
  null,
);
assert(
  "the macro backup selects its token from the probe result",
  (macroBackup.match(/steps\.token\.outputs\.pat_valid == '1' && secrets\.MACRO_REFRESH_PAT \|\| secrets\.GITHUB_TOKEN/g) || []).length === 2,
  (macroBackup.match(/steps\.token\.outputs\.pat_valid/g) || []).length,
);
assert(
  "a rejected PAT still warns loudly instead of failing silently",
  /::warning::MACRO_REFRESH_PAT is missing, expired, or lacks access/.test(macroBackup),
  null,
);
assert(
  "the probed secret is passed via env, never interpolated into the script body",
  /env:\s*\n\s*MACRO_REFRESH_PAT: \$\{\{ secrets\.MACRO_REFRESH_PAT \}\}/.test(macroBackup) &&
    !/curl[^\n]*\$\{\{\s*secrets\./.test(macroBackup),
  null,
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
