#!/usr/bin/env node
/**
 * One-time interactive session bootstrap for the Phase-3 Telegram listener.
 *
 * MTProto needs a USER session (a bot can't read third-party channels). This
 * logs in once with your api_id/api_hash + phone, Telegram sends a code to your
 * Telegram app, you enter it (and your 2FA cloud password if set), and it
 * prints a StringSession. Paste that into .env as TG_SESSION — the headless
 * listener then runs without ever logging in again.
 *
 * This MUST be run by the account owner (it prompts for your phone/code/2FA);
 * it cannot be automated. Run it in a normal terminal from the repo root:
 *
 *   node scripts/telegram-session-login.mjs            # produce TG_SESSION
 *   node scripts/telegram-session-login.mjs --list     # also list your channels
 *
 * The printed session string grants full access to your account — treat it
 * like a password. It only goes in .env (gitignored).
 */

import path from "path";
import { fileURLToPath } from "url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

const pkg = await import("telegram");
const { TelegramClient } = pkg;
const sessionsMod = await import("telegram/sessions/index.js");
const { StringSession } = sessionsMod;

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const LIST = process.argv.includes("--list");

if (!apiId || !apiHash) {
  console.error("Missing TG_API_ID / TG_API_HASH in .env (get them from my.telegram.org → API development tools).");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

async function main() {
  const client = new TelegramClient(new StringSession(process.env.TG_SESSION || ""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => (await ask("Phone (international format, e.g. +9198…): ")).trim(),
    password: async () => (await ask("2FA cloud password (blank if none): ")).trim(),
    phoneCode: async () => (await ask("Login code (sent to your Telegram app): ")).trim(),
    onError: (err) => console.error("login error:", err?.message || err),
  });

  const sessionString = client.session.save();
  console.log("\n=== SUCCESS — add this line to .env (keep it secret) ===");
  console.log(`TG_SESSION=${sessionString}`);
  console.log("========================================================\n");

  if (LIST) {
    console.log("Your channels (use @username or the numeric id in data/alerts/channels.json):");
    const dialogs = await client.getDialogs({ limit: 200 });
    for (const d of dialogs) {
      if (d.isChannel || d.isGroup) {
        const ent = d.entity || {};
        const uname = ent.username ? `@${ent.username}` : "(private — use id)";
        console.log(`  ${String(d.id)}  ${uname}  ${d.title}`);
      }
    }
  }

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("fatal:", err?.message || err);
  rl.close();
  process.exit(1);
});
