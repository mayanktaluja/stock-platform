// SWS refresh endpoints must be admin-only.
//
// /api/sws-scan/initial-start, /api/sws-refresh/{quick,earnings,full} write
// `data/sws/refresh-requested.json` — the marker file that tees up multi-hour
// scrape work via the launchd pipeline. Before this gate landed, any
// signed-in (non-admin) user could trigger that workload by POSTing without
// any in-app affordance — a privilege-escalation footgun. This spec locks
// the contract: under the default e2e harness (AUTH_ENABLED=false), all four
// endpoints return 401 "auth-disabled" — matching the existing
// /api/admin/users convention.

import { test, expect } from "@playwright/test";

const ADMIN_GATED_ENDPOINTS = [
  "/api/sws-scan/initial-start",
  "/api/sws-refresh/quick",
  "/api/sws-refresh/earnings",
  "/api/sws-refresh/full",
];

test.describe("SWS refresh endpoints are admin-gated", () => {
  for (const endpoint of ADMIN_GATED_ENDPOINTS) {
    test(`POST ${endpoint} rejects unauthenticated requests`, async ({ request }) => {
      const res = await request.post(endpoint, {
        data: {},
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status(), `Expected admin-gated 401/403 on ${endpoint}, got ${res.status()}`)
        .toBeGreaterThanOrEqual(401);
      expect(res.status(), `Expected admin-gated 401/403 on ${endpoint}, got ${res.status()}`)
        .toBeLessThanOrEqual(403);
      const body = await res.json().catch(() => ({}));
      expect(body, `Expected JSON error body from ${endpoint}`).toHaveProperty("error");
    });
  }
});
