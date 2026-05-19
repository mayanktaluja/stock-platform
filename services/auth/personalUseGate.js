// Personal-use middleware — restricts protected routes to a hard-coded
// allowlist of Google account emails.
//
// Per ~/.claude/plans/sws-alpha-strategy-2026-05-19.md adversarial finding
// A10 (and the user's approval to hard-code the allowlist), the only
// defensible compliance posture for a personal trading-platform without
// SEBI RA registration is server-side single-user gating. Returns 404
// (not 403) so the routes are invisible to other authenticated users —
// no admin reconnaissance surface.
//
// Default allowlist: mtaluja11@gmail.com (the platform owner per global
// CLAUDE.md). Overridable via PERSONAL_USE_EMAILS env var (comma-separated)
// so the user can add a co-trader account later without a code change.
//
// In test mode (AUTH_ENABLED=false), the gate falls through — same posture
// as every other route in the app, so e2e specs and local-dev work.

import { getUserStorage } from "../../userStorage.js";

const DEFAULT_ALLOWLIST = ["mtaluja11@gmail.com"];

function readAllowlist() {
  const raw = process.env.PERSONAL_USE_EMAILS;
  if (!raw || typeof raw !== "string") return DEFAULT_ALLOWLIST.slice();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Cached at module load — process restarts pick up env changes. Tests can
// reset via the exported __setAllowlistForTesting.
let _allowlist = readAllowlist();

export function __setAllowlistForTesting(list) {
  _allowlist = list == null ? readAllowlist() : list.map((e) => e.toLowerCase());
}

export function isPersonalAllowed(email) {
  if (!email) return false;
  return _allowlist.includes(String(email).trim().toLowerCase());
}

// AUTH_ENABLED is the runtime auth flag from server.js (set when all four
// Google OAuth env vars are present). When auth is disabled (dev / test),
// the gate is a no-op so e2e specs work unchanged. When auth IS enabled, we
// require req.user.sub + the persisted user record's email to be in the
// allowlist.
export function createPersonalUseGate({ authEnabled }) {
  return async function personalUseGate(req, res, next) {
    if (!authEnabled) return next();
    const sub = req.user && req.user.sub;
    if (!sub) {
      // Return 404 (not 401) — the existence of these routes is itself
      // not advertised to anonymous callers.
      return res.status(404).end();
    }
    try {
      const userStore = getUserStorage();
      const me = await userStore.read(sub);
      const email = me && me.email;
      if (!isPersonalAllowed(email)) {
        return res.status(404).end();
      }
      return next();
    } catch (err) {
      console.warn("[personalUseGate] read failed:", err && err.message);
      return res.status(404).end();
    }
  };
}
