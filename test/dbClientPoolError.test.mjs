// Regression test for the pg.Pool 'error' listener attached in db/client.js.
//
// Background: the 2026-05-17 nightly crashed shard 2 because the pg.Pool had
// no 'error' listener. Neon's serverless compute auto-suspends idle backends
// and sends FATAL "terminating connection due to administrator command"; with
// no listener, Node escalates the EventEmitter 'error' into a process crash.
//
// Two modes:
//   1. Default (no DATABASE_URL or SWS_TEST_LIVE_DB unset) — assert that the
//      Pool constructed by db/client.js has at least one 'error' listener.
//      Uses a syntactically-valid throwaway URL so the Pool constructs
//      without actually connecting (pg.Pool is lazy).
//   2. SWS_TEST_LIVE_DB=1 + DATABASE_URL_UNPOOLED set — actually terminate
//      the backend and prove the next query succeeds (the pool transparently
//      replaces the dead client). Opt-in to avoid hammering a real DB.

import test from "node:test";
import assert from "node:assert/strict";

import { getDb, closeDb, isDbConfigured } from "../db/client.js";

const LIVE = process.env.SWS_TEST_LIVE_DB === "1" && isDbConfigured();

test("db/client.js: pg.Pool has an 'error' listener attached", async () => {
  // Save + restore env so this test is hermetic regardless of how the suite
  // is invoked.
  const savedDriver = process.env.SWS_DB_DRIVER;
  const savedUrl = process.env.DATABASE_URL;
  const savedUnpooled = process.env.DATABASE_URL_UNPOOLED;
  // Use a throwaway URL — pg.Pool does NOT connect at construction; it only
  // dials when you call pool.connect() or pool.query(). So this never makes
  // a network attempt.
  if (!LIVE) {
    process.env.DATABASE_URL_UNPOOLED = "postgres://test:test@127.0.0.1:1/test";
    process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  }
  process.env.SWS_DB_DRIVER = "pool";

  try {
    const db = await getDb({ driver: "pool" });
    assert.ok(db.__pool, "expected drizzle wrapper to expose __pool");
    const n = db.__pool.listenerCount("error");
    assert.ok(
      n >= 1,
      `pg.Pool must have ≥1 'error' listener (got ${n}). ` +
        "Without it, Neon FATAL disconnects crash the process — see " +
        "data/sws/_sanity/2026-05-17T00-04-47-368Z.json (shards_failed=1).",
    );
  } finally {
    await closeDb();
    if (savedDriver === undefined) delete process.env.SWS_DB_DRIVER;
    else process.env.SWS_DB_DRIVER = savedDriver;
    if (!LIVE) {
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
      if (savedUnpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = savedUnpooled;
    }
  }
});

test("db/client.js: pool survives a backend-side termination (live)", { skip: !LIVE }, async () => {
  const savedDriver = process.env.SWS_DB_DRIVER;
  process.env.SWS_DB_DRIVER = "pool";

  try {
    const db = await getDb({ driver: "pool" });
    const pool = db.__pool;

    // Grab a client, terminate its own backend. pg should emit 'error' on the
    // pool; our listener catches it, the pool discards the dead client, and
    // the next acquire creates a fresh one.
    const c1 = await pool.connect();
    try {
      await c1.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => {
        // Self-termination returns an error to the issuing query — expected.
      });
    } finally {
      try { c1.release(true); } catch { /* dead client */ }
    }

    // Give the pool a tick to process the 'error' event.
    await new Promise((r) => setTimeout(r, 200));

    // A fresh query MUST succeed. If the listener weren't attached, the
    // process would already be dead and we wouldn't reach this line.
    const res = await pool.query("SELECT 1 AS ok");
    assert.equal(res.rows[0].ok, 1);
  } finally {
    await closeDb();
    if (savedDriver === undefined) delete process.env.SWS_DB_DRIVER;
    else process.env.SWS_DB_DRIVER = savedDriver;
  }
});
