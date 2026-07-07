// resolveUserSub() unit tests (auth iter 2) — the security gate.
//
// The two-user e2e harness injects identity via an X-Test-Sub header. That
// header is a loaded gun: if it were honored in production, anyone could set
// `X-Test-Sub: <victim>` and read any user's namespaced data. This test locks
// the gate: the header is resolved ONLY when nodeEnv === 'test', and a real
// authenticated session always wins over it.

import { strict as assert } from "node:assert";
import { resolveUserSub } from "../services/userIdentity.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); failed += 1; }
}

console.log("\n[1] A real session always wins");
test("reqUser.sub beats everything (even a test header in test mode)", () => {
  const got = resolveUserSub({
    reqUser: { sub: "real_google_sub" },
    headers: { "x-test-sub": "attacker" },
    authEnabled: true,
    nodeEnv: "test",
  });
  assert.equal(got, "real_google_sub");
});

console.log("\n[2] X-Test-Sub is honored ONLY under NODE_ENV==='test'");
test("test mode + header → header value", () => {
  const got = resolveUserSub({
    reqUser: null,
    headers: { "x-test-sub": "e2e_user_A" },
    authEnabled: false,
    nodeEnv: "test",
  });
  assert.equal(got, "e2e_user_A");
});
test("test header is coerced to a string", () => {
  const got = resolveUserSub({
    reqUser: null, headers: { "x-test-sub": 12345 }, authEnabled: false, nodeEnv: "test",
  });
  assert.equal(got, "12345");
  assert.equal(typeof got, "string");
});

console.log("\n[3] SECURITY: X-Test-Sub is IGNORED outside test mode");
test("production + header + authEnabled → null (NOT the header)", () => {
  const got = resolveUserSub({
    reqUser: null,
    headers: { "x-test-sub": "attacker" },
    authEnabled: true,
    nodeEnv: "production",
  });
  assert.equal(got, null, "prod must ignore X-Test-Sub and fall through to the 401 path");
});
test("undefined NODE_ENV + header + authEnabled → null", () => {
  const got = resolveUserSub({
    reqUser: null, headers: { "x-test-sub": "attacker" }, authEnabled: true, nodeEnv: undefined,
  });
  assert.equal(got, null);
});
test("dev NODE_ENV (not 'test') + header → _local_dev, header ignored", () => {
  const got = resolveUserSub({
    reqUser: null, headers: { "x-test-sub": "attacker" }, authEnabled: false, nodeEnv: "development",
  });
  assert.equal(got, "_local_dev");
});

console.log("\n[4] No-session fallbacks");
test("authEnabled, no session, no test header → null", () => {
  assert.equal(resolveUserSub({ reqUser: null, headers: {}, authEnabled: true, nodeEnv: "production" }), null);
});
test("dev (authEnabled=false), no session → _local_dev", () => {
  assert.equal(resolveUserSub({ reqUser: null, headers: {}, authEnabled: false, nodeEnv: "test" }), "_local_dev");
});
test("no args at all → _local_dev (defensive default)", () => {
  assert.equal(resolveUserSub(), "_local_dev");
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
