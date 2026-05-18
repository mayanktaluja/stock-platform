// PR B3 (Phase 2) — Macro Thesis sub-view in Risk Lab tab.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Risk Lab — Macro Thesis sub-view (PR B3)", () => {
  test("/api/risk-lab/macro-thesis returns the macro-thesis-v1 schema", async ({ request }) => {
    const res = await request.get("/api/risk-lab/macro-thesis");
    if (res.status() === 404 || res.status() === 503) {
      test.skip(true, "Risk Lab disabled or macro-thesis file not generated");
    }
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("macro-thesis-v1");
    expect(body).toHaveProperty("branches");
    expect(body).toHaveProperty("regime");
    expect(body).toHaveProperty("caveats");
    expect(body).toHaveProperty("position_cap_pct");
  });

  test("branches always include the 4 canonical scenarios", async ({ request }) => {
    const res = await request.get("/api/risk-lab/macro-thesis");
    if (res.status() === 404 || res.status() === 503) test.skip(true, "preconditions missing");
    const body = await res.json();
    if (body.indeterminate) test.skip(true, "thesis indeterminate — no branches");
    const keys = body.branches.map((b) => b.key).sort();
    expect(keys).toEqual(["continue", "de_escalate", "escalate", "new_shock"]);
    const probSum = body.branches.reduce((a, b) => a + (b.probability || 0), 0);
    // Probabilities sum to ~1.0 (allow rounding tolerance)
    expect(Math.abs(probSum - 1)).toBeLessThan(0.06);
  });

  test("Risk Lab tab renders Macro Thesis sub-view on click", async ({ page, request }) => {
    const apiRes = await request.get("/api/risk-lab/macro-thesis");
    if (apiRes.status() === 404 || apiRes.status() === 503) test.skip(true, "preconditions missing");
    await gotoApp(page, { tab: "riskLab" });
    // Wait for Risk Lab tab to load + the lens buttons to appear
    await expect(page.locator("button:has-text('Macro Thesis')")).toBeVisible({ timeout: 15_000 });
    await page.click("button:has-text('Macro Thesis')");
    await expect(page.locator('[data-testid="macro-thesis-root"]')).toBeVisible({ timeout: 10_000 });
    // The position-cap warning should always be present (SEBI Reg 16) — match the BANNER specifically (caveats list also mentions it).
    await expect(page.locator("text=Position-sizing cap").first()).toBeVisible();
    // SEBI Reg 16 caveats block should also be present
    await expect(page.locator('[data-testid="thesis-caveats"]')).toBeVisible();
  });
});
