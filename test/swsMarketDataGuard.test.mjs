import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const TEXT_MARKERS = [/Quality Growth Co/i, /nasdaq-growth/i, /fixture-news-/i];
const PORT = Number(process.env.SWS_MARKET_DATA_GUARD_PORT || 4311 + (process.pid % 1000));

async function bootServer() {
  const proc = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      AUTH_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return proc;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  proc.kill();
  throw new Error("server failed to boot within 20s");
}

async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

test("served market APIs quarantine known synthetic e2e fixture markers", async () => {
  let proc;
  try {
    proc = await bootServer();
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
    await stopServer(proc);
  }
});
