// PR B8 regression: earnings backtest snapshot + admin gating.
//
// Under local Playwright (AUTH_ENABLED=false), the requireEarningsAdmin
// helper short-circuits to "true" — every caller is treated as admin so
// the endpoint responds 200 with the snapshot payload. The harness for
// the auth-enabled non-admin-403 path is documented in test/e2e/README.md.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Earnings backtest snapshot (PR B8)", () => {
  test("/api/earnings/backtest responds with the snapshot shape", async ({ request }) => {
    const res = await request.get("/api/earnings/backtest");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // Either the snapshot is present (with the schema) or the "missing"
    // empty-state — both are acceptable shapes.
    if (body.missing) {
      expect(typeof body.message).toBe("string");
    } else {
      expect(body).toHaveProperty("schema_version");
      expect(body).toHaveProperty("resolved_count");
      expect(body).toHaveProperty("expected_count");
      expect(body).toHaveProperty("enough_data_to_lift_cap");
    }
  });

  test("Track Record admin host stays empty for non-admin sessions", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");
    // With AUTH_ENABLED=false the page-level isAdmin guard is undefined
    // and the host renders nothing. The backtest card on Track Record is
    // admin-only; this confirms non-admin Track Record stays clean.
    const host = page.locator("#trackEarningsBacktestHost");
    await expect(host).toBeAttached();
    const text = (await host.innerText().catch(() => "")).trim();
    expect(text).toBe("");
  });
});
