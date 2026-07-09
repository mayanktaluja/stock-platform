#!/usr/bin/env node
/**
 * Poll production until the deployed SWS input-alert artifact matches the
 * local run_id, then trigger the existing cron send path once.
 */

import { pathToFileURL } from "node:url";

import { dispatch } from "../services/alerts/alertDispatcher.js";
import { formatEmailHeartbeat } from "../services/alerts/emailHeartbeatAlert.js";

const DEFAULT_PRODUCTION_URL = "https://starbhai-stock-platform.vercel.app";

function readFlag(argv, name, fallback = null) {
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}

function readNumberFlag(argv, name, fallback) {
  const raw = readFlag(argv, name, null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const expectedRunId = readFlag(argv, "--expected-run-id", env.SWS_INPUT_ALERT_EXPECTED_RUN_ID || "");
  const productionUrl = readFlag(argv, "--url", env.SWS_ALERT_PRODUCTION_URL || DEFAULT_PRODUCTION_URL);
  const cronSecret = readFlag(argv, "--cron-secret", env.CRON_SECRET || "");
  const timeoutMs = readNumberFlag(argv, "--timeout-ms", Number(env.SWS_ALERT_TRIGGER_TIMEOUT_MS) || 900_000);
  const intervalMs = readNumberFlag(argv, "--interval-ms", Number(env.SWS_ALERT_TRIGGER_INTERVAL_MS) || 15_000);
  // Heartbeat (Telegram ping when a send that DID run delivered to nobody, or the
  // trigger timed out / failed). Default on; disable with --no-heartbeat or
  // SWS_ALERT_HEARTBEAT=0. The dispatch self-skips when TG_* is unset, so this is
  // a no-op until the owner configures the bot.
  const heartbeat = !argv.includes("--no-heartbeat") && String(env.SWS_ALERT_HEARTBEAT || "") !== "0";
  return {
    expectedRunId: String(expectedRunId || "").trim(),
    productionUrl: String(productionUrl || DEFAULT_PRODUCTION_URL).replace(/\/+$/, ""),
    cronSecret: String(cronSecret || ""),
    timeoutMs,
    intervalMs,
    heartbeat,
  };
}

export function buildCronUrl(productionUrl, probe = false) {
  const url = new URL("/api/cron/sws-input-alerts/send", productionUrl);
  if (probe) url.searchParams.set("probe", "1");
  return url.toString();
}

async function fetchJson(fetchImpl, url, options) {
  const res = await fetchImpl(url, options);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

export async function triggerAlertsAfterDeploy({
  expectedRunId,
  productionUrl = DEFAULT_PRODUCTION_URL,
  cronSecret,
  timeoutMs = 900_000,
  intervalMs = 15_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  dispatchImpl = dispatch,
  heartbeat = true,
  env = process.env,
} = {}) {
  if (!expectedRunId) throw new Error("--expected-run-id is required");
  if (!cronSecret) throw new Error("--cron-secret or CRON_SECRET is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const baseUrl = String(productionUrl || DEFAULT_PRODUCTION_URL).replace(/\/+$/, "");
  const started = Date.now();
  let lastProbe = null;
  let attempts = 0;

  // Fire the Telegram heartbeat when a send that reached the route delivered to
  // nobody, or the trigger failed/timed out. Never throws — a heartbeat failure
  // must not change the trigger's exit code (the dispatch is itself never-throw,
  // and this is belt-and-suspenders).
  const fireHeartbeat = async (payload) => {
    if (!heartbeat) return;
    try {
      const alert = formatEmailHeartbeat(payload);
      if (alert) await dispatchImpl(alert, { env });
    } catch (err) {
      log(`[sws-alert-trigger] heartbeat dispatch error (swallowed): ${err.message}`);
    }
  };

  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const probe = await fetchJson(fetchImpl, buildCronUrl(baseUrl, true), {
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}`, accept: "application/json" },
    });
    lastProbe = probe.body;
    if (probe.ok && probe.body?.run_id === expectedRunId) {
      log(`[sws-alert-trigger] production artifact matched run_id=${expectedRunId} after ${attempts} probe(s)`);
      const send = await fetchJson(fetchImpl, buildCronUrl(baseUrl, false), {
        method: "POST",
        headers: { authorization: `Bearer ${cronSecret}`, accept: "application/json" },
      });
      if (!send.ok || send.body?.ok !== true) {
        const msg = JSON.stringify(send.body || {});
        await fireHeartbeat({
          runId: send.body?.run_id || expectedRunId,
          recipientCount: 0,
          reason: `send failed status=${send.status}`,
        });
        throw new Error(`alert send failed status=${send.status} body=${msg}`);
      }
      log(
        `[sws-alert-trigger] send complete run_id=${send.body.run_id || expectedRunId} ` +
          `recipients=${send.body.recipient_count ?? "n/a"} dry_run=${send.body.dry_run === true}`,
      );
      // Delivered to nobody on a real send = the silent-outage shape (every
      // recipient deduped on a stale run_id, or artifact-not-email-eligible).
      if (Number(send.body.recipient_count) === 0 && send.body.dry_run !== true) {
        await fireHeartbeat({
          runId: send.body.run_id || expectedRunId,
          recipientCount: 0,
          reason: send.body.reason || null,
          counts: send.body.counts,
        });
      }
      return { matched: true, attempts, probe: probe.body, send: send.body };
    }

    log(
      `[sws-alert-trigger] waiting for production run_id=${expectedRunId}; ` +
        `deployed=${lastProbe?.run_id || "<none>"} status=${probe.status}`,
    );
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))));
  }

  const deployed = lastProbe?.run_id || "<none>";
  // Never matched the expected run_id within the window — production never served
  // a fresh artifact (nightly produced no new run_id). That is an outage.
  await fireHeartbeat({
    runId: expectedRunId,
    recipientCount: 0,
    reason: `trigger timed out; production deployed=${deployed}`,
  });
  throw new Error(`timed out waiting for production run_id=${expectedRunId}; deployed=${deployed}`);
}

async function main() {
  const args = parseArgs();
  await triggerAlertsAfterDeploy(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[sws-alert-trigger] FAILED: ${err.message}`);
    process.exit(1);
  });
}
