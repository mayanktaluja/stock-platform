// PR T7 regression: calibration plot + /api/track/calibration endpoint.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Track Record calibration (PR T7)", () => {
  test("/api/track/calibration returns 5 buckets + thin flags", async ({ request }) => {
    const res = await request.get("/api/track/calibration");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(body.buckets.length).toBe(5);
    for (const b of body.buckets) {
      expect(b).toHaveProperty("bucket_low");
      expect(b).toHaveProperty("bucket_high");
      expect(b).toHaveProperty("n");
      expect(b).toHaveProperty("thin");
    }
  });

  test("SVG renders on the Track Record tab with axes and reference line", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");
    const svg = page.locator("#trackCalibrationSvg");
    await expect(svg).toBeVisible({ timeout: 10_000 });
    await expect(svg).toHaveAttribute("role", "img");
    await expect(svg).toHaveAttribute(
      "aria-label",
      /Calibration plot/i
    );
    // Diagonal reference exists (dashed 45° path).
    const dashedPath = svg.locator("path[stroke-dasharray]");
    await expect(dashedPath).toHaveCount(1);
  });
});
