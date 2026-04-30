#!/usr/bin/env node
//
// Send a summary email via Resend. Lightweight wrapper used by the SWS
// refresh wrapper + health-check task to confirm cron completion.
//
// Usage:
//   node scripts/sws-mail-summary.mjs <subject> <body>
//   node scripts/sws-mail-summary.mjs <subject> -          # body from stdin
//   echo "..." | node scripts/sws-mail-summary.mjs "Subject" -
//
// Env (loaded from .env.local at the repo root if present, then process.env):
//   RESEND_API_KEY   — required (re_...)
//   SWS_MAIL_TO      — recipient (default: mtaluja11@gmail.com)
//   SWS_MAIL_FROM    — sender    (default: onboarding@resend.dev)
//   SWS_MAIL_ENABLED — set to "0" to disable sends entirely (no-op exit 0)
//
// Detects HTML body by presence of tags; otherwise sends plain text.
//
// Exit codes:
//   0 — sent (or skipped because disabled / no API key)
//   1 — Resend API rejected the send
//   2 — bad invocation

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "..", ".env.local");

// Minimal .env.local loader — keeps the script dependency-free so it can
// run from a cron context that may not have node_modules ready.
function loadDotEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const raw of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue; // shell wins over file
    let value = m[2];
    // Strip surrounding quotes if present
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

loadDotEnvLocal();

if (process.env.SWS_MAIL_ENABLED === "0") {
  console.log("[mail] SWS_MAIL_ENABLED=0 — skipping send");
  process.exit(0);
}

const API_KEY = process.env.RESEND_API_KEY;
const TO = process.env.SWS_MAIL_TO || "mtaluja11@gmail.com";
const FROM = process.env.SWS_MAIL_FROM || "onboarding@resend.dev";

if (!API_KEY) {
  console.error("[mail] RESEND_API_KEY not set — skipping send (set in .env.local)");
  process.exit(0);
}

const subject = process.argv[2];
const bodyArg = process.argv[3];
if (!subject || bodyArg === undefined) {
  console.error("usage: node scripts/sws-mail-summary.mjs <subject> <body | ->");
  process.exit(2);
}

const body = bodyArg === "-" ? fs.readFileSync(0, "utf-8") : bodyArg;
const isHtml = /<\w+[^>]*>/.test(body);

const payload = {
  from: FROM,
  to: [TO],
  subject,
  ...(isHtml ? { html: body } : { text: body }),
};

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
}).catch((e) => ({ ok: false, status: 0, text: async () => `network: ${e.message}` }));

const text = await res.text();
if (!res.ok) {
  console.error(`[mail] FAILED status=${res.status} body=${text.slice(0, 200)}`);
  process.exit(1);
}
try {
  const j = JSON.parse(text);
  console.log(`[mail] sent id=${j.id} to=${TO}`);
} catch {
  console.log(`[mail] sent (response not JSON): ${text.slice(0, 100)}`);
}
