#!/usr/bin/env node
/**
 * Regression suite runner.
 *
 * Stands up one server.js instance (NODE_ENV=test → AUTH_ENABLED=false, plus a
 * known CRON_SECRET so the cron-gate regression can exercise its 401 path),
 * then runs every test/regression/*.regression.mjs file against it as a child
 * process. Aggregates exit codes, tears the server down, exits non-zero on any
 * failure.
 *
 * Why a dedicated runner — separate from the unit `test` script and Playwright:
 *   - Several regressions are API-level: they need a live server but not a
 *     browser, so the Playwright harness is overkill.
 *   - The cron-gate regression needs the server booted WITH a CRON_SECRET set;
 *     the runner owns that env so individual test files stay declarative.
 *   - Pure (no-server) regressions still run here so the whole suite is one
 *     command — they just ignore REGRESSION_BASE_URL.
 *
 * Each test file gets REGRESSION_BASE_URL + REGRESSION_CRON_SECRET in its env.
 *
 * Run with: npm run test:regression
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allocatePort } from "../helpers/freePort.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Hardcoded ports collide when suites run concurrently. Allocate from the OS
// ephemeral range instead — see test/helpers/freePort.mjs.
const PORT = process.env.REGRESSION_PORT || (await allocatePort());
const BASE_URL = `http://localhost:${PORT}`;
const CRON_SECRET = "regression-test-secret";

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/auth/me`);
      // 200 (auth-disabled body) or 401 both mean the server is up + routing.
      if (res.status === 200 || res.status === 401) return true;
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const server = spawn("node", ["server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      STARBHAI_SESSION_SECRET: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      CRON_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });

  const killServer = () => { if (!server.killed) server.kill("SIGTERM"); };
  process.on("exit", killServer);
  process.on("SIGINT", () => { killServer(); process.exit(130); });

  const up = await waitForServer(BASE_URL);
  if (!up) {
    console.error(`[regression] server did not come up on ${BASE_URL} within 30s`);
    console.error(serverLog.slice(-2000));
    killServer();
    process.exit(1);
  }
  console.log(`[regression] server up on ${BASE_URL}`);

  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".regression.mjs"))
    .sort();

  if (files.length === 0) {
    console.error("[regression] no *.regression.mjs files found");
    killServer();
    process.exit(1);
  }

  let failed = 0;
  for (const file of files) {
    console.log(`\n──────── ${file} ────────`);
    const code = await new Promise((resolve) => {
      const child = spawn("node", [path.join(__dirname, file)], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          REGRESSION_BASE_URL: BASE_URL,
          REGRESSION_CRON_SECRET: CRON_SECRET,
        },
        stdio: "inherit",
      });
      child.on("close", resolve);
    });
    if (code !== 0) failed++;
  }

  killServer();
  console.log(
    `\n════════ regression: ${files.length - failed}/${files.length} files passed ════════`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[regression] runner crashed:", err);
  process.exit(1);
});
