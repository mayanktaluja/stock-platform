#!/usr/bin/env node
/**
 * One-shot cleanup of the legacy globally-shared portfolio.
 *
 * The pre-PR codebase backed every login with a single shared
 * `portfolio.json` (file in dev) / `portfolio:data` KV key (prod). After
 * per-user namespacing landed, that legacy storage is orphaned — the new
 * code never reads or writes it. This script deletes both so the data
 * doesn't sit around indefinitely.
 *
 * Usage:
 *   node scripts/cleanup-global-portfolio.mjs
 *   npm run cleanup:global-portfolio
 *
 * Safe to re-run: missing file/KV-key are treated as no-ops.
 */

import { existsSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LEGACY_FILE = path.join(REPO_ROOT, "portfolio.json");
const LEGACY_KV_KEY = "portfolio:data";

async function main() {
  let removed = 0;

  // Local file
  if (existsSync(LEGACY_FILE)) {
    unlinkSync(LEGACY_FILE);
    console.log(`✓ Removed legacy file: ${LEGACY_FILE}`);
    removed++;
  } else {
    console.log(`· No legacy file at ${LEGACY_FILE}`);
  }

  // Vercel KV
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { kv } = await import("@vercel/kv");
      const existed = await kv.get(LEGACY_KV_KEY);
      if (existed != null) {
        await kv.del(LEGACY_KV_KEY);
        console.log(`✓ Removed legacy KV key: ${LEGACY_KV_KEY}`);
        removed++;
      } else {
        console.log(`· No legacy KV key at ${LEGACY_KV_KEY}`);
      }
    } catch (err) {
      console.warn(`! KV cleanup failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("· KV not configured (set KV_REST_API_URL + KV_REST_API_TOKEN to clean prod)");
  }

  console.log(`\nDone. Removed ${removed} legacy storage location(s).`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
