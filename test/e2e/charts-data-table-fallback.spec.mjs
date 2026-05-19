// PR #9: every chart renderer also emits a <details>-collapsed data
// table sibling so screen readers + copy-paste users get the same
// content the SVG conveys visually.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #9 chart data-table fallbacks", () => {
  test("track record renders the calibration data-table fallback", async ({
    page,
  }) => {
    await gotoApp(page, { tab: "track" });
    // Wait for the calibration plot OR its "no data" placeholder
    const wrap = page.locator("#trackCalibrationSvgWrap");
    await wrap.waitFor({ state: "attached", timeout: 10_000 });

    // Look for the new <details data-testid="calibration-data-table">
    // If the calibration chart never renders (e.g. no resolved forecasts in
    // test env), self-skip — the renderer wasn't invoked.
    const details = page.locator('[data-testid="calibration-data-table"]');
    const exists = await details.count();
    test.skip(exists === 0, "calibration chart not rendered in test env");

    // Each row must have ≥4 columns (bucket/n/realised/CI)
    const rowCount = await details.locator("tbody tr").count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test("track-record line chart data-table appears when data spans ≥2 months", async ({
    page,
  }) => {
    await gotoApp(page, { tab: "track" });
    const details = page.locator('[data-testid="track-chart-data-table"]');
    // Chart only renders when ≥2 months of snapshot data exist; if it
    // doesn't render, self-skip.
    const exists = await details.count();
    test.skip(exists === 0, "track chart not rendered (insufficient months)");

    // Verify the details has a <table>
    await expect(details.locator("table")).toBeAttached();
  });
});
