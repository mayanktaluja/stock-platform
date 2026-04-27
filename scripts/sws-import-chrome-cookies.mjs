// Import simplywall.st cookies from your real macOS Chrome profile into the
// Playwright .sws-profile/ — so the scraper starts already-logged-in as you,
// no manual login needed.
//
// How it works:
//   1. Reads your Chrome cookie DB at ~/Library/Application Support/Google/Chrome/Default/Cookies
//      (a SQLite file). Chrome must be CLOSED — the DB is locked while it runs.
//   2. Pulls your Chrome Safe Storage key from Keychain (same Mac user account).
//   3. Decrypts each cookie value (Chrome uses AES-128-CBC w/ PBKDF2 salt
//      "saltysalt", 1003 iterations).
//   4. Filters for simplywall.st cookies (auth + Cloudflare clearance).
//   5. Launches Playwright against .sws-profile/ in headless mode and injects
//      the cookies via context.addCookies(). Cookies persist in the profile
//      dir on context close — automated runs reuse them.
//
// Usage:
//   node scripts/sws-import-chrome-cookies.mjs                  # Default profile (Mayank)
//   node scripts/sws-import-chrome-cookies.mjs --profile "Default"
//   node scripts/sws-import-chrome-cookies.mjs --check-only     # don't write,
//                                                                # just decrypt
//                                                                # and report
//
// Pre-flight: this script will refuse if Chrome is currently running. Quit
// Chrome (Cmd+Q), run the script (~5 seconds), then reopen Chrome.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { profileDirForShard, SHARED_FINGERPRINT } from "./sws-config.mjs";

const HOME = os.homedir();
const CHROME_USER_DATA = path.join(HOME, "Library/Application Support/Google/Chrome");

// ---------- 1. Pre-flight ----------

function isChromeRunning() {
  const r = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf-8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// ---------- 2. Keychain → encryption key ----------

function getChromeSafeStorageKey() {
  // Equivalent to:
  //   security find-generic-password -wga "Chrome" -s "Chrome Safe Storage"
  // Returns the raw password from Keychain. May prompt for keychain unlock.
  let pwd;
  try {
    pwd = execSync(
      'security find-generic-password -wa "Chrome" -s "Chrome Safe Storage" 2>/dev/null',
      { encoding: "utf-8" },
    ).trim();
  } catch (e) {
    throw new Error(
      "Could not read Chrome's encryption key from macOS Keychain.\n" +
      "If a Keychain dialog appeared, click 'Always Allow' and re-run.\n" +
      "Manual workaround: open Keychain Access, find 'Chrome Safe Storage',\n" +
      "and grant access to the 'security' utility.",
    );
  }
  if (!pwd) throw new Error("Empty Keychain entry for Chrome Safe Storage.");
  // Chrome on macOS uses PBKDF2-HMAC-SHA1, salt='saltysalt', iter=1003, keylen=16.
  return crypto.pbkdf2Sync(pwd, "saltysalt", 1003, 16, "sha1");
}

// ---------- 3. Read SQLite cookies via the system sqlite3 CLI ----------

function readSimplyWallCookies(chromeProfileDir) {
  const cookiesDb = path.join(chromeProfileDir, "Cookies");
  if (!fs.existsSync(cookiesDb)) {
    throw new Error(`No Cookies file at: ${cookiesDb}`);
  }
  // Copy to /tmp first to avoid any "database is locked" race even if Chrome
  // is gracefully closed but still releasing the file.
  const tmpDb = path.join(os.tmpdir(), `sws-cookies-${process.pid}.sqlite`);
  fs.copyFileSync(cookiesDb, tmpDb);
  // Also copy the WAL/SHM if present so we get the latest committed state.
  for (const sfx of ["-wal", "-shm"]) {
    if (fs.existsSync(cookiesDb + sfx)) {
      fs.copyFileSync(cookiesDb + sfx, tmpDb + sfx);
    }
  }

  // Output as tab-separated rows; encode encrypted_value as hex so JSON-style
  // parsing wouldn't lose binary bytes.
  const sql = `SELECT host_key, name, hex(encrypted_value), value, path,
                      expires_utc, is_secure, is_httponly, samesite
               FROM cookies
               WHERE host_key LIKE '%simplywall.st%';`;
  const out = execSync(`sqlite3 -separator $'\\t' "${tmpDb}" "${sql}"`, {
    encoding: "utf-8",
  });
  // Cleanup tmp.
  for (const f of [tmpDb, tmpDb + "-wal", tmpDb + "-shm"]) {
    try { fs.unlinkSync(f); } catch {}
  }

  const rows = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 9) continue;
    const [host, name, hexEnc, plain, cookiePath, expiresUtc, isSecure, isHttpOnly, samesite] = parts;
    rows.push({
      host_key: host,
      name,
      encrypted_hex: hexEnc,
      plain_value: plain,
      path: cookiePath,
      expires_utc: BigInt(expiresUtc),
      is_secure: Number(isSecure),
      is_httponly: Number(isHttpOnly),
      samesite: Number(samesite),
    });
  }
  return rows;
}

