// Per-user rate-limiter key generator (audit finding #6, 2026-05-18 prod
// fixes, Stream B / PR-B2).
//
// Pre-fix the limiter keyed by IP only. Behind shared NAT (corporate office,
// mobile carrier CG-NAT, café Wi-Fi) one heavy user could drain everyone
// else's 60 req/min bucket. This module keys by the authenticated user's
// Google `sub` when available and falls back to IP for unauthenticated
// routes (/api/login, /api/auth/google, /api/health, /api/cron/*).
//
// Lives in its own module so the unit test can import it without booting
// the full server.js (which otherwise binds port 3000 via app.listen).

/**
 * Compute the per-request rate-limit key.
 *
 * @param {object} req - Express request. May be partially-populated by
 *   express-rate-limit internals during teardown; we tolerate that.
 * @returns {string} A namespaced key — `u:<sub>` for authenticated users,
 *   `ip:<address>` for unauthenticated requests, or `ip:unknown` if even
 *   the IP cannot be resolved (defensive — should never happen in practice).
 */
export function apiLimiterKeyGenerator(req) {
  const sub = req?.user?.sub;
  if (typeof sub === "string" && sub.length > 0) return `u:${sub}`;
  // Default to req.ip; express-rate-limit's own default does the same when
  // no keyGenerator is provided. The `ip:` prefix prevents pathological
  // collisions where a user's sub happens to look like an IP literal.
  return `ip:${req?.ip ?? "unknown"}`;
}
