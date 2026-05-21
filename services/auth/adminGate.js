// Admin-gate middleware — restricts protected routes to the live ADMIN_EMAILS
// allowlist. Replaces the former personal-use tier, which was folded into the
// admin tier under the two-tier access model. Returns 404 (not 403) so the
// gated routes stay invisible to non-admin authenticated users — no
// admin-discovery surface. The sleeve routes (Compounder Lab, Earnings Edge,
// 5x Lab) rely on this stealth posture.
//
// Admin membership is recomputed PER REQUEST from process.env.ADMIN_EMAILS via
// computeIsAdmin(), so dropping an email from the allowlist revokes access on
// the user's next request (once the process picks up the new env) — no
// re-login required.
//
// In dev / test (AUTH_ENABLED=false) the gate falls through — same posture as
// every other route, so e2e specs and local-dev work unchanged.

import { getUserStorage, computeIsAdmin } from "../../userStorage.js";

export function createAdminGate({ authEnabled }) {
  return async function adminGate(req, res, next) {
    if (!authEnabled) return next();
    const sub = req.user && req.user.sub;
    if (!sub) {
      // 404 (not 401) — the existence of these routes is not advertised to
      // anonymous callers.
      return res.status(404).end();
    }
    try {
      const userStore = getUserStorage();
      const me = await userStore.read(sub);
      const email = me && me.email;
      if (!computeIsAdmin(email)) {
        return res.status(404).end();
      }
      return next();
    } catch (err) {
      console.warn("[adminGate] read failed:", err && err.message);
      return res.status(404).end();
    }
  };
}
