#!/usr/bin/env node
/**
 * Restore a committed pg_dump snapshot into a scratch DB for inspection.
 *
 *   $ node scripts/sws-load-snapshot.mjs 2026-05-11
 *   $ node scripts/sws-load-snapshot.mjs 2026-05-11 --target $SCRATCH_DB_URL
 *
 * Requires `pg_restore` on PATH. Refuses to load into a URL that looks
 * like production (anything matching the DATABASE_URL env var or
 * containing 'prod' in the host).
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SNAPSHOTS = path.join(ROOT, "data", "sws", "snapshots");

const args = process.argv.slice(2);
const date = args[0];
const targetIdx = args.indexOf("--target");
const target = targetIdx >= 0 ? args[targetIdx + 1] : process.env.SCRATCH_DATABASE_URL;

if (!date || !target) {
  console.error("Usage: sws-load-snapshot.mjs <YYYY-MM-DD> [--target <DATABASE_URL>]");
  console.error("Set SCRATCH_DATABASE_URL in env, or pass --target.");
  process.exit(1);
}

const prodUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "";
if (target === prodUrl || /prod/i.test(target)) {
  console.error("Refusing to restore into what looks like the production DB.");
  console.error("Provide a scratch DB URL via --target or SCRATCH_DATABASE_URL.");
  process.exit(1);
}

const dumpPath = path.join(SNAPSHOTS, `${date}.pg.dump.gz`);
if (!fs.existsSync(dumpPath)) {
  console.error(`Snapshot not found: ${dumpPath}`);
  console.error(`Available snapshots:`);
  try {
    const files = fs.readdirSync(SNAPSHOTS).filter((f) => f.endsWith(".pg.dump.gz"));
    files.sort().reverse().slice(0, 10).forEach((f) => console.error(`  - ${f}`));
  } catch {}
  process.exit(1);
}

console.log(`[load-snapshot] restoring ${dumpPath} → ${target.replace(/:[^@]+@/, ":****@")}`);

// gunzip -c <file> | pg_restore --no-owner --no-privileges -d $target
const gunzip = execFileSync("gunzip", ["-c", dumpPath]);
fs.writeFileSync("/tmp/sws-restore.bin", gunzip);
try {
  execFileSync(
    "pg_restore",
    ["--no-owner", "--no-privileges", "--clean", "--if-exists", "-d", target, "/tmp/sws-restore.bin"],
    { stdio: "inherit" },
  );
  console.log("[load-snapshot] OK");
} catch (err) {
  console.error(`[load-snapshot] pg_restore failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync("/tmp/sws-restore.bin"); } catch {}
}
