import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnServer, httpReady } from "./helpers/freePort.mjs";

const TEXT_MARKERS = [/Quality Growth Co/i, /nasdaq-growth/i, /fixture-news-/i];

// Port used to be `4311 + (process.pid % 1000)` — a range spanning 5000, which
// macOS ControlCenter/AirPlay holds permanently. See test/helpers/freePort.mjs.
const PINNED_PORT = process.env.SWS_MARKET_DATA_GUARD_PORT
  ? Number(process.env.SWS_MARKET_DATA_GUARD_PORT)
  : undefined;

async function bootServer() {
  return spawnServer({
    port: PINNED_PORT,
    env: { NODE_ENV: "test", AUTH_ENABLED: "false" },
    ready: httpReady({ path: "/healthz", accept: (s) => s >= 200 && s < 300 }),
    timeoutMs: 20_000,
  });
}

async function stopServer(server) {
  if (server) await server.stop();
}

test("served market APIs quarantine known synthetic e2e fixture markers", async () => {
  let server;
  try {
    server = await bootServer();
    const PORT = server.port;
    const picksRes = await fetch(`http://localhost:${PORT}/api/us-picks`);
    assert.equal(picksRes.status, 200);
    const picks = await picksRes.json();
    const rows = Object.values(picks.sections || {}).flat();
    for (const row of rows) {
      const text = [row?.ticker, row?.name, row?.sector, row?.sws_url].filter(Boolean).join(" ");
      for (const marker of TEXT_MARKERS) {
        assert.ok(!marker.test(text), `/api/us-picks served fixture marker ${marker}`);
      }
    }
    assert.ok(!rows.some((row) => row?.ticker === "GROWTH"), "/api/us-picks served synthetic GROWTH row");

    const stockRes = await fetch(`http://localhost:${PORT}/api/us-stock/GROWTH`);
    assert.equal(stockRes.status, 404);
  } finally {
    await stopServer(server);
  }
});
