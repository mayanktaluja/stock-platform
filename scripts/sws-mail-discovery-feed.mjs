#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sendMail } from "../services/resendMailer.js";
import { buildDiscoveryFeedEmail } from "../services/swsDiscoveryFeed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");
const FEED_PATH = path.join(ROOT, "data", "sws", "discovery-feed-latest.json");

function loadDotEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const raw of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

loadDotEnvLocal();

if (process.env.SWS_DISCOVERY_MAIL_ENABLED === "0" || process.env.SWS_MAIL_ENABLED === "0") {
  console.log("[discovery-mail] disabled by env");
  process.exit(0);
}

const feed = JSON.parse(fs.readFileSync(FEED_PATH, "utf-8"));
const email = buildDiscoveryFeedEmail(feed, {
  baseUrl: process.env.STARBHAI_BASE_URL || "https://starbhai-stock-platform.vercel.app",
});
const dryRun = process.argv.includes("--dry-run") || process.env.SWS_DISCOVERY_MAIL_DRY_RUN === "1";
const result = await sendMail({
  to: process.env.SWS_DISCOVERY_MAIL_TO || process.env.SWS_MAIL_TO || "mtaluja11@gmail.com",
  from: process.env.SWS_MAIL_FROM || process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
  subject: email.subject,
  text: email.text,
  html: email.html,
}, { dryRun });

if (!result.ok) {
  console.error(`[discovery-mail] failed: ${result.error || result.reason || "unknown"}`);
  process.exit(1);
}
if (result.skipped) {
  console.log(`[discovery-mail] skipped reason=${result.reason || "unknown"} items=${feed.counts?.items || 0}`);
} else {
  console.log(`[discovery-mail] sent id=${result.id || "unknown"} items=${feed.counts?.items || 0}`);
}
