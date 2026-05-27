import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("global macro regime banner", () => {
  test("India Market shell does not render or fetch the global macro banner", async ({ page }) => {
    const macroRegimeRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/macro/regime") {
        macroRegimeRequests.push(request.url());
      }
    });

    await gotoApp(page, { tab: "picks" });

    await expect(page.locator("#macroRegimeBanner")).toHaveCount(0);
    const visibleText = await page.locator("body").evaluate((body) => body.innerText);
    expect(visibleText).not.toMatch(/\bMarket Regime\b/);
    expect(macroRegimeRequests).toEqual([]);
  });
});
