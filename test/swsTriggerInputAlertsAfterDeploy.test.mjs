/**
 * Run with: node test/swsTriggerInputAlertsAfterDeploy.test.mjs
 */

import assert from "node:assert/strict";
import { triggerAlertsAfterDeploy, buildCronUrl, parseArgs } from "../scripts/sws-trigger-input-alerts-after-deploy.mjs";

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

assert.equal(
  buildCronUrl("https://example.com/", true),
  "https://example.com/api/cron/sws-input-alerts/send?probe=1",
);
assert.deepEqual(
  parseArgs(["--expected-run-id=run-1", "--url", "https://example.com/", "--cron-secret", "secret", "--timeout-ms=10", "--interval-ms=5"], {}),
  {
    expectedRunId: "run-1",
    productionUrl: "https://example.com",
    cronSecret: "secret",
    timeoutMs: 10,
    intervalMs: 5,
  },
);

{
  const calls = [];
  await assert.rejects(
    () => triggerAlertsAfterDeploy({
      expectedRunId: "fresh-run",
      productionUrl: "https://prod.example",
      cronSecret: "secret",
      timeoutMs: 1,
      intervalMs: 1,
      sleep: async () => {},
      log: () => {},
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options?.method || "GET" });
        return jsonResponse(200, { ok: true, probe: true, run_id: "stale-run" });
      },
    }),
    /timed out waiting for production run_id=fresh-run; deployed=stale-run/,
  );
  assert.equal(calls.some((call) => call.method === "POST"), false, "stale production run_id must not send");
}

{
  const calls = [];
  const result = await triggerAlertsAfterDeploy({
    expectedRunId: "fresh-run",
    productionUrl: "https://prod.example",
    cronSecret: "secret",
    timeoutMs: 100,
    intervalMs: 1,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method || "GET", auth: options?.headers?.authorization });
      if (url.includes("probe=1")) return jsonResponse(200, { ok: true, probe: true, run_id: "fresh-run" });
      return jsonResponse(200, { ok: true, run_id: "fresh-run", recipient_count: 2, dry_run: false });
    },
  });
  assert.equal(result.matched, true);
  assert.equal(result.send.recipient_count, 2);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  assert.ok(calls.every((call) => call.auth === "Bearer secret"));
}

console.log("swsTriggerInputAlertsAfterDeploy tests passed");
