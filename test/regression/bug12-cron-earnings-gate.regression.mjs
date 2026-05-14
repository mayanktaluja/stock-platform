/**
 * Regression: GET /api/cron/refresh-earnings must be CRON_SECRET-gated.
 *
 * Bug #12 — this cron route was left public ("harmless... just dumps a
 * cache"), while every other /api/cron/* route is CRON_SECRET-gated. That
 * left a free cache-flush vector and an inconsistent cron family. The fix
 * applies the same 4-line bearer-token guard the other crons use.
 *
 * The regression runner boots the server WITH CRON_SECRET set (passed in
 * via REGRESSION_CRON_SECRET), so this test can exercise both the 401 and
 * the authorised 200 paths. In local dev, where CRON_SECRET is unset, the
 * route stays open by design — same as the rest of the cron family.
 *
 * Run via: npm run test:regression  (needs the suite's live server)
 */
const BASE = process.env.REGRESSION_BASE_URL || "http://localhost:4022";
const CRON_SECRET = process.env.REGRESSION_CRON_SECRET || "regression-test-secret";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

async function getCron(headers = {}) {
  const res = await fetch(`${BASE}/api/cron/refresh-earnings`, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log("Bug #12 — /api/cron/refresh-earnings CRON_SECRET gate");

const noHeader = await getCron();
assert("no Authorization header → 401", noHeader.status === 401, noHeader);

const wrongToken = await getCron({ Authorization: "Bearer wrong-token" });
assert("wrong bearer token → 401", wrongToken.status === 401, wrongToken);

const authed = await getCron({ Authorization: `Bearer ${CRON_SECRET}` });
assert("correct bearer token → 200", authed.status === 200, authed);
assert(
  "authorised response still flushes the cache",
  authed.body?.ok === true && authed.body?.flushed === true,
  authed.body,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
