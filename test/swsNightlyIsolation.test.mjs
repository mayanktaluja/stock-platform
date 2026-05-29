/**
 * Regression tests for the isolated launchd publish path. The nightly must run
 * from an owned worktree and must not re-apply arbitrary checkout dirt before
 * creating the data PR.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const nightly = readFileSync(resolve(REPO_ROOT, "scripts/sws-nightly.sh"), "utf-8");
const isolated = readFileSync(resolve(REPO_ROOT, "scripts/sws-nightly-isolated.sh"), "utf-8");
const plist = readFileSync(resolve(REPO_ROOT, "scripts/com.starbhai.sws-nightly.plist"), "utf-8");

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

console.log("\nsws-nightly isolated publish path\n");

assert(
  "launchd plist invokes sws-nightly-isolated.sh",
  plist.includes("/Users/mayanktaluja/code/stock-platform/scripts/sws-nightly-isolated.sh"),
  null,
);
assert(
  "launchd plist sets the dedicated isolated worktree path",
  plist.includes("SWS_NIGHTLY_WORKTREE_DIR") &&
    plist.includes("/Users/mayanktaluja/.Codex/worktrees/stock-platform-sws-nightly"),
  null,
);
assert(
  "launchd plist uses the isolated base branch",
  plist.includes("SWS_NIGHTLY_BASE_BRANCH") && plist.includes("sws-nightly-isolated-base"),
  null,
);

assert(
  "isolated wrapper creates or resets a git worktree",
  /git -C "\$\{PRIMARY_REPO\}" worktree add -B "\$\{BASE_BRANCH\}"/.test(isolated) &&
    /git -C "\$\{WORKTREE_DIR\}" reset --hard origin\/main/.test(isolated),
  null,
);
assert(
  "isolated wrapper links .env and .env.local into the worktree",
  /for env_file in \.env \.env\.local/.test(isolated) &&
    /ln -sfn "\$\{src\}" "\$\{dest\}"/.test(isolated),
  null,
);
assert(
  "isolated wrapper launches nightly with SWS_NIGHTLY_REPO_DIR",
  /SWS_NIGHTLY_REPO_DIR="\$\{WORKTREE_DIR\}"/.test(isolated) &&
    /bash "\$\{WORKTREE_DIR\}\/scripts\/sws-nightly\.sh"/.test(isolated),
  null,
);
assert(
  "isolated wrapper sends critical email on setup failures",
  /fail_critical\(\)/.test(isolated) &&
    /send_mail "🚨 SWS nightly — \$\{subject\}"/.test(isolated),
  null,
);

assert(
  "nightly supports SWS_NIGHTLY_REPO_DIR override",
  /REPO_DIR="\$\{SWS_NIGHTLY_REPO_DIR:-\/Users\/mayanktaluja\/code\/stock-platform\}"/.test(nightly),
  null,
);
assert(
  "nightly supports configurable base branch",
  /BASE_BRANCH="\$\{SWS_NIGHTLY_BASE_BRANCH:-sws-nightly-base\}"/.test(nightly) &&
    /git checkout -B "\$\{BASE_BRANCH\}" origin\/main/.test(nightly),
  null,
);
assert(
  "nightly never re-applies autostash before publish",
  !/git stash pop/.test(nightly) &&
    /autostash \$\{STASH_TAG\} left on stash list; not re-applying before publish/.test(nightly),
  null,
);
assert(
  "nightly runs the health gate before sanity/commit",
  nightly.indexOf("node scripts/check-snapshot-health.mjs --strict --critical-only") > -1 &&
    nightly.indexOf("node scripts/check-snapshot-health.mjs --strict --critical-only") < nightly.indexOf("running sanity gate"),
  null,
);
assert(
  "nightly emails on health gate failure",
  /send_mail "🚨 SWS nightly — snapshot health gate failed"/.test(nightly),
  null,
);
assert(
  "nightly verifies health-critical files are staged before commit",
  /assert_health_critical_staged\(\)/.test(nightly) &&
    /git diff --name-only -- "\$\{HEALTH_CRITICAL_FILES\[@\]\}"/.test(nightly),
  null,
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
