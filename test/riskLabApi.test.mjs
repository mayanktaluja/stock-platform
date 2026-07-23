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

import { existsSync } from "fs";
import path from "path";
import { spawnServer, httpReady } from "./helpers/freePort.mjs";

// Port used to be `4111 + (process.pid % 1000)` — a range spanning 5000, which
// macOS ControlCenter/AirPlay holds permanently. On 2026-07-22 the pid landed in
// that bucket, server.js died with EADDRINUSE, and the nightly data push was
// blocked. Ports are now OS-assigned; see test/helpers/freePort.mjs.
//
// RISK_LAB_API_TEST_PORT still pins the port when set, offset per boot so the
// three sequential boots below stay distinct.
const PINNED_BASE_PORT = process.env.RISK_LAB_API_TEST_PORT
  ? Number(process.env.RISK_LAB_API_TEST_PORT)
  : null;
let bootIndex = 0;
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
  const defaultTimeoutMs = process.env.CI ? 60000 : 30000;
  const timeoutMs = Number(process.env.RISK_LAB_API_BOOT_TIMEOUT_MS || defaultTimeoutMs);
  const offset = bootIndex++;
  return spawnServer({
    port: PINNED_BASE_PORT === null ? undefined : PINNED_BASE_PORT + offset,
    env: { NODE_ENV: "test", AUTH_ENABLED: "false", ...extraEnv },
    // Wait until /api/risk-lab/regime-context responds (the lab API is always
    // available regardless of which other tabs/routes need DB init).
    //
    // 404 IS a valid boot signal and must stay: the kill-switch case below boots
    // with RISK_LAB_ENABLED=false, where server.js:4793 makes every Risk Lab
    // route return 404 — that is the only response it can give. This was only
    // ever risky because a colliding port could return a FOREIGN 404 (macOS
    // AirPlay on 5000 does exactly that); OS-assigned ports remove that hazard.
    ready: httpReady({
      path: "/api/risk-lab/regime-context",
      accept: (s) => s === 200 || s === 404 || s === 503,
    }),
    timeoutMs,
  });
}

