import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.NODE_ENV = "test";
const ROOT = process.cwd();
const PORT = 4142;
const FEED = path.join(ROOT, "data", "sws", "discovery-feed-latest.json");

function backup(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function restore(file, prior) {
  if (prior === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, prior);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function waitForServer(child) {
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (out.includes(`http://localhost:${PORT}`)) return;
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${out}`);
}

const prior = backup(FEED);
let child;

// Feed body sans generated_at; each case overrides generated_at to drive the gate.
const baseFeed = {
  schema_version: "sws-discovery-feed-v1",
  run_id: "api-test-run",
  available: true,
  lanes: [
    { id: "future_breakout", label: "Future Breakout" },
    { id: "off_section_high_future", label: "Off-section High Future" },
    { id: "momentum_news_confirmed", label: "Momentum + News" },
    { id: "upgrade_watch", label: "Upgrade Watch" },
  ],
  counts: { universe: 2, items: 1, future_breakout: 0, off_section_high_future: 1, momentum_news_confirmed: 0, upgrade_watch: 0 },
  items: [{ ticker: "FINOPB", lanes: [{ id: "off_section_high_future", label: "Off-section High Future" }], caution_flags: [] }],
  sections: { future_breakout: [], off_section_high_future: [{ ticker: "FINOPB" }], momentum_news_confirmed: [], upgrade_watch: [] },
};

async function fetchFeed() {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/sws-discovery-feed`);
  assert.equal(r.status, 200);
  return r.json();
}

try {
  // Case 1 — a feed generated 2026-06-18 is far past the 48h budget → stale.
  writeJson(FEED, { ...baseFeed, generated_at: "2026-06-18T04:00:00.000Z" });

  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test", AUTH_ENABLED: "false", PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);

  const res = await fetch(`http://127.0.0.1:${PORT}/api/sws-discovery-feed`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") || "", /max-age=300/);
  const body = await res.json();
  assert.equal(body.schema_version, "sws-discovery-feed-v1");
  assert.equal(body.available, true);
  assert.equal(body.run_id, "api-test-run");
  assert.equal(body.items[0].ticker, "FINOPB");
  assert.ok(Array.isArray(body.lanes));
  assert.ok(body.sections.off_section_high_future.length === 1);
  // LAYER C: server stamps stale/age_hours from generated_at.
  assert.equal(body.stale, true, ">48h feed is served stale");
  assert.equal(body.stale_threshold_hours, 48, "threshold surfaced for the client to mirror");
  assert.ok(body.age_hours > 48, "age_hours reflects the real feed age");

  // Case 2 — a feed generated 1h ago is fresh (available:true, stale:false).
  writeJson(FEED, { ...baseFeed, generated_at: new Date(Date.now() - 3_600_000).toISOString() });
  const fresh = await fetchFeed();
  assert.equal(fresh.available, true);
  assert.equal(fresh.stale, false, "<48h feed is not stale");
  assert.ok(fresh.age_hours != null && fresh.age_hours < 48, "fresh age_hours is small and non-null");

  // Case 3 — null generated_at can't prove freshness → stale, age_hours null.
  writeJson(FEED, { ...baseFeed, generated_at: null });
  const nul = await fetchFeed();
  assert.equal(nul.stale, true, "null generated_at is treated as stale");
  assert.equal(nul.age_hours, null, "null generated_at yields null age_hours");
} finally {
  if (child) child.kill("SIGTERM");
  restore(FEED, prior);
}

console.log("sws discovery feed API schema ok");
