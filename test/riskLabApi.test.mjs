/**
 * Risk Lab API smoke test — spawns server.js, hits each /api/risk-lab/* route
 * via fetch, checks response shape + 404 path when RISK_LAB_ENABLED=false.
 *
 * Lightweight: doesn't load production cron or database init. NODE_ENV=test
 * gates the heavier in-process refresh paths (per macroRegimeStorage.js:87+),
 * so this boots fast.
 *
 * Self-skips if data/risk-lab/picks-adjusted-latest.json is missing — that
 * means refresh-risk-lab.mjs hasn't been run since the data dir was wiped.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

const PORT = 4111;
const PICKS_FILE = path.resolve("data/risk-lab/picks-adjusted-latest.json");

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

if (!existsSync(PICKS_FILE)) {
  console.log(`riskLabApi: SKIP — ${PICKS_FILE} not present. Run scripts/refresh-risk-lab.mjs first.`);
  process.exit(0);
}

// Boot server with NODE_ENV=test and AUTH_ENABLED=false so we don't need
// fake credentials. Use the same env-shape the playwright harness uses.
async function bootServer(extraEnv = {}) {
  const proc = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      AUTH_ENABLED: "false",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait until /api/risk-lab/regime-context responds (lab API is always
  // available regardless of which other tabs/routes happen to need DB init)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/risk-lab/regime-context`);
      if (res.status === 200 || res.status === 404 || res.status === 503) {
        return proc;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("server failed to boot within 15s");
}

async function safeKill(proc) {
  if (!proc || proc.killed) return;
  proc.kill();
  // Give it a moment to release the port
  await new Promise((r) => setTimeout(r, 200));
}

console.log("riskLabApi: testing default-enabled state");
{
  let proc;
  try {
    proc = await bootServer();

    // /api/risk-lab/picks-adjusted
    const picksRes = await fetch(`http://localhost:${PORT}/api/risk-lab/picks-adjusted`);
    assert("picks-adjusted: 200", picksRes.status === 200, picksRes.status);
    const picks = await picksRes.json();
    assert("picks-adjusted: schema_version v2", picks.schema_version === "risk-lab-picks-v2");
    assert("picks-adjusted: has stocks[]", Array.isArray(picks.stocks) && picks.stocks.length > 0);
    assert("picks-adjusted: has summary", picks.summary && typeof picks.summary.total_stocks === "number");

    // /api/risk-lab/regime-context — projects summary + regime
    const ctxRes = await fetch(`http://localhost:${PORT}/api/risk-lab/regime-context`);
    assert("regime-context: 200", ctxRes.status === 200);
    const ctx = await ctxRes.json();
    assert("regime-context: has regime", ctx.regime !== undefined);
    assert("regime-context: has summary", ctx.summary && typeof ctx.summary.total_stocks === "number");
    assert("regime-context: NO stocks (only context)", ctx.stocks === undefined);

    // /api/risk-lab/quality-flags — bulk
    const flagsRes = await fetch(`http://localhost:${PORT}/api/risk-lab/quality-flags`);
    assert("quality-flags bulk: 200", flagsRes.status === 200);
    const flags = await flagsRes.json();
    assert("quality-flags bulk: array of stocks", Array.isArray(flags.stocks));

    // /api/risk-lab/quality-flags/:ticker — single ticker
    if (flags.stocks.length > 0) {
      const sampleTicker = flags.stocks[0].ticker;
      const oneRes = await fetch(`http://localhost:${PORT}/api/risk-lab/quality-flags/${sampleTicker}`);
      assert("quality-flags single: 200 for known ticker", oneRes.status === 200);
      const one = await oneRes.json();
      assert("quality-flags single: matches ticker", one.ticker === sampleTicker);
      assert("quality-flags single: has flags array", Array.isArray(one.flags));

      // Lowercase / unknown ticker → 404
      const missRes = await fetch(`http://localhost:${PORT}/api/risk-lab/quality-flags/NOTATICKER`);
      assert("quality-flags single: 404 for unknown ticker", missRes.status === 404);
    }
  } finally {
    await safeKill(proc);
  }
}

console.log("riskLabApi: testing RISK_LAB_ENABLED=false (kill switch)");
{
  let proc;
  try {
    proc = await bootServer({ RISK_LAB_ENABLED: "false" });

    const picksRes = await fetch(`http://localhost:${PORT}/api/risk-lab/picks-adjusted`);
    assert("kill-switch: picks-adjusted returns 404", picksRes.status === 404);

    const ctxRes = await fetch(`http://localhost:${PORT}/api/risk-lab/regime-context`);
    assert("kill-switch: regime-context returns 404", ctxRes.status === 404);

    const flagsRes = await fetch(`http://localhost:${PORT}/api/risk-lab/quality-flags`);
    assert("kill-switch: quality-flags returns 404", flagsRes.status === 404);
  } finally {
    await safeKill(proc);
  }
}

if (_failed === 0) {
  console.log("riskLabApi: PASS");
  process.exit(0);
} else {
  console.error(`riskLabApi: FAIL (${_failed})`);
  process.exit(1);
}
