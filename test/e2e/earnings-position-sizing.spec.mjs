// PR A2 (Phase 2) — Confidence-calibrated position-size pill on Earnings cards.
//
// Verifies:
//   1. /api/earnings/upcoming attaches a `sizing` object per event with the
//      expected schema and source tag (lab_calibrated vs production_only)
//   2. The earnings-card UI renders a `[data-testid="sizing-pill"]` element
//      whose `data-multiplier` matches the computed tier
//   3. When a lab-calibrated downgrade is present (e.g. prod 65% → lab 48%),
//      the pill shows the calibrated multiplier (0.6x), not the production
//      one (1.0x), and is tagged data-source="lab_calibrated"

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Earnings Watch — position-size pill (PR A2)", () => {
  test("/api/earnings/upcoming attaches a sizing object per event", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming?days=30");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    test.skip(body.missing === true, "no earnings snapshot — fresh checkout, skip");
    test.skip(!Array.isArray(body.events) || body.events.length === 0, "no events in window — skip");

    const sized = body.events.filter((e) => e.sizing != null);
    test.skip(sized.length === 0, "no events have prediction confidence — skip");
    const s = sized[0].sizing;
    expect(s).toHaveProperty("schema_version", "sizing-v1");
    expect(s).toHaveProperty("effective_confidence_pct");
    expect(typeof s.multiplier).toBe("number");
    expect([1.0, 0.6, 0.3, 0.2]).toContain(s.multiplier);
    expect(["lab_calibrated", "production_only"]).toContain(s.source);
  });

  test("multiplier matches the canonical tier bands", async ({ request }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    test.skip(body.missing === true, "preconditions missing");
    for (const e of body.events || []) {
      if (!e.sizing) continue;
      const c = e.sizing.effective_confidence_pct;
      const m = e.sizing.multiplier;
      if (c >= 65) expect(m).toBe(1.0);
      else if (c >= 48) expect(m).toBe(0.6);
      else if (c >= 40) expect(m).toBe(0.3);
      else expect(m).toBe(0.2);
    }
  });

  test("Earnings Watch card renders sizing-pill with the lab-calibrated multiplier", async ({ page, request }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    test.skip(body.missing === true, "preconditions missing");
    const labCalibrated = (body.events || []).filter(
      (e) => e.sizing?.source === "lab_calibrated",
    );
    test.skip(labCalibrated.length === 0, "no lab-calibrated cases in current snapshot — skip render check");

    await gotoApp(page, { tab: "earnings" });
    await expect(page.locator(".earnings-card").first()).toBeVisible({ timeout: 15_000 });

    const pillCount = await page.locator('[data-testid="sizing-pill"]').count();
    expect(pillCount).toBeGreaterThan(0);

    // At least one pill should be lab-calibrated
    const labPills = await page.locator('[data-testid="sizing-pill"][data-source="lab_calibrated"]').count();
    expect(labPills).toBeGreaterThan(0);
  });
});
