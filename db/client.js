// Lazy Drizzle client. Picks the right driver for the environment:
//
//   * Inside Vercel routes (short-lived requests): @neondatabase/serverless
//     HTTP driver — no pool to keep warm across cold starts.
//   * Inside long-lived pipeline scripts (sws-refresh-api.sh): pg.Pool over
//     the direct unpooled URL.
//
// The right driver is picked at first call. Default = HTTP. Pass
// `{ driver: "pool" }` to force pg.Pool (pipeline scripts opt in via the
// SWS_DB_DRIVER=pool env var when sourced from inside sws-refresh-api.sh).
//
// All DB reads/writes go through services/swsDal — this module is
// internal and shouldn't be imported by route handlers or services
// directly.

import "dotenv/config";

let _db = null;
let _driverKind = null;

function pickUrl(driverKind) {
  if (driverKind === "pool") {
    return process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || null;
  }
  return process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || null;
}

export function isDbConfigured() {
  return !!(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
}

export async function getDb(opts = {}) {
  const desired = opts.driver === "pool" ? "pool" : process.env.SWS_DB_DRIVER === "pool" ? "pool" : "http";
  if (_db && _driverKind === desired) return _db;

  const url = pickUrl(desired);
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. " +
        "Provision a Neon project and add DATABASE_URL + DATABASE_URL_UNPOOLED to your env. " +
        "See .env.example for details.",
    );
  }

  if (desired === "pool") {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: 5 });
    _db = drizzle(pool);
    _db.__pool = pool;
  } else {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const sqlClient = neon(url);
    _db = drizzle(sqlClient);
  }
  _driverKind = desired;
  return _db;
}

export async function closeDb() {
  if (_db?.__pool) await _db.__pool.end();
  _db = null;
  _driverKind = null;
}
