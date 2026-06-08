/**
 * Run with: node test/swsInputAlertsApi.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.NODE_ENV = "test";
const ROOT = process.cwd();
const PORT = 4138;
const USERS = path.join(ROOT, "users.json");
const ANALYZER = path.join(ROOT, "analyzer-last.json");
const LEDGER = path.join(ROOT, "sws-input-alert-ledger.json");
const ALERT_DIR = path.join(ROOT, "data", "sws", "alerts");
const CHANGES = path.join(ALERT_DIR, "fundamental-changes-latest.json");

function backup(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}
function restore(file, prior) {
  if (prior === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, prior);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
async function request(port, method, pathname, { headers = {}, body = null } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
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

const priors = new Map([[USERS, backup(USERS)], [ANALYZER, backup(ANALYZER)], [LEDGER, backup(LEDGER)], [CHANGES, backup(CHANGES)]]);
let child;
try {
  writeJson(CHANGES, {
    schema_version: 1,
    run_id: "run-api-test",
    generated_at: "2026-06-08T00:00:00.000Z",
    changes: [
      {
        ticker: "TCS",
        name: "Tata Consultancy Services",
        severity: "high",
        change_hash: "hash-tcs",
        changes: [{ field: "snowflake.total", previous: 10, current: 16, severity: "high" }],
      },
      {
        ticker: "INFY",
        name: "Infosys",
        severity: "medium",
        change_hash: "hash-infy",
        changes: [{ field: "forecast", previous: "old", current: "new", severity: "medium" }],
      },
    ],
  });
  writeJson(ANALYZER, {
    _local_dev: {
      sub: "_local_dev",
      holdings: [{ symbol: "TCS.NS", quantity: 1, avgPrice: 100 }],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
  });
  writeJson(USERS, {
    _local_dev: {
      sub: "_local_dev",
      email: "mtaluja11@gmail.com",
      notificationPrefs: { swsInputAlerts: { inApp: true, email: true } },
    },
  });
  fs.rmSync(LEDGER, { force: true });

  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      STARBHAI_SESSION_SECRET: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_OAUTH_REDIRECT_URI: "",
      KV_REST_API_URL: "",
      KV_REST_API_TOKEN: "",
      CRON_SECRET: "test-cron-secret",
      SWS_INPUT_ALERTS_ENABLED: "1",
      SWS_INPUT_ALERTS_DRY_RUN: "1",
      SWS_INPUT_ALERTS_ALLOWLIST: "mtaluja11@gmail.com",
      SWS_INPUT_ALERT_SAMPLE_SEND: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);
  const port = PORT;

  const alerts = await request(port, "GET", "/api/portfolio/sws-input-alerts");
  assert.equal(alerts.status, 200);
  assert.equal(alerts.json.run_id, "run-api-test");
  assert.deepEqual(alerts.json.alerts.map((a) => a.ticker), ["TCS"]);
  assert.equal(alerts.json.suppressed_count, 1);

  const prefs = await request(port, "POST", "/api/portfolio/sws-input-alerts/prefs", { body: { inApp: false, email: true } });
  assert.equal(prefs.status, 200);
  assert.deepEqual(prefs.json.prefs, { inApp: false, email: true });

  const sample = await request(port, "POST", "/api/admin/sws-input-alerts/sample-email");
  assert.equal(sample.status, 401);
  assert.equal(sample.json.error, "auth-disabled");

  const forbiddenCron = await request(port, "POST", "/api/cron/sws-input-alerts/send");
  assert.equal(forbiddenCron.status, 401);

  const cron = await request(port, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(cron.status, 200);
  assert.equal(cron.json.dry_run, true);
  assert.equal(cron.json.recipient_count, 1);
  assert.equal(cron.json.results[0].email, "mtaluja11@gmail.com");

  console.log("swsInputAlertsApi tests passed");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  for (const [file, prior] of priors.entries()) restore(file, prior);
}
