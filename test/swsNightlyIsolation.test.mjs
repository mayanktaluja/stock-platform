/**
 * Regression tests for the isolated launchd publish path. The nightly must run
 * from an owned worktree and must not re-apply arbitrary checkout dirt before
 * creating the data PR.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    /git -C "\$\{WORKTREE_DIR\}" reset --hard 2>&1/.test(isolated) &&
    /git -C "\$\{WORKTREE_DIR\}" clean -fd -- \. 2>&1/.test(isolated) &&
    /git -C "\$\{WORKTREE_DIR\}" checkout -f -B "\$\{BASE_BRANCH\}" origin\/main/.test(isolated) &&
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
  "isolated wrapper links local runtime artifacts",
  /exclude_worktree_path "node_modules"/.test(isolated) &&
    /exclude_worktree_path "\.sws-profile-\*"/.test(isolated) &&
    /exclude_worktree_path "data\/sws\/api-queries\.json"/.test(isolated) &&
    /rev-parse --git-path info\/exclude/.test(isolated) &&
    /link_local_artifact "node_modules"/.test(isolated) &&
    /link_local_artifact "data\/sws\/api-queries\.json"/.test(isolated) &&
    /link_local_artifact "\.sws-profile-1"/.test(isolated) &&
    /link_local_artifact "\.sws-profile-2"/.test(isolated) &&
    /link_local_artifact "\.sws-profile-3"/.test(isolated),
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

// ---------------------------------------------------------------------------
// Power policy (2026-08-09)
//
// The 2026-08-08 outage happened because the plist's own comment asserted that
// `caffeinate -dimsu` "prevents sleep mid-scrape regardless of lid state". It
// does not: man caffeinate says `-s` is "valid only when system is running on
// AC power", `-u` without `-t` defaults to a 5-second assertion, and `-t` "is
// not used when an utility is invoked" — the exact form this plist uses. None
// of that was pinned by any test, so nothing pushed back on the belief.
// ---------------------------------------------------------------------------

assert(
  "launchd plist still wraps the run in caffeinate",
  /<string>\/usr\/bin\/caffeinate<\/string>/.test(plist),
  null,
);
assert(
  "caffeinate drops -u (its assertion expires after 5s and -t cannot extend it in utility mode)",
  /<string>-dims<\/string>/.test(plist) && !/<string>-dimsu<\/string>/.test(plist),
  plist.match(/<string>-dim\w*<\/string>/)?.[0],
);
assert(
  "plist documents that -s is AC-only and -t is ignored in utility mode",
  /valid only when system is running on AC power/.test(plist) &&
    /not used when an utility is invoked/.test(plist),
  null,
);
assert(
  "launchd schedule is still 00:30 IST",
  /<key>Hour<\/key>\s*<integer>0<\/integer>/.test(plist) &&
    /<key>Minute<\/key>\s*<integer>30<\/integer>/.test(plist),
  null,
);

assert(
  "isolated wrapper waits for AC before starting (root-cause fix)",
  /SWS_NIGHTLY_AC_WAIT/.test(isolated) &&
    /pmset -g batt 2>\/dev\/null \| head -1 \| grep -q "AC Power"/.test(isolated),
  null,
);
assert(
  "AC wait is armed by default",
  /SWS_NIGHTLY_AC_WAIT="\$\{SWS_NIGHTLY_AC_WAIT:-1\}"/.test(isolated),
  null,
);
assert(
  "AC wait does not reuse SWS_NIGHTLY_SKIP_BATTERY (that would arm a second, conflicting gate in the body)",
  !/SWS_NIGHTLY_SKIP_BATTERY.*sws_on_ac|sws_on_ac.*SWS_NIGHTLY_SKIP_BATTERY/.test(isolated),
  null,
);
assert(
  "isolated wrapper bounds the run so it cannot suppress the next 00:30 slot",
  /SWS_NIGHTLY_DEADLINE_EPOCH/.test(isolated) && /set -m/.test(isolated),
  null,
);

// The installed plist is what launchd actually reads, and it has drifted from
// the repo copy before (reordered keys, stripped comments, an extra
// SWS_ALERT_HEARTBEAT). Editing the repo copy without reloading changes
// nothing at 00:30. Self-skips off this machine so CI stays green.
const INSTALLED_PLIST = join(homedir(), "Library/LaunchAgents/com.starbhai.sws-nightly.plist");
//
// Reported as a WARNING rather than a failure: reloading launchd is an operator
// action (`launchctl unload/load`), and the repo copy legitimately leads the
// installed one between merge and reload. A hard failure here would block every
// push on this machine for a step no code change can perform.
if (existsSync(INSTALLED_PLIST)) {
  const installed = readFileSync(INSTALLED_PLIST, "utf-8");
  const installedFlags = installed.match(/<string>-dim\w*<\/string>/)?.[0] ?? "(none found)";
  const repoFlags = plist.match(/<string>-dim\w*<\/string>/)?.[0] ?? "(none found)";
  if (installedFlags === repoFlags) {
    console.log("  ✓ installed plist matches the repo copy's caffeinate flags");
    pass++;
  } else {
    console.log(
      `  ⚠ installed plist has ${installedFlags}, repo copy has ${repoFlags} —` +
        " the power fix is NOT live until:\n" +
        "      launchctl unload ~/Library/LaunchAgents/com.starbhai.sws-nightly.plist\n" +
        "      cp scripts/com.starbhai.sws-nightly.plist ~/Library/LaunchAgents/\n" +
        "      launchctl load ~/Library/LaunchAgents/com.starbhai.sws-nightly.plist",
    );
  }
} else {
  console.log("  · installed plist not present (not this machine) — drift check skipped");
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
