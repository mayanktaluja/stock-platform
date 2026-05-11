#!/usr/bin/env node
/**
 * Apply pending Drizzle migrations against the Neon database.
 *
 *   $ node db/migrate.mjs
 *
 * Uses the direct (unpooled) URL — DDL can't go through PgBouncer.
 * Idempotent: each migration is recorded in drizzle's __drizzle_migrations
 * table, so re-running this script is a no-op once everything is applied.
 */

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set.");
  console.error("[migrate] Provision a Neon project first; see .env.example.");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
const db = drizzle(pool);

try {
  console.log("[migrate] Applying migrations from ./db/migrations …");
  await migrate(db, { migrationsFolder: path.join(__dirname, "migrations") });
  console.log("[migrate] OK.");
} catch (err) {
  console.error(`[migrate] FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
