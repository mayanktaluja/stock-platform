/**
 * Run with: node test/swsInputAlertsApi.test.mjs
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.NODE_ENV = "test";
const ROOT = process.cwd();
const PORT = 4138;
const USERS = path.join(ROOT, "users.json");
const ANALYZER = path.join(ROOT, "analyzer-last.json");
const LEDGER = path.join(ROOT, "sws-input-alert-ledger.json");
const PORTFOLIO_HISTORY = path.join(ROOT, "portfolio-history.json");
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

function signTestSession(sub, secret) {
  const payload = Buffer.from(`sess:${JSON.stringify({ sub, ts: Date.now() })}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

const priors = new Map([[USERS, backup(USERS)], [ANALYZER, backup(ANALYZER)], [LEDGER, backup(LEDGER)], [PORTFOLIO_HISTORY, backup(PORTFOLIO_HISTORY)], [CHANGES, backup(CHANGES)]]);
let child;
async function startServer(envOverrides = {}) {
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
      SWS_MAIL_FROM: "Starbhai <alerts@example.com>",
      SWS_INPUT_ALERTS_ENABLED: "1",
      SWS_INPUT_ALERTS_DRY_RUN: "1",
      SWS_INPUT_ALERT_SAMPLE_SEND: "1",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);
  return PORT;
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 2000);
  });
  child = null;
}

try {
  writeJson(CHANGES, {
    schema_version: 2,
    confirmation_policy: "two_consecutive_full_runs",
    artifact_email_eligible: true,
    run_id: "run-api-test",
    generated_at: "2026-06-08T00:00:00.000Z",
    raw_change_count: 5,
    pending_count: 0,
    suppressed_unconfirmed_count: 0,
    state_seeded: false,
    changes: [
      {
        ticker: "TCS",
        name: "Tata Consultancy Services",
        severity: "medium",
        change_hash: "hash-tcs",
        changes: [{ field: "snowflake.future", previous: 4, current: 3, severity: "medium" }],
      },
      {
        ticker: "INFY",
        name: "Infosys",
        severity: "medium",
        change_hash: "hash-infy",
        changes: [{ field: "fair_value.fair_value_inr", previous: 100, current: 110, severity: "medium" }],
      },
      {
        ticker: "NTPC",
        name: "NTPC",
        severity: "medium",
        change_hash: "hash-ntpc",
        changes: [{ field: "snowflake.value", previous: 4, current: 2, severity: "medium" }],
      },
      {
        ticker: "ALEMBICLTD",
        name: "Alembic Limited",
        severity: "medium",
        change_hash: "hash-alembic",
        changes: [{ field: "fair_value.fair_value_inr", previous: 723.48, current: 725, severity: "medium" }],
      },
      {
        ticker: "OUTSIDE",
        name: "Outside Portfolio",
        severity: "medium",
        change_hash: "hash-outside",
        changes: [{ field: "snowflake.future", previous: 1, current: 2, severity: "medium" }],
      },
    ],
  });
  writeJson(ANALYZER, {
    _local_dev: {
      sub: "_local_dev",
      holdings: [
        { symbol: "TCS.NS", quantity: 1, avgPrice: 100 },
        { symbol: "ALEMBICLTD.NS", quantity: 1, avgPrice: 100 },
      ],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
    user_default_on: {
      sub: "user_default_on",
      holdings: [
        { symbol: "INFY.NS", quantity: 1, avgPrice: 100 },
        { symbol: "NTPC.NS", quantity: 100, avgPrice: 100 },
      ],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
    user_opted_out: {
      sub: "user_opted_out",
      holdings: [{ symbol: "INFY.NS", quantity: 1, avgPrice: 100 }],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
  });
  writeJson(USERS, {
    _local_dev: {
      sub: "_local_dev",
      email: "mtaluja11@gmail.com",
      notificationPrefs: { swsInputAlerts: { inApp: true, email: true } },
    },
    user_default_on: {
      sub: "user_default_on",
      email: "portfolio-reader@example.com",
      notificationPrefs: {},
    },
    user_opted_out: {
      sub: "user_opted_out",
      email: "opted-out@example.com",
      notificationPrefs: { swsInputAlerts: { inApp: true, email: false } },
    },
    user_no_portfolio: {
      sub: "user_no_portfolio",
      email: "no-portfolio@example.com",
      notificationPrefs: {},
    },
  });
  fs.rmSync(LEDGER, { force: true });

  const port = await startServer();

  const alerts = await request(port, "GET", "/api/portfolio/sws-input-alerts");
  assert.equal(alerts.status, 200);
  assert.equal(alerts.json.run_id, "run-api-test");
  assert.deepEqual(alerts.json.alerts.map((a) => a.ticker), ["TCS"]);
  assert.equal(alerts.json.suppressed_count, 1, "only held sub-threshold/noise alerts are suppressed");

  const prefs = await request(port, "POST", "/api/portfolio/sws-input-alerts/prefs", { body: { inApp: false, email: true } });
  assert.equal(prefs.status, 200);
  assert.deepEqual(prefs.json.prefs, { inApp: false, email: true });

  const sample = await request(port, "POST", "/api/admin/sws-input-alerts/sample-email");
  assert.equal(sample.status, 401);
  assert.equal(sample.json.error, "auth-disabled");

  const forbiddenAdminPrefs = await request(port, "POST", "/api/admin/users/user_default_on/sws-input-alerts/prefs", {
    body: { email: false },
  });
  assert.equal(forbiddenAdminPrefs.status, 401);
  assert.equal(forbiddenAdminPrefs.json.error, "auth-disabled");

  const forbiddenCron = await request(port, "POST", "/api/cron/sws-input-alerts/send");
  assert.equal(forbiddenCron.status, 401);

  const ledgerBeforeProbe = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf-8") : null;
  const probe = await request(port, "GET", "/api/cron/sws-input-alerts/send?probe=1", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.json.probe, true);
  assert.equal(probe.json.artifact_present, true);
  assert.equal(probe.json.run_id, "run-api-test");
  assert.equal(probe.json.generated_at, "2026-06-08T00:00:00.000Z");
  assert.equal(probe.json.schema_version, 2);
  assert.equal(probe.json.confirmation_policy, "two_consecutive_full_runs");
  assert.equal(probe.json.artifact_email_eligible, true);
  assert.equal(probe.json.raw_change_count, 5);
  assert.equal(probe.json.pending_count, 0);
  assert.equal(probe.json.suppressed_unconfirmed_count, 0);
  assert.equal(probe.json.market_change_count, 5);
  const ledgerAfterProbe = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf-8") : null;
  assert.equal(ledgerAfterProbe, ledgerBeforeProbe, "probe mode must not create or write ledger events");

  const cron = await request(port, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(cron.status, 200);
  assert.equal(cron.json.dry_run, true);
  assert.equal(cron.json.recipient_count, 2);
  assert.deepEqual(cron.json.counts, {
    eligible: 2,
    sent: 0,
    failed: 0,
    deduped: 0,
    dry_run: 2,
    no_holdings: 1,
    no_alerts: 0,
    skipped: 1,
    transition_suppressed: 0,
  });
  assert.equal(cron.json.artifact_email_eligible, true);
  assert.equal(cron.json.schema_version, 2);
  assert.equal(cron.json.confirmation_policy, "two_consecutive_full_runs");
  const cronByEmail = new Map(cron.json.results.map((r) => [r.email, r]));
  assert.ok(cronByEmail.has("mtaluja11@gmail.com"), "admin/local user receives alert");
  assert.ok(cronByEmail.has("portfolio-reader@example.com"), "portfolio user with no prefs is enabled by default");
  assert.equal(cronByEmail.has("opted-out@example.com"), false, "explicit email=false opts out");
  assert.equal(cronByEmail.has("no-portfolio@example.com"), false, "users without uploaded holdings are skipped");
  assert.match(cronByEmail.get("mtaluja11@gmail.com").payload.text, /Future growth changed from 4 to 3/);
  assert.match(cronByEmail.get("mtaluja11@gmail.com").payload.html, /<table role="presentation"/);
  assert.match(cronByEmail.get("mtaluja11@gmail.com").payload.html, /Future growth/);
  assert.doesNotMatch(cronByEmail.get("mtaluja11@gmail.com").payload.html, /ALEMBICLTD/);
  assert.match(cronByEmail.get("portfolio-reader@example.com").payload.text, /Portfolio Analyzer reduction review/);
  assert.match(cronByEmail.get("portfolio-reader@example.com").payload.text, /NTPC[^\n]*Reduction-/);
  assert.match(cronByEmail.get("portfolio-reader@example.com").payload.text, /Please open Starbhai and verify before acting/);
  assert.doesNotMatch(cronByEmail.get("portfolio-reader@example.com").payload.text, /sell\s+NTPC/i);
  assert.match(cronByEmail.get("portfolio-reader@example.com").payload.html, /Portfolio Analyzer reduction review/);
  assert.equal(cronByEmail.get("portfolio-reader@example.com").reduction_highlight_count, 1);

  writeJson(LEDGER, {
    _local_dev: {
      schemaVersion: 1,
      events: [{
        id: "old-digest-event",
        sub: "_local_dev",
        type: "EMAIL_SENT",
        run_id: "run-api-test",
        digest: "old-normalization-digest",
        alert_count: 2,
        at: "2026-06-08T00:05:00.000Z",
      }],
    },
    user_default_on: {
      schemaVersion: 1,
      events: [{
        id: "old-digest-event-2",
        sub: "user_default_on",
        type: "EMAIL_SENT",
        run_id: "run-api-test",
        digest: "old-normalization-digest-2",
        alert_count: 1,
        at: "2026-06-08T00:05:00.000Z",
      }],
    },
  });
  const dedupedCron = await request(port, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(dedupedCron.status, 200);
  assert.equal(dedupedCron.json.recipient_count, 0);
  assert.equal(dedupedCron.json.counts.deduped, 2);
  assert.equal(dedupedCron.json.results.length, 2);
  assert.ok(dedupedCron.json.results.every((r) => r.skipped === true && r.reason === "deduped"));

  const cronGet = await request(port, "GET", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(cronGet.status, 200);
  assert.equal(cronGet.json.dry_run, true);
  assert.equal(cronGet.json.recipient_count, 0);

  const confirmedFixture = JSON.parse(fs.readFileSync(CHANGES, "utf-8"));
  const legacyFixture = {
    schema_version: 1,
    run_id: "legacy-run",
    generated_at: "2026-06-08T00:00:00.000Z",
    changes: confirmedFixture.changes,
  };
  writeJson(CHANGES, legacyFixture);
  const legacyCron = await request(port, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(legacyCron.status, 200);
  assert.equal(legacyCron.json.reason, "artifact-not-email-eligible");
  assert.equal(legacyCron.json.recipient_count, 0);
  assert.equal(legacyCron.json.artifact_email_eligible, false);
  assert.equal(legacyCron.json.schema_version, 1);
  writeJson(CHANGES, confirmedFixture);

  const missingRunIdFixture = JSON.parse(fs.readFileSync(CHANGES, "utf-8"));
  missingRunIdFixture.run_id = null;
  writeJson(CHANGES, missingRunIdFixture);
  const missingRunIdCron = await request(port, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(missingRunIdCron.status, 200);
  assert.equal(missingRunIdCron.json.ok, false);
  assert.equal(missingRunIdCron.json.counts.failed, 2);
  assert.equal(missingRunIdCron.json.recipient_count, 0);
  assert.ok(missingRunIdCron.json.results.every((r) => r.reason === "missing_dedupe_key"));
  missingRunIdFixture.run_id = "run-api-test";
  writeJson(CHANGES, missingRunIdFixture);

  await stopServer();
  writeJson(USERS, {
    baseline_user: {
      sub: "baseline_user",
      email: "baseline@example.com",
      notificationPrefs: {},
    },
  });
  writeJson(ANALYZER, {
    baseline_user: {
      sub: "baseline_user",
      holdings: [{ symbol: "POWERGRID.NS", quantity: 100, avgPrice: 100 }],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
  });
  fs.rmSync(LEDGER, { force: true });
  await startServer({
    SWS_INPUT_ALERTS_DRY_RUN: "0",
    RESEND_API_KEY: "test-resend-key",
    SWS_MAIL_FROM: "Starbhai <alerts@example.com>",
  });
  const noAlertCron = await request(PORT, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(noAlertCron.status, 200);
  assert.equal(noAlertCron.json.counts.no_alerts, 1);
  assert.equal(noAlertCron.json.recipient_count, 0);
  const baselineLedger = JSON.parse(fs.readFileSync(LEDGER, "utf-8"));
  assert.equal(baselineLedger.baseline_user.events[0].type, "PORTFOLIO_ACTION_STATE");
  assert.equal(baselineLedger.baseline_user.events[0].portfolio_action_state.tickers.POWERGRID.confirmed_reduction, true);

  await stopServer();
  writeJson(USERS, {
    _local_dev: {
      sub: "_local_dev",
      email: "not-an-email",
      notificationPrefs: { swsInputAlerts: { inApp: true, email: true } },
    },
    user_default_on: {
      sub: "user_default_on",
      email: "also-not-an-email",
      notificationPrefs: {},
    },
  });
  writeJson(ANALYZER, {
    _local_dev: {
      sub: "_local_dev",
      holdings: [{ symbol: "TCS.NS", quantity: 1, avgPrice: 100 }],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
    user_default_on: {
      sub: "user_default_on",
      holdings: [
        { symbol: "INFY.NS", quantity: 1, avgPrice: 100 },
        { symbol: "NTPC.NS", quantity: 100, avgPrice: 100 },
      ],
      uploadedAt: "2026-06-08T00:00:00.000Z",
    },
  });
  fs.rmSync(LEDGER, { force: true });
  await startServer({
    SWS_INPUT_ALERTS_DRY_RUN: "0",
    RESEND_API_KEY: "test-resend-key",
    SWS_MAIL_FROM: "Starbhai <alerts@example.com>",
  });
  const failingCron = await request(PORT, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(failingCron.status, 200);
  assert.equal(failingCron.json.ok, false);
  assert.equal(failingCron.json.partial_failure, true);
  assert.equal(failingCron.json.counts.eligible, 2);
  assert.equal(failingCron.json.counts.failed, 2);
  assert.equal(failingCron.json.results.length, 2);
  assert.ok(failingCron.json.results.every((r) => r.failed === true && r.reason === "invalid_message"));
  assert.equal(failingCron.json.results.find((r) => r.email === "also-not-an-email").reduction_highlight_count, 1);
  const failedLedger = JSON.parse(fs.readFileSync(LEDGER, "utf-8"));
  assert.equal(failedLedger._local_dev.events[0].type, "EMAIL_FAILED");
  assert.equal(failedLedger.user_default_on.events[0].type, "EMAIL_FAILED");
  assert.equal(failedLedger.user_default_on.events.some((event) => event.type === "PORTFOLIO_ACTION_STATE"), false);
  assert.notEqual(failedLedger._local_dev.events[0].id, failedLedger.user_default_on.events[0].id);

  await stopServer();
  writeJson(CHANGES, {
    schema_version: 2,
    confirmation_policy: "two_consecutive_full_runs",
    artifact_email_eligible: true,
    run_id: "run-admin-prefs",
    generated_at: "2026-06-10T00:00:00.000Z",
    raw_change_count: 1,
    pending_count: 0,
    suppressed_unconfirmed_count: 0,
    changes: [{
      ticker: "INFY",
      name: "Infosys",
      severity: "medium",
      change_hash: "hash-infy-admin",
      changes: [{ field: "snowflake.future", previous: 3, current: 2, severity: "medium" }],
    }],
  });
  writeJson(ANALYZER, {
    target_bouncing_user: {
      sub: "target_bouncing_user",
      holdings: [{ symbol: "INFY.NS", quantity: 1, avgPrice: 100 }],
      uploadedAt: "2026-06-10T00:00:00.000Z",
    },
  });
  writeJson(USERS, {
    admin_sub: {
      sub: "admin_sub",
      email: "mtaluja11@gmail.com",
      notificationPrefs: {},
    },
    target_bouncing_user: {
      sub: "target_bouncing_user",
      email: "vikrant.deshmukh16@gmail.com",
      notificationPrefs: {},
    },
  });
  fs.rmSync(LEDGER, { force: true });
  const sessionSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  await startServer({
    STARBHAI_SESSION_SECRET: sessionSecret,
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_OAUTH_REDIRECT_URI: `http://localhost:${PORT}/api/auth/google/callback`,
  });
  const adminCookie = `starbhai_session=${signTestSession("admin_sub", sessionSecret)}`;
  const adminUpdate = await request(PORT, "POST", "/api/admin/users/target_bouncing_user/sws-input-alerts/prefs", {
    headers: { cookie: adminCookie },
    body: { email: false },
  });
  assert.equal(adminUpdate.status, 200);
  assert.equal(adminUpdate.json.ok, true);
  assert.equal(adminUpdate.json.email, "vikrant.deshmukh16@gmail.com");
  assert.deepEqual(adminUpdate.json.prefs, { inApp: true, email: false });

  const persistedUsers = JSON.parse(fs.readFileSync(USERS, "utf-8"));
  assert.equal(
    persistedUsers.target_bouncing_user.notificationPrefs.swsInputAlerts.email,
    false,
    "admin endpoint persists target user's email opt-out",
  );
  assert.equal(
    persistedUsers.target_bouncing_user.notificationPrefs.swsInputAlerts.inApp,
    true,
    "admin endpoint preserves/defaults in-app alerts on",
  );

  const cronAfterAdminUpdate = await request(PORT, "POST", "/api/cron/sws-input-alerts/send", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  assert.equal(cronAfterAdminUpdate.status, 200);
  assert.equal(cronAfterAdminUpdate.json.recipient_count, 0);
  assert.equal(
    cronAfterAdminUpdate.json.results.some((r) => r.email === "vikrant.deshmukh16@gmail.com"),
    false,
    "disabled target user is not included in cron send results",
  );

  console.log("swsInputAlertsApi tests passed");
} finally {
  await stopServer();
  for (const [file, prior] of priors.entries()) restore(file, prior);
}
