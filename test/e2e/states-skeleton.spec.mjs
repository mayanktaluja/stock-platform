// PR #5: renderState() helper covers loading / empty / error states.
// This spec asserts each branch produces the expected markup +
// behaviour, including the Retry button wired to onRetry.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #5 renderState() helper", () => {
  test("loading state renders shimmer skeletons with aria-busy", async ({
    page,
  }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      const c = document.createElement("div");
      c.id = "_probe";
      document.body.appendChild(c);
      window.renderState(c, { state: "loading" });
    });
    const probe = page.locator("#_probe");
    await expect(probe.locator('[data-testid="state-loading"]')).toBeVisible();
    await expect(
      probe.locator('[data-testid="state-loading"]'),
    ).toHaveAttribute("aria-busy", "true");
    // At least 2 skeleton bars
    expect(
      await probe.locator(".state-skeleton--bar").count(),
    ).toBeGreaterThanOrEqual(2);
  });

  test("empty state shows the configured message", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      const c = document.createElement("div");
      c.id = "_probe_empty";
      document.body.appendChild(c);
      window.renderState(c, {
        state: "empty",
        message: "No data yet — please upload.",
      });
    });
    const probe = page.locator("#_probe_empty");
    await expect(probe.locator('[data-testid="state-empty"]')).toBeVisible();
    await expect(probe).toContainText("No data yet — please upload.");
  });

  test("error state shows Retry button that fires onRetry callback", async ({
    page,
  }) => {
    await gotoApp(page);
    const retryCount = await page.evaluate(async () => {
      const c = document.createElement("div");
      c.id = "_probe_error";
      document.body.appendChild(c);
      let calls = 0;
      window.renderState(c, {
        state: "error",
        message: "Something failed.",
        onRetry: () => { calls++; },
      });
      const btn = c.querySelector('[data-testid="state-retry"]');
      btn.click();
      // The handler uses { once: true } — second click should be a no-op
      btn.click();
      return calls;
    });
    expect(retryCount).toBe(1);
  });
});
