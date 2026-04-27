// Interactive first-time login helper for an SWS Playwright profile.
//
// Why this exists: the scraper uses a persistent browser profile per shard
// (.sws-profile-{1,2,3}/). For each fresh profile we need to:
//   1. Solve any Cloudflare "verify you're human" challenge MANUALLY (one click).
//   2. Log into SWS so the auth cookies land in the profile dir.
//   3. Close the browser cleanly so cookies persist to disk.
//
// CRITICAL: this helper uses the SAME launch config as the actual scraper —
// same channel (system Chrome), same UA, same viewport, same timezone. That
// way the Cloudflare clearance cookie issued during your manual session is
// honoured during automated runs (CF binds clearance to a fingerprint).
//
// Usage:
//   node scripts/sws-setup-profile.mjs 1     # set up shard 1's profile
//   node scripts/sws-setup-profile.mjs 2
//   node scripts/sws-setup-profile.mjs 3
//
// Steps you'll perform in the browser window that opens:
//   1. If Cloudflare shows "Verify you are human" — click the checkbox
//      (do NOT close the page; let it complete).
//   2. SWS login page should appear → enter your email + password.
//   3. After successful login, navigate once to a stock page (e.g. RELIANCE)
//      to confirm premium content renders (snowflake numbers visible).
//   4. Close the browser window normally (Cmd+Q or red dot).
//   5. The script exits, profile dir now contains your auth cookies.
//
// You only need to do this ONCE per profile. Cookies persist across runs.

import { launchShardContext } from "./sws-stealth-context.mjs";
import { profileDirForShard } from "./sws-config.mjs";

async function main() {
  const shardId = Number(process.argv[2]);
  if (!Number.isInteger(shardId) || shardId < 1 || shardId > 3) {
    console.error("Usage: node scripts/sws-setup-profile.mjs <1|2|3>");
    process.exit(1);
  }

  const profileDir = profileDirForShard(shardId);
  console.log(`\nOpening browser with shard ${shardId}'s profile at:`);
  console.log(`  ${profileDir}\n`);
  console.log("Steps in the browser:");
  console.log("  1. If Cloudflare challenges — click the checkbox.");
  console.log("  2. Log into SWS (mtaluja11@gmail.com).");
  console.log("  3. Open one stock page (e.g. https://simplywall.st/stocks/in/energy/nse-reliance/reliance-industries-shares)");
  console.log("     to confirm premium data renders (snowflake numbers visible).");
  console.log("  4. Close the browser window when done.\n");
  console.log("Channel: " + (process.env.SWS_PLAYWRIGHT_CHANNEL ?? "chrome (system)"));
  console.log("Waiting for browser to launch...\n");

  const ctx = await launchShardContext(shardId, { headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  // Land on the login page directly. Cloudflare may interpose its own
  // challenge before this URL renders; that's fine — the user solves it.
  try {
    await page.goto("https://simplywall.st/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    console.error("Initial navigation timed out. The browser is still open — proceed manually.");
  }

  console.log("Browser is open. Close it when you're done logging in.");
  console.log("(This script will exit automatically when the last page closes.)\n");

  await new Promise((resolve) => {
    ctx.on("close", resolve);
    // Also resolve if the only page closes (user closed the tab).
    page.on("close", () => {
      // Give the context a moment to actually shut down before resolving.
      setTimeout(() => ctx.close().catch(() => {}).finally(resolve), 2000);
    });
  });

  console.log(`\n✓ Profile saved to ${profileDir}`);
  console.log(`  Test the scraper: node scripts/sws-scrape-playwright.mjs ${shardId} --max 1 --ignore-window`);
}

main().catch((e) => { console.error(e); process.exit(1); });
