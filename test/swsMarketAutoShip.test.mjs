/**
 * Static wiring guards for non-India market refresh auto-ship.
 *
 * Run with: node test/swsMarketAutoShip.test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const read = (p) => readFileSync(resolve(REPO_ROOT, p), "utf-8");

const autoShip = read("scripts/sws-auto-ship.sh");
const us = read("scripts/sws-refresh-us.sh");

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

console.log("\nSWS market auto-ship wiring\n");

assert(
  "shared helper creates ship branches from origin/main in a temporary worktree",
  /git -C "\$\{repo_root\}" fetch origin main/.test(autoShip) &&
    /worktree add -B "\$\{branch\}" "\$\{tmpdir\}" origin\/main/.test(autoShip),
  null,
);
assert(
  "shared helper uses local git + gh create + gh auto-merge with immediate fallback",
  /git -C "\$\{tmpdir\}" push -u origin "\$\{branch\}"/.test(autoShip) &&
    /gh pr create --base main --head "\$\{branch\}"/.test(autoShip) &&
    /gh pr merge "\$\{pr_url\}" --squash --auto/.test(autoShip) &&
    /gh pr merge "\$\{pr_url\}" --squash/.test(autoShip),
  null,
);
assert(
  "shared helper refuses seed/capped, failed-shard, skipped-scrape, missing-gh, and no-change runs",
  /SWS_SCRAPE_LIMIT/.test(autoShip) &&
    /SWS_SHIP_FAILED_SHARDS/.test(autoShip) &&
    /SWS_SHIP_SCRAPE_SKIPPED/.test(autoShip) &&
    /command -v gh/.test(autoShip) &&
    /diff --cached --quiet --exit-code/.test(autoShip),
  null,
);
assert(
  "shared helper validates usable picks-latest and last-refresh before market auto-ship",
  /SWS_SHIP_MIN_SCORED/.test(autoShip) &&
    /SWS_SHIP_PICKS_PATH/.test(autoShip) &&
    /SWS_SHIP_LAST_REFRESH_PATH/.test(autoShip) &&
    /finished_at/.test(autoShip),
  null,
);
assert(
  "shared helper exposes SWS_AUTO_PR and SWS_AUTO_MERGE escape hatches",
  /SWS_AUTO_PR/.test(autoShip) &&
    /SWS_AUTO_MERGE/.test(autoShip) &&
    /SWS_\$\{market_upper\}_AUTO_PR/.test(autoShip) &&
    /SWS_\$\{market_upper\}_AUTO_MERGE/.test(autoShip),
  null,
);

assert(
  "US refresh calls macro calendar, US index, US universe metadata, and shared auto-ship",
  /refresh-macro-calendar\.mjs/.test(us) &&
    /refresh-us-index-constituents\.mjs/.test(us) &&
    /sws-universe-from-sitemap-us\.mjs --write/.test(us) &&
    /sws_auto_ship_market/.test(us),
  null,
);
assert(
  "US refresh ships only US deployable artifacts plus global macro calendar",
  /data\/sws-us/.test(us) &&
    /deep-us\.tar\.gz/.test(us) &&
    /us-index-constituents\.json/.test(us) &&
    /universe-meta\.json/.test(us) &&
    /data\/macroCalendar\.json/.test(us),
  null,
);
assert(
  "US refresh does not run India-only auxiliary refreshes",
  !/refresh-fundamentals\.mjs|refresh-fo-oi\.sh|refresh-earnings\.mjs/.test(us),
  null,
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
