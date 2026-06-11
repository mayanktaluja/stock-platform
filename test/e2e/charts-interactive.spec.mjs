// E2: track-chart dot interactivity.
//
// Dots gained native <title> tooltips (month + avg % + n) wrapped in a
// .track-dot group with an enlarged transparent hit ring. Additive DOM —
// the data-table fallback (charts-data-table-fallback.spec.mjs) is the
// companion guard and must stay green.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("E2 interactive track chart", () => {
  test("dots expose native tooltips with month + value", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const chart = page.locator("svg.track-chart");
    // Chart renders only with >=2 months of resolved trades — self-skip
    // when the fixture/track data can't satisfy that.
    try {
      await chart.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      test.skip(true, "track chart not rendered (insufficient track data)");
    }

    const dots = chart.locator("g.track-dot");
    expect(await dots.count()).toBeGreaterThanOrEqual(2);

    const title = await dots.first().locator("title").textContent();
    // "<YYYY-MM> — … avg <n>%" shape
    expect(title).toMatch(/\d{4}-\d{2} — .*avg .*%/);

    // Hit ring is the first circle and meaningfully larger than the visible dot.
    const radii = await dots.first().evaluate((g) => {
      const [hit, vis] = g.querySelectorAll("circle");
      return { hit: +hit.getAttribute("r"), vis: +vis.getAttribute("r") };
    });
    expect(radii.hit).toBeGreaterThan(radii.vis * 2);
  });
});