// ---------- 4. Decrypt a v10/v11 encrypted_value ----------

// Cookie values should be printable ASCII (URL-safe). Any byte < 0x20 or
// >= 0x7F in the supposed value indicates we have the wrong slice point.
function looksLikeCookieValue(s) {
  if (!s || s.length === 0) return false;
  // Test the first 32 chars (or whole string if shorter). Allow tab+newline
  // even though they shouldn't appear, to be safe.
  const sample = s.slice(0, 32);
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 0x20 && c !== 0x09) return false;
    if (c === 0xfffd) return false; // utf-8 decode replacement
  }
  return true;
}

function decryptChromeCookie(hex, key) {
  if (!hex) return null;
  const buf = Buffer.from(hex, "hex");
  if (buf.length === 0) return null;
  const prefix = buf.slice(0, 3).toString("utf-8");
  if (prefix !== "v10" && prefix !== "v11") {
    // Older Chrome stores plaintext directly in `value` — caller falls back.
    return null;
  }
  const ciphertext = buf.slice(3);
  const iv = Buffer.alloc(16, 0x20); // 16 bytes of ASCII space
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Modern Chrome (v130+) prepends a 32-byte binary SHA256(host_key) before
    // the actual value. Older Chrome stores the value directly. Try both
    // slice points and pick whichever produces a clean printable string.
    const stripped = dec.length > 32 ? dec.slice(32).toString("utf-8") : "";
    const bare = dec.toString("utf-8");
    if (looksLikeCookieValue(stripped)) return stripped;
    if (looksLikeCookieValue(bare)) return bare;
    return null;
  } catch (e) {
    return null;
  }
}

// ---------- 5. Convert to Playwright cookie format ----------

function chromeExpiresToUnixSeconds(chromeUtcMicroseconds) {
  // Chrome stores microseconds since 1601-01-01 UTC (Windows epoch).
  // Convert to seconds since 1970-01-01 UTC (Unix epoch).
  const WINDOWS_EPOCH_DELTA_S = 11644473600n;
  const sec = chromeUtcMicroseconds / 1000000n - WINDOWS_EPOCH_DELTA_S;
  return Number(sec);
}

function toPlaywrightCookie(row, decryptedValue) {
  // Chrome's samesite: -1 unspecified, 0 None, 1 Lax, 2 Strict.
  // Playwright requires Strict|Lax|None; "None" requires secure=true.
  let sameSite;
  switch (Number(row.samesite)) {
    case 2: sameSite = "Strict"; break;
    case 1: sameSite = "Lax"; break;
    case 0: sameSite = row.is_secure ? "None" : "Lax"; break;
    default: sameSite = "Lax";
  }
  return {
    name: row.name,
    value: decryptedValue ?? row.plain_value ?? "",
    domain: row.host_key,
    path: row.path || "/",
    expires: row.expires_utc > 0n ? chromeExpiresToUnixSeconds(row.expires_utc) : -1,
    httpOnly: !!row.is_httponly,
    secure: !!row.is_secure,
    sameSite,
  };
}

// ---------- 6. Inject into Playwright persistent context ----------

