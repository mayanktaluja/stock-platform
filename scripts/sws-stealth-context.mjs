// Wraps Playwright's persistent-context launch with the stealth plugin and
// the shared fingerprint. Single source for all browser-launching.
//
// Single-profile design: all shards share .sws-profile/ and run sequentially
// (the daily rate cap is the binding constraint, not browser parallelism).
// One SWS login (or one cookie import from real Chrome) covers everything.

import fs from "node:fs";
import path from "node:path";
import { profileDirForShard as indiaProfileDirForShard, SHARED_FINGERPRINT as INDIA_FINGERPRINT } from "./sws-config.mjs";

// playwright-extra + stealth: wraps the chromium launcher to mask the headless
// fingerprint. Imported dynamically so this file can be required from the
// unit test even when the deps aren't installed yet.
async function loadStealthChromium() {
  const { chromium: extraChromium } = await import("playwright-extra");
  const stealth = (await import("puppeteer-extra-plugin-stealth")).default;
  extraChromium.use(stealth());
  return extraChromium;
}

export async function launchShardContext(shardId, { headless = false, devtools = false, cfg = null } = {}) {
  // `cfg` lets a sibling pipeline (e.g. the US fork) supply its own per-shard
  // profile dirs + fingerprint. Null = India config, so existing callers are
  // byte-for-byte unchanged.
  const profileDirForShard = cfg?.profileDirForShard || indiaProfileDirForShard;
  const userDataDir = profileDirForShard(shardId);
  fs.mkdirSync(userDataDir, { recursive: true });

  const fp = cfg?.SHARED_FINGERPRINT || INDIA_FINGERPRINT;

  // First-time setup hint: if the profile is empty, the user needs cookies.
  const looksEmpty =
    !fs.existsSync(path.join(userDataDir, "Default")) &&
    !fs.existsSync(path.join(userDataDir, "Cookies"));
  if (looksEmpty) {
    process.stderr.write(
      `Profile dir is empty: ${userDataDir}\n` +
        `   Recommended: import cookies from your real Chrome (no manual login):\n` +
        `     node scripts/sws-import-chrome-cookies.mjs\n` +
        `   Manual fallback: open + log in:\n` +
        `     node scripts/sws-setup-profile.mjs ${shardId}\n`,
    );
  }

  // Default to system Chrome (much harder for Cloudflare to fingerprint than
  // bundled Chromium). Override via SWS_PLAYWRIGHT_CHANNEL=chromium to use
  // the bundled binary if Chrome isn't installed.
  const channel = process.env.SWS_PLAYWRIGHT_CHANNEL ?? "chrome";

  const chromium = await loadStealthChromium();
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless,
    devtools,
    viewport: fp.viewport,
    userAgent: fp.userAgent,
    timezoneId: fp.timezoneId,
    locale: fp.locale,
    channel: channel || undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Belt-and-braces: nuke the webdriver flag at every new doc, even though
  // stealth already does it.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return ctx;
}

export function profilePathForShard(shardId) {
  return indiaProfileDirForShard(shardId);
}
