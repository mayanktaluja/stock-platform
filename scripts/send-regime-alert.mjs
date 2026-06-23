#!/usr/bin/env node
/**
 * Send a macro-regime-transition Telegram alert.
 *
 * Called by scripts/refresh-macro-only.sh AFTER a commit whose ship-gate
 * decision was `ship:material_change` — i.e. regime|severity actually flipped
 * vs the committed origin/main snapshot. That gate is the dedup: this script
 * does NOT re-derive "is this a transition", it trusts the caller and just
 * renders + sends. (Adversarial C1/C2: triggering on macroRegimeHistory's
 * appended:true would re-fire every 2h on sub-regime drift and the dedup
 * ledger would vanish with the throwaway worktree — so neither is used here.)
 *
 * Reads the fresh regime from cwd's data/macroRegime.json (the cron runs this
 * inside its worktree where the new file lives) and the previous regime from
 * `git show origin/main:data/macroRegime.json` for the transition arrow.
 *
 * Always exits 0 — an alert failure must never change the cron's exit code.
 *
 * Usage:
 *   node scripts/send-regime-alert.mjs            # read data/macroRegime.json
 *   node scripts/send-regime-alert.mjs --dry-run  # format + log, no send
 *   node scripts/send-regime-alert.mjs --file path/to/regime.json   # smoke
 */

import { readFileSync, existsSync } from "fs";
import { spawnSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Defensive .env load (the cron already sources it, but a manual smoke may not).
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

const { formatRegimeAlert } = await import("../services/alerts/regimeAlert.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const fileArgIdx = argv.indexOf("--file");
const regimeFile = fileArgIdx >= 0 ? argv[fileArgIdx + 1] : path.join(process.cwd(), "data", "macroRegime.json");

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return null; }
}

function readPrevFromGit() {
  try {
    const r = spawnSync("git", ["show", "origin/main:data/macroRegime.json"], { encoding: "utf-8" });
    if (r.status === 0 && r.stdout) return JSON.parse(r.stdout);
  } catch { /* first run / detached / no remote — fine */ }
  return null;
}

async function main() {
  if (!existsSync(regimeFile)) {
    console.warn(`[regime-alert] no regime file at ${regimeFile} — nothing to send`);
    return 0;
  }
  const regime = readJsonSafe(regimeFile);
  if (!regime || typeof regime.regime !== "string") {
    console.warn(`[regime-alert] unreadable/invalid regime at ${regimeFile} — skipping`);
    return 0;
  }

  const prev = readPrevFromGit();
  const alert = formatRegimeAlert(regime, prev);
  if (!alert) {
    console.warn("[regime-alert] formatter returned null — skipping");
    return 0;
  }

  const res = await dispatch(alert, { dryRun: DRY_RUN });
  if (DRY_RUN) {
    console.log("[regime-alert] DRY RUN — alert text:");
    console.log(alert.text);
  }
  console.log(`[regime-alert] result: ${JSON.stringify({ ok: res.ok, skipped: res.skipped, reason: res.reason })}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Never escalate — the cron must not fail because an alert failed.
    console.warn(`[regime-alert] fatal (swallowed): ${err.message}`);
    process.exit(0);
  });
