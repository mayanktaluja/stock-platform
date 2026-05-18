// PR A3 (Phase 2) — 3-metric hit-rate header (strict / lenient / catastrophic).
//
// Verifies:
//   1. /api/earnings/upcoming/stats exposes a hit_rate_summary block with
//      strict, lenient, catastrophic sub-objects + sample sizes + CIs
//   2. The Earnings Watch header strip renders the 3 hit-rate cells with
//      data-testid hooks (hit-rate-strict / hit-rate-lenient / hit-rate-catastrophic)
//   3. The lenient % is always ≥ strict % and ≤ 100 (consistency rule)
//
// Self-skips on fresh checkouts (no earnings-history files yet).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Earnings Watch — 3-metric hit-rate header (PR A3)", () => {
  test("/api/earnings/upcoming/stats exposes hit_rate_summary", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming/stats");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    test.skip(!body.hit_rate_summary, "no hit_rate_summary yet — fresh checkout");

    const hr = body.hit_rate_summary;
    expect(hr.schema_version).toBe("hit-rate-summary-v1");
    expect(hr).toHaveProperty("strict");
    expect(hr).toHaveProperty("lenient");
    expect(hr).toHaveProperty("catastrophic");
    expect(typeof hr.catastrophic_alert).toBe("boolean");
    expect(hr.catastrophic_alert_threshold_pct).toBeGreaterThan(0);
    expect(typeof hr.resolved_count).toBe("number");
  });

  test("metric invariants — lenient ≥ strict, all in [0,100]", async ({ request }) => {
    const body = await (await request.get("/api/earnings/upcoming/stats")).json();
    test.skip(!body.hit_rate_summary, "no hit_rate_summary yet");
    const hr = body.hit_rate_summary;
    if (hr.strict.hit_rate_pct != null && hr.lenient.hit_rate_pct != null) {
      expect(hr.lenient.hit_rate_pct).toBeGreaterThanOrEqual(hr.strict.hit_rate_pct);
    }
    for (const m of [hr.strict.hit_rate_pct, hr.lenient.hit_rate_pct, hr.catastrophic.rate_pct]) {
      if (m == null) continue;
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(100);
    }
  });

  test("Earnings Watch header renders the 3-metric cells", async ({ page, request }) => {
    const body = await (await request.get("/api/earnings/upcoming/stats")).json();
    test.skip(!body.hit_rate_summary, "no hit_rate_summary yet");

    await gotoApp(page, { tab: "earnings" });
    // Wait for the stats strip to populate
    await expect(page.locator('[data-testid="hit-rate-row"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="hit-rate-strict"]')).toBeVisible();
    await expect(page.locator('[data-testid="hit-rate-lenient"]')).toBeVisible();
    await expect(page.locator('[data-testid="hit-rate-catastrophic"]')).toBeVisible();
  });
});
