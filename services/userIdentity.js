/**
 * User-identity resolution — pure, side-effect-free (auth iter 2).
 *
 * Extracted from server.js's userSub() so the security-load-bearing test-mode
 * header gate can be unit-tested in isolation (no server boot, no port). The
 * server delegates to this; the test asserts every branch — crucially that
 * the X-Test-Sub header is IGNORED unless nodeEnv === 'test', so it can never
 * impersonate a user in production.
 *
 * Precedence (highest first):
 *   1. A real authenticated session (reqUser.sub) — always wins.
 *   2. X-Test-Sub header, but ONLY when nodeEnv === 'test'.
 *   3. null when authEnabled (caller 401s) / "_local_dev" in dev.
 */

export function resolveUserSub({ reqUser, headers, authEnabled, nodeEnv } = {}) {
  if (reqUser?.sub) return reqUser.sub;
  if (nodeEnv === "test" && headers?.["x-test-sub"]) {
    return String(headers["x-test-sub"]);
  }
  return authEnabled ? null : "_local_dev";
}
