import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BEFORE_CPU_REDUCTION_CRON_COUNT = 8;

const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
const crons = vercel.crons || [];

function schedulesFor(pathname) {
  return crons
    .filter((cron) => cron.path === pathname)
    .map((cron) => cron.schedule);
}

function assertValidVercelCronSchedule(schedule) {
  assert.equal(typeof schedule, "string", "cron schedule must be a string");
  const fields = schedule.trim().split(/\s+/);
  assert.equal(fields.length, 5, `${schedule} must use standard 5-field Vercel cron syntax`);
  assert.ok(!/[LW#?]/.test(schedule), `${schedule} uses unsupported extended cron syntax`);
}

for (const cron of crons) {
  assert.equal(typeof cron.path, "string", "cron path must be a string");
  assert.ok(cron.path.startsWith("/api/cron/"), `${cron.path} must stay under /api/cron/`);
  assertValidVercelCronSchedule(cron.schedule);
}

assert.deepEqual(
  schedulesFor("/api/cron/warm-caches"),
  [],
  "warm-caches should remain a manual route only, not a scheduled Vercel cron",
);

assert.deepEqual(
  schedulesFor("/api/cron/refresh-surveillance"),
  [],
  "refresh-surveillance must stay manual-only; local launchd nightly is the reliable NSE ASM/GSM writer",
);

assert.deepEqual(
  schedulesFor("/api/cron/refresh-earnings"),
  [],
  "refresh-earnings is a no-op cache flush and should not be scheduled",
);

assert.deepEqual(
  schedulesFor("/api/cron/refresh-fo-oi"),
  ["30 13 * * 1-5", "15 14 * * 1-5", "0 15 * * 1-5"],
  "F&O retry crons should remain scheduled for post-bhavcopy publication",
);

assert.deepEqual(
  schedulesFor("/api/cron/snapshot-track-record"),
  ["30 4 * * *"],
  "Track Record snapshot cron stays until the local replacement is compared for 3 runs",
);

assert.deepEqual(
  schedulesFor("/api/cron/resolve-forward-returns"),
  ["0 5 * * *"],
  "Track Record resolver cron stays until the local replacement is compared for 3 runs",
);

assert.deepEqual(
  schedulesFor("/api/cron/sws-input-alerts/send"),
  ["30 5 * * *"],
  "SWS input alerts fallback at 05:30 UTC (11:00 IST) lands AFTER the nightly normally deploys a fresh run_id, so the backup can actually deliver instead of deduping the prior already-sent run; local post-deploy trigger remains primary",
);

assert.deepEqual(
  schedulesFor("/api/cron/sws-input-alerts/heartbeat"),
  ["0 12 * * *"],
  "SWS input-alert watchdog at 12:00 UTC (17:30 IST) pages the owner when no fresh run_id exists for today — clears the observed worst-case nightly deploy (~15:49 IST)",
);

assert.ok(
  crons.length < BEFORE_CPU_REDUCTION_CRON_COUNT,
  `expected cron count below ${BEFORE_CPU_REDUCTION_CRON_COUNT}, found ${crons.length}`,
);

console.log(`vercel cron budget checks passed (${crons.length} scheduled crons)`);
