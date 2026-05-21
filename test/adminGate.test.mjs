/**
 * Tests for services/auth/adminGate.js + computeIsAdmin (userStorage.js).
 *
 * The former personal-use tier was folded into the admin tier under the
 * two-tier access model. Covers:
 *   • computeIsAdmin honours ADMIN_EMAILS + case-insensitive match
 *   • computeIsAdmin recomputes LIVE — mutating process.env.ADMIN_EMAILS
 *     flips the result on the very next call, with no re-import. This is the
 *     property that lets us revoke an admin by editing the allowlist without a
 *     re-login (the regression guard for the stale-persisted-flag bug).
 *   • Middleware is a no-op when authEnabled=false (dev/test path)
 *   • Middleware 404s anonymous + sub-less callers when authEnabled=true
 *   • Middleware 404s authenticated-but-non-admin callers (stealth, not 403)
 *
 * Run with: node test/adminGate.test.mjs
 */

import { computeIsAdmin } from "../userStorage.js";
import { createAdminGate } from "../services/auth/adminGate.js";

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

function mockRes() {
  const r = { _status: 200, _ended: false, _json: null };
  r.status = (code) => {
    r._status = code;
    return r;
  };
  r.end = () => {
    r._ended = true;
    return r;
  };
  r.json = (obj) => {
    r._json = obj;
    r._ended = true;
    return r;
  };
  return r;
}

async function runMiddleware(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  await new Promise((resolve) => {
    mw(req, res, () => {
      nextCalled = true;
      resolve();
    });
    // If end() is called synchronously, resolve immediately
    if (res._ended) resolve();
    // Async path — give it a microtask
    setTimeout(resolve, 50);
  });
  return { res, nextCalled };
}

const ORIG_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

console.log("\nadminGate — computeIsAdmin");

process.env.ADMIN_EMAILS = "mtaluja11@gmail.com, co@example.com";

assert("allowlisted email passes", computeIsAdmin("mtaluja11@gmail.com") === true);
assert("case-insensitive match", computeIsAdmin("MTaluja11@GMAIL.com") === true);
assert("whitespace-tolerant allowlist entry passes", computeIsAdmin("co@example.com") === true);
assert("non-allowlisted fails", computeIsAdmin("random@x.com") === false);
assert("empty email fails", computeIsAdmin("") === false);
assert("null email fails", computeIsAdmin(null) === false);
assert("undefined email fails", computeIsAdmin(undefined) === false);

console.log("\nadminGate — computeIsAdmin is LIVE (no caching)");

// The revoke guarantee: editing ADMIN_EMAILS changes authority on the very
// next call, with no re-import / re-login. Regression guard for the
// stale-persisted-flag bug that previously kept a removed admin authorized.
process.env.ADMIN_EMAILS = "mtaluja11@gmail.com";
assert("removed email is revoked immediately", computeIsAdmin("co@example.com") === false);
process.env.ADMIN_EMAILS = "mtaluja11@gmail.com, co@example.com";
assert("re-added email is admin immediately", computeIsAdmin("co@example.com") === true);
process.env.ADMIN_EMAILS = "";
assert("empty ADMIN_EMAILS → nobody is admin", computeIsAdmin("mtaluja11@gmail.com") === false);

console.log("\nadminGate — middleware authEnabled=false (test mode)");

const mwDev = createAdminGate({ authEnabled: false });

{
  const { res, nextCalled } = await runMiddleware(mwDev, {});
  assert("dev mode: anonymous call passes through", nextCalled === true && !res._ended);
}
{
  const { res, nextCalled } = await runMiddleware(mwDev, { user: { sub: "x" } });
  assert("dev mode: authenticated call passes through", nextCalled === true && !res._ended);
}

console.log("\nadminGate — middleware authEnabled=true (prod-like)");

const mwProd = createAdminGate({ authEnabled: true });

{
  const { res, nextCalled } = await runMiddleware(mwProd, {});
  assert(
    "prod mode: anonymous → 404 (no next)",
    nextCalled === false && res._status === 404 && res._ended === true,
    { status: res._status, nextCalled },
  );
}
{
  const { res, nextCalled } = await runMiddleware(mwProd, { user: {} });
  assert(
    "prod mode: req.user without sub → 404",
    nextCalled === false && res._status === 404,
    { status: res._status },
  );
}
{
  // Authenticated sub with no matching user record (FileUserStorage has no
  // users.json in CI) → computeIsAdmin(null) is false → 404 stealth (not 403).
  process.env.ADMIN_EMAILS = "mtaluja11@gmail.com";
  const { res, nextCalled } = await runMiddleware(mwProd, { user: { sub: "no-such-user" } });
  assert(
    "prod mode: authenticated non-admin → 404",
    nextCalled === false && res._status === 404,
    { status: res._status },
  );
}

// Restore env so we don't leak into other tests in the npm-test chain.
if (ORIG_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
else process.env.ADMIN_EMAILS = ORIG_ADMIN_EMAILS;

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
