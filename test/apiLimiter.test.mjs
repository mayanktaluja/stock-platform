/**
 * Unit test — apiLimiter per-user key generation (audit finding #6,
 * 2026-05-18 prod fixes, Stream B / PR-B2).
 *
 * Pre-fix the limiter keyed by IP only. Behind shared NAT (corporate office,
 * mobile carrier CG-NAT, café Wi-Fi) one heavy user could drain everyone
 * else's 60 req/min bucket. The fix keys by the authenticated user's Google
 * `sub` when available and falls back to IP for unauthenticated routes
 * (/api/login, /api/auth/google, /api/health).
 *
 * The keyGenerator lives in its own module (services/apiLimiterKey.js) so we
 * can test it without spinning up the whole Express app — no network, no
 * Yahoo, no SWS engine, no test fixtures. Pure function.
 *
 * Run with: node test/apiLimiter.test.mjs
 */

import { apiLimiterKeyGenerator } from "../services/apiLimiterKey.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`);
  }
}

console.log("\n=== apiLimiterKeyGenerator ===\n");

// Happy path: authenticated request → keys by user sub.
{
  const req = { user: { sub: "118291837461237486" }, ip: "1.2.3.4" };
  const key = apiLimiterKeyGenerator(req);
  assert(
    "authenticated user keys by sub (not IP)",
    key === "u:118291837461237486",
    key,
  );
}

// Fallback: unauthenticated request → keys by IP. This covers /api/login,
// /api/auth/google, /api/health, /api/cron/* — all of which the auth gate
// passes through with req.user undefined.
{
  const req = { ip: "203.0.113.5" }; // no user
  const key = apiLimiterKeyGenerator(req);
  assert(
    "unauthenticated request falls back to IP",
    key === "ip:203.0.113.5",
    key,
  );
}

// Edge case: req.user object present but `sub` missing (mal-decoded session
// or partial auth state). Treat as unauthenticated → IP fallback.
{
  const req = { user: {}, ip: "1.2.3.4" };
  const key = apiLimiterKeyGenerator(req);
  assert(
    "req.user without .sub falls back to IP",
    key === "ip:1.2.3.4",
    key,
  );
}

// Edge case: req.user.sub is an empty string (defensive).
{
  const req = { user: { sub: "" }, ip: "1.2.3.4" };
  const key = apiLimiterKeyGenerator(req);
  assert(
    "empty-string sub falls back to IP",
    key === "ip:1.2.3.4",
    key,
  );
}

// Edge case: req.user.sub is not a string (defensive — should never happen
// in practice but the keyGenerator must not throw).
{
  const req = { user: { sub: 12345 }, ip: "1.2.3.4" };
  const key = apiLimiterKeyGenerator(req);
  assert(
    "non-string sub falls back to IP",
    key === "ip:1.2.3.4",
    key,
  );
}

// Critical correctness check: two requests from the same IP but different
// users get DIFFERENT keys. This is the actual bug the PR fixes — one
// heavy user behind shared NAT can no longer drain a colleague's bucket.
{
  const sharedIp = "10.0.0.1";
  const a = apiLimiterKeyGenerator({ user: { sub: "user-A" }, ip: sharedIp });
  const b = apiLimiterKeyGenerator({ user: { sub: "user-B" }, ip: sharedIp });
  assert(
    "two users behind same IP get separate counters",
    a !== b && a === "u:user-A" && b === "u:user-B",
    { a, b },
  );
}

// The IP/user key namespaces never collide — a sub that happens to look
// like an IP literal still hashes to a different bucket than the IP itself.
{
  const a = apiLimiterKeyGenerator({ user: { sub: "1.2.3.4" }, ip: "5.6.7.8" });
  const b = apiLimiterKeyGenerator({ ip: "1.2.3.4" });
  assert(
    "sub that looks like an IP doesn't collide with IP namespace",
    a !== b,
    { a, b },
  );
}

// Total-resilience check: null/undefined req should not throw — the limiter
// will never actually call us with null req but defensive coding matters in
// case express-rate-limit's internals change.
{
  const k1 = apiLimiterKeyGenerator(null);
  const k2 = apiLimiterKeyGenerator(undefined);
  const k3 = apiLimiterKeyGenerator({});
  assert(
    "null / undefined / empty req returns a sentinel rather than throwing",
    k1 === "ip:unknown" && k2 === "ip:unknown" && k3 === "ip:unknown",
    { k1, k2, k3 },
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
