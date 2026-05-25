/**
 * Tests for services/auth/adminGate.js + computeIsAdmin (userStorage.js).
 *
 * The former personal-use tier was folded into the admin tier under the
 * two-tier access model. Covers:
 *   • computeIsAdmin honours the hard-coded owner email + case-insensitive match
 *   • computeIsAdmin ignores ADMIN_EMAILS drift
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

assert("hard-coded owner email passes", computeIsAdmin("mtaluja11@gmail.com") === true);
assert("case-insensitive match", computeIsAdmin("MTALUJA11@GMAIL.COM") === true);
assert("whitespace-tolerant owner email passes", computeIsAdmin("  mtaluja11@gmail.com  ") === true);
assert("ADMIN_EMAILS does not grant admin", computeIsAdmin("co@example.com") === false);
assert("old misspelled owner email fails", computeIsAdmin("mthaluja11@gmail.com") === false);
assert("non-allowlisted fails", computeIsAdmin("random@x.com") === false);
assert("empty email fails", computeIsAdmin("") === false);
assert("null email fails", computeIsAdmin(null) === false);
assert("undefined email fails", computeIsAdmin(undefined) === false);

console.log("\nadminGate — computeIsAdmin ignores env mutation");

process.env.ADMIN_EMAILS = "";
assert("empty ADMIN_EMAILS does not revoke the owner", computeIsAdmin("mtaluja11@gmail.com") === true);
process.env.ADMIN_EMAILS = "co@example.com";
assert("mutated ADMIN_EMAILS still does not grant co-admin", computeIsAdmin("co@example.com") === false);

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
