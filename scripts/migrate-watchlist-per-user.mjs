#!/usr/bin/env node
/**
 * One-shot watchlist migration — global → per-user (auth iter 2).
 *
 * Before auth iter 2 the watchlist was a single shared list:
 *   FILE: `.watchlist.json` as a bare JSON array
 *   KV:   hash `watchlist:items` (field=symbol, value=JSON item)
 *
 * watchlistStorage.js now keys every list by the Google `sub`. This script
 * copies the legacy shared list into ONE owner namespace so the owner's
 * saved watchlist survives the cutover. New users start empty (correct).
 *
 * NON-DESTRUCTIVE: the legacy key/array is left untouched, so a bad run is
 * fully reversible (re-run, or point at a different --sub).
 *
 * Run once per backend:
 *   node scripts/migrate-watchlist-per-user.mjs --sub <ownerSub> --dry-run
 *   node scripts/migrate-watchlist-per-user.mjs --sub <ownerSub>            # file (local)
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... \
 *     node scripts/migrate-watchlist-per-user.mjs --sub <ownerSub>          # prod KV
 *
 * The owner `sub` is the Google subject id — read it from users.json /
 * the `user:{sub}` KV record (whichever backend is live).
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getWatchlistStorage } from "../watchlistStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const LEGACY_FILE = path.join(REPO_ROOT, ".watchlist.json");
const LEGACY_KV_KEY = "watchlist:items";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const OWNER_SUB = arg("--sub");
const DRY_RUN = process.argv.includes("--dry-run");

if (!OWNER_SUB) {
  console.error("ERROR: --sub <ownerSub> is required (the Google subject id to migrate the legacy list into).");
  process.exit(2);
}

async function readLegacyFromFile() {
  if (!existsSync(LEGACY_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_FILE, "utf-8"));
    // Only a bare array is the legacy shape. A per-sub map means already migrated.
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readLegacyFromKV() {
  const mod = await import("@vercel/kv");
  const kv = mod.kv;
  const all = await kv.hgetall(LEGACY_KV_KEY);
  if (!all) return [];
  return Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
}

async function main() {
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  const backend = hasKV ? "vercel-kv" : "file";
  console.log(`[migrate-watchlist] backend=${backend} owner=${OWNER_SUB} dryRun=${DRY_RUN}`);

  const legacy = hasKV ? await readLegacyFromKV() : await readLegacyFromFile();
  if (!legacy.length) {
    console.log("[migrate-watchlist] legacy list is empty — nothing to migrate.");
    return;
  }
  console.log(`[migrate-watchlist] legacy list has ${legacy.length} item(s): ${legacy.map((i) => i.symbol).join(", ")}`);

  if (DRY_RUN) {
    console.log("[migrate-watchlist] --dry-run: no writes performed.");
    return;
  }

  const storage = getWatchlistStorage();
  let added = 0, skipped = 0;
  for (const item of legacy) {
    if (!item || !item.symbol) { skipped++; continue; }
    const r = await storage.add(OWNER_SUB, item);
    if (r.action === "added") added++;
    else skipped++;
  }
  const final = await storage.read(OWNER_SUB);
  console.log(`[migrate-watchlist] done — added=${added} skipped=${skipped}; owner now has ${final.length} item(s).`);
  console.log("[migrate-watchlist] legacy key left intact (non-destructive).");
}

main().catch((err) => {
  console.error("[migrate-watchlist] FAILED:", err.message);
  process.exit(1);
});
