// PR #10: at small viewports, interactive controls have ≥44×44 px
// touch targets (WCAG 2.5.5 + iOS / Android HIG).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #10 hit targets ≥44px on mobile", () => {
  test(".bottom-nav-btn buttons are ≥44×44px at 375px viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page);
    const buttons = page.locator(".bottom-nav-btn");
    const count = await buttons.count();
    expect(count).toBe(5);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box, `bottom-nav button ${i} must have a bounding box`).not.toBeNull();
      expect(
        box.width,
        `bottom-nav button ${i} width = ${box.width}`,
      ).toBeGreaterThanOrEqual(44);
      expect(
        box.height,
        `bottom-nav button ${i} height = ${box.height}`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  test(".btn (PR #4 primitive) is ≥44px tall on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page);
    // Probe: inject a .btn into the page and measure
    const height = await page.evaluate(() => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "Probe";
      b.style.position = "absolute";
      b.style.top = "0px";
      b.style.left = "0px";
      document.body.appendChild(b);
      const h = b.getBoundingClientRect().height;
      b.remove();
      return h;
    });
    expect(height).toBeGreaterThanOrEqual(44);
  });
});
