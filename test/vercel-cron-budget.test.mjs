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
  ["30 22 * * 1-5"],
  "refresh-surveillance should run on weekdays only",
);

assert.deepEqual(
  schedulesFor("/api/cron/refresh-earnings"),
  ["0 4 * * *"],
  "refresh-earnings should remain scheduled",
);

assert.ok(
  crons.length < BEFORE_CPU_REDUCTION_CRON_COUNT,
  `expected cron count below ${BEFORE_CPU_REDUCTION_CRON_COUNT}, found ${crons.length}`,
);

console.log(`vercel cron budget checks passed (${crons.length} scheduled crons)`);