async function safeKill(server) {
  if (!server?.proc || server.proc.killed) return;
  server.proc.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    server.proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

console.log("riskLabApi: testing default-enabled state");
{
  let server;
  try {
    server = await bootServer();

    // /api/risk-lab/picks-adjusted
    const picksRes = await fetch(`http://localhost:${server.port}/api/risk-lab/picks-adjusted`);
    assert("picks-adjusted: 200", picksRes.status === 200, picksRes.status);
    const picks = await picksRes.json();
    assert("picks-adjusted: schema_version v2", picks.schema_version === "risk-lab-picks-v2");
    assert("picks-adjusted: has stocks[]", Array.isArray(picks.stocks) && picks.stocks.length > 0);
    assert("picks-adjusted: has summary", picks.summary && typeof picks.summary.total_stocks === "number");
    assert("picks-adjusted: exposes lab_status", ["ok", "degraded"].includes(picks.lab_status), picks.lab_status);
    assert("picks-adjusted: exposes promotion state", typeof picks.promotion_state === "string" && picks.promotion_state.startsWith("experimental"), picks.promotion_state);
    assert("picks-adjusted: exposes shadow-only decision contract", picks.decision_contract?.promoted === false && picks.decision_contract?.state === "SHADOW_ONLY", picks.decision_contract);
    assert("picks-adjusted: exposes runtime audit", picks.runtime_audit && picks.runtime_audit.artifacts && picks.runtime_audit.thresholds);
    assert("picks-adjusted: exposes action queue", Array.isArray(picks.action_queue) && picks.action_queue.length > 0);

    // /api/risk-lab/regime-context — projects summary + regime
    const ctxRes = await fetch(`http://localhost:${server.port}/api/risk-lab/regime-context`);
    assert("regime-context: 200", ctxRes.status === 200);
    const ctx = await ctxRes.json();
    assert("regime-context: has regime", ctx.regime !== undefined);
    assert("regime-context: has summary", ctx.summary && typeof ctx.summary.total_stocks === "number");
    assert("regime-context: NO stocks (only context)", ctx.stocks === undefined);
    assert("regime-context: exposes runtime audit", ctx.runtime_audit && ctx.risk_lab_state);

    // /api/risk-lab/quality-flags — bulk
    const flagsRes = await fetch(`http://localhost:${server.port}/api/risk-lab/quality-flags`);
    assert("quality-flags bulk: 200", flagsRes.status === 200);
    const flags = await flagsRes.json();
    assert("quality-flags bulk: array of stocks", Array.isArray(flags.stocks));
    assert("quality-flags bulk: exposes runtime audit", flags.runtime_audit && flags.risk_lab_state);

    // /api/risk-lab/quality-flags/:ticker — single ticker
    if (flags.stocks.length > 0) {
      const sampleTicker = flags.stocks[0].ticker;
      const oneRes = await fetch(`http://localhost:${server.port}/api/risk-lab/quality-flags/${sampleTicker}`);
      assert("quality-flags single: 200 for known ticker", oneRes.status === 200);
      const one = await oneRes.json();
      assert("quality-flags single: matches ticker", one.ticker === sampleTicker);
      assert("quality-flags single: has flags array", Array.isArray(one.flags));
      assert("quality-flags single: exposes runtime audit", one.runtime_audit && one.risk_lab_state);

      // Lowercase / unknown ticker → 404
      const missRes = await fetch(`http://localhost:${server.port}/api/risk-lab/quality-flags/NOTATICKER`);
      assert("quality-flags single: 404 for unknown ticker", missRes.status === 404);
    }
  } finally {
    await safeKill(server);
  }
}

console.log("riskLabApi: testing forced degraded state");
{
  let server;
  try {
    server = await bootServer({
      RISK_LAB_MAX_ARTIFACT_AGE_HOURS: "0",
      RISK_LAB_SOURCE_DRIFT_MAX_HOURS: "0",
    });

    const picksRes = await fetch(`http://localhost:${server.port}/api/risk-lab/picks-adjusted`);
    assert("forced degraded: picks-adjusted 200", picksRes.status === 200, picksRes.status);
    const picks = await picksRes.json();
    assert("forced degraded: lab_status degraded", picks.lab_status === "degraded", picks.lab_status);
    assert("forced degraded: promotion state experimental_not_promoted", picks.promotion_state === "experimental_not_promoted", picks.promotion_state);
    assert("forced degraded: has issues", Array.isArray(picks.risk_lab_state?.issues) && picks.risk_lab_state.issues.length > 0);
    assert("forced degraded: has prioritized action queue", Array.isArray(picks.action_queue) && picks.action_queue[0]?.priority === 1, picks.action_queue);

    const thesisRes = await fetch(`http://localhost:${server.port}/api/risk-lab/macro-thesis`);
    assert("forced degraded: macro-thesis 200", thesisRes.status === 200, thesisRes.status);
    const thesis = await thesisRes.json();
    assert("forced degraded: macro-thesis exposes same state", thesis.risk_lab_state?.promotion_state === "experimental_not_promoted", thesis.risk_lab_state?.promotion_state);
  } finally {
    await safeKill(server);
  }
}

console.log("riskLabApi: testing RISK_LAB_ENABLED=false (kill switch)");
{
  let server;
  try {
    server = await bootServer({ RISK_LAB_ENABLED: "false" });

    const picksRes = await fetch(`http://localhost:${server.port}/api/risk-lab/picks-adjusted`);
    assert("kill-switch: picks-adjusted returns 404", picksRes.status === 404);

    const ctxRes = await fetch(`http://localhost:${server.port}/api/risk-lab/regime-context`);
    assert("kill-switch: regime-context returns 404", ctxRes.status === 404);

    const flagsRes = await fetch(`http://localhost:${server.port}/api/risk-lab/quality-flags`);
    assert("kill-switch: quality-flags returns 404", flagsRes.status === 404);
  } finally {
    await safeKill(server);
  }
}

if (_failed === 0) {
  console.log("riskLabApi: PASS");
  process.exit(0);
} else {
  console.error(`riskLabApi: FAIL (${_failed})`);
  process.exit(1);
}
