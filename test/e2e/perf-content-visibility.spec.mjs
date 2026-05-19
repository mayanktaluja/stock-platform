// PR #11: content-visibility: auto on heavy off-screen surfaces so the
// browser skips paint cost for cards / modal sections that aren't in the
// viewport. Validates the CSS rule fires by injecting probes.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #11 content-visibility hints", () => {
  test(".sws-pick-card computed style sets content-visibility: auto", async ({
    page,
  }) => {
    await gotoApp(page);
    const cv = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "sws-pick-card";
      probe.style.position = "absolute";
      probe.style.top = "-9999px";
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).contentVisibility;
      probe.remove();
      return out;
    });
    expect(cv).toBe("auto");
  });

  test(".sws-modal-section computed style sets content-visibility: auto", async ({
    page,
  }) => {
    await gotoApp(page);
    const cv = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "sws-modal-section";
      probe.style.position = "absolute";
      probe.style.top = "-9999px";
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).contentVisibility;
      probe.remove();
      return out;
    });
    expect(cv).toBe("auto");
  });
});
