// Compounder Lab tab — SAFE sleeve from the 2026-05-19 alpha-strategy plan.
//
// Verifies:
//   1. /api/compounder/latest serves the JSON schema we expect
//   2. /api/compounder/paper-trades serves the ledger
//   3. /api/auth/me no longer carries an isPersonal flag (the personal-use
//      tier was folded into admin; the response is { ..., isAdmin } only)
//   4. The Compounder Lab tab renders the basket when window.__starbhai_isAdmin
//      is forced on (the tab is admin-gated + hidden by default)
//
// Self-skips when data/compounder/latest.json is missing — same pattern as
// every other tab-with-snapshot e2e spec in this repo.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Compounder Lab (SAFE sleeve)", () => {
  test("/api/compounder/latest serves expected schema", async ({ request }) => {
    const res = await request.get("/api/compounder/latest");
    test.skip(res.status() === 404, "no compounder snapshot — fresh checkout");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("compounder-latest-v1");
    expect(body).toHaveProperty("filter");
    expect(body.filter.min_snowflake_past).toBe(5);
    expect(body.filter.min_snowflake_health).toBe(4);
    expect(body.filter.min_snowflake_dividend).toBe(4);
    expect(Array.isArray(body.basket)).toBe(true);
    // Every basket entry must have the fields the UI reads.
    for (const b of body.basket) {
      expect(b).toHaveProperty("ticker");
      expect(b).toHaveProperty("snowflake_past");
      expect(b).toHaveProperty("snowflake_health");
      expect(b).toHaveProperty("snowflake_dividend");
      expect(b).toHaveProperty("upside_pct");
      expect(b).toHaveProperty("market_cap_inr");
      expect(b.snowflake_past).toBeGreaterThanOrEqual(5);
      expect(b.snowflake_health).toBeGreaterThanOrEqual(4);
      expect(b.snowflake_dividend).toBeGreaterThanOrEqual(4);
    }
    // Basket is sorted by upside_pct DESC.
    for (let i = 1; i < body.basket.length; i++) {
      expect(Number(body.basket[i].upside_pct)).toBeLessThanOrEqual(
        Number(body.basket[i - 1].upside_pct),
      );
    }
  });

  test("/api/compounder/paper-trades serves a ledger", async ({ request }) => {
    const res = await request.get("/api/compounder/paper-trades");
    test.skip(res.status() === 404, "no compounder ledger");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("paper-trades-v1");
    expect(body.strategy).toBe("compounder");
    expect(Array.isArray(body.trades)).toBe(true);
    for (const t of body.trades) {
      expect(t).toHaveProperty("ticker");
      expect(t).toHaveProperty("status");
      expect(["OPEN", "CLOSED"]).toContain(t.status);
    }
  });

  test("UI renders the basket table when admin flag is on", async ({ page, request }) => {
    const apiRes = await request.get("/api/compounder/latest");
    test.skip(apiRes.status() === 404, "no compounder snapshot");

    await gotoApp(page);
    // In test mode AUTH_ENABLED=false so /api/auth/me returns 401 and the
    // SPA never sets __starbhai_isAdmin=true. Force it on here so the tab is
    // reachable; this is exactly what the SPA bootstrap does when a real
    // admin signs in.
    await page.evaluate(() => {
      window.__starbhai_isAdmin = true;
      const btn = document.getElementById("compounderTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab("compounder"));
    await expect(page.locator("#compounderTab")).toBeVisible({ timeout: 10_000 });
    // The tab renders a heading + a table of basket members.
    await expect(page.locator("#compounderTab")).toContainText("Compounder Lab", {
      timeout: 10_000,
    });
    // At least one ticker cell appears.
    const tbody = page.locator("#compounderTab table tbody");
    await expect(tbody).toBeVisible({ timeout: 10_000 });
    const rowCount = await tbody.locator("tr").count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  test("tab guard rejects when admin flag is off", async ({ page }) => {
    await gotoApp(page);
    // Default state: __starbhai_isAdmin undefined → guard returns false →
    // switchTab is an early return → tab stays hidden.
    await page.evaluate(() => window.switchTab("compounder"));
    // The compounder tab should NOT be visible — switchTab is a no-op when
    // guard fails.
    await expect(page.locator("#compounderTab")).toBeHidden();
  });

  test("/api/auth/me response shape no longer carries isPersonal", async ({ request }) => {
    // In test mode AUTH_ENABLED=false so /api/auth/me returns 401. The
    // server-side admin wiring is unit-tested via adminGate.test.mjs. This
    // spec asserts the test-mode shape; if auth is ever enabled in e2e it also
    // guards that the dropped isPersonal field does not resurface.
    const res = await request.get("/api/auth/me");
    expect([200, 401]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).not.toHaveProperty("isPersonal");
      expect(body).toHaveProperty("isAdmin");
    }
  });
});