async function injectIntoPlaywright(cookies, profileDir) {
  const { chromium: extra } = await import("playwright-extra");
  const stealth = (await import("puppeteer-extra-plugin-stealth")).default;
  extra.use(stealth());

  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await extra.launchPersistentContext(profileDir, {
    headless: true,
    channel: process.env.SWS_PLAYWRIGHT_CHANNEL ?? "chrome",
    viewport: SHARED_FINGERPRINT.viewport,
    userAgent: SHARED_FINGERPRINT.userAgent,
    timezoneId: SHARED_FINGERPRINT.timezoneId,
    locale: SHARED_FINGERPRINT.locale,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  // Add cookies one by one so a single bad cookie doesn't reject the whole batch.
  let injected = 0, rejected = 0;
  for (const c of cookies) {
    try { await ctx.addCookies([c]); injected++; }
    catch (e) {
      rejected++;
      process.stderr.write(`  ✗ rejected: ${c.name} (${e.message.slice(0, 80)})\n`);
    }
  }
  process.stderr.write(`  injected: ${injected}, rejected: ${rejected}\n`);
  // Brief navigation to https://simplywall.st/ — this commits the cookies to
  // the profile's Cookies SQLite (Playwright writes them on next page navigate).
  const page = ctx.pages()[0] || await ctx.newPage();
  let loggedIn = false;
  let pageTitle = "";
  try {
    await page.goto("https://simplywall.st/dashboard", { timeout: 45000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    pageTitle = await page.title();
    const url = page.url();
    const txt = await page.evaluate(() => document.body && document.body.innerText || "");
    loggedIn = !url.includes("/login") && (txt.includes("Portfolio") || txt.includes("Watchlist") || txt.includes("Dashboard"));
  } catch (e) {
    pageTitle = "(navigation failed: " + e.message + ")";
  }
  await ctx.close();
  return { loggedIn, pageTitle };
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check-only");
  let profile = "Default";
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--profile") profile = args[i + 1];
  }

  if (isChromeRunning()) {
    console.error("");
    console.error("⚠ Google Chrome is currently running.");
    console.error("  Please QUIT Chrome (Cmd+Q) and re-run this script.");
    console.error("  The cookie database is locked while Chrome is open.");
    console.error("");
    process.exit(2);
  }

  const chromeProfileDir = path.join(CHROME_USER_DATA, profile);
  if (!fs.existsSync(chromeProfileDir)) {
    console.error(`Chrome profile directory not found: ${chromeProfileDir}`);
    process.exit(2);
  }
  console.log(`Reading cookies from: ${chromeProfileDir}`);

  const key = getChromeSafeStorageKey();
  console.log("✓ Got Chrome encryption key from Keychain.");

  const rows = readSimplyWallCookies(chromeProfileDir);
  console.log(`✓ Found ${rows.length} simplywall.st cookies in Chrome.`);

  const playwrightCookies = [];
  let decryptedCount = 0;
  let plaintextCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const decrypted = decryptChromeCookie(row.encrypted_hex, key);
    if (decrypted !== null) decryptedCount++;
    else if (row.plain_value) plaintextCount++;
    else { failedCount++; continue; }
    playwrightCookies.push(toPlaywrightCookie(row, decrypted));
  }
  console.log(`  decrypted: ${decryptedCount}, plaintext: ${plaintextCount}, failed: ${failedCount}`);

  // Show high-value cookies (don't print values).
  const interesting = playwrightCookies.filter((c) =>
    /session|auth|token|cf_clearance|cf_bm|swl|sws/i.test(c.name)
  );
  if (interesting.length) {
    console.log("Notable cookies present:");
    for (const c of interesting) console.log(`  - ${c.name} (${c.domain}) expires=${c.expires === -1 ? "session" : new Date(c.expires * 1000).toISOString()}`);
  } else {
    console.warn("  (no obvious auth/session cookies found — login may not be active in your Chrome)");
  }

  if (checkOnly) {
    console.log("\n--check-only: not injecting into Playwright profile.");
    return;
  }

  // Seed all 3 shard profiles from the same source — they all run as Mayank.
  // Per-shard concurrency requires per-shard userDataDirs (Chrome locks each).
  const SHARDS = [1, 2, 3];
  const results = [];
  for (const shardId of SHARDS) {
    const targetProfile = profileDirForShard(shardId);
    console.log(`\n[shard ${shardId}] Injecting ${playwrightCookies.length} cookies into: ${targetProfile}`);
    const { loggedIn, pageTitle } = await injectIntoPlaywright(playwrightCookies, targetProfile);
    results.push({ shardId, loggedIn, pageTitle, targetProfile });
    if (loggedIn) {
      console.log(`  ✓ Login confirmed. Dashboard title: ${pageTitle}`);
    } else {
      console.warn(`  ⚠ Login NOT confirmed. Page title: ${pageTitle}`);
    }
  }

  const goodCount = results.filter((r) => r.loggedIn).length;
  console.log(`\n${goodCount}/${SHARDS.length} shard profiles ready.`);
  if (goodCount === SHARDS.length) {
    console.log("All 3 shards good. Test in parallel:");
    console.log("  node scripts/sws-scrape-playwright.mjs 1 --max 1 --ignore-window &");
    console.log("  node scripts/sws-scrape-playwright.mjs 2 --max 1 --ignore-window &");
    console.log("  node scripts/sws-scrape-playwright.mjs 3 --max 1 --ignore-window &");
    console.log("  wait");
  } else {
    console.warn("\nFor any failed shard:");
    console.warn("  Fall back to manual: node scripts/sws-setup-profile.mjs <N>");
  }
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
