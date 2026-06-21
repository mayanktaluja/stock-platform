import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Market Radar tab", () => {
  test("is visible to signed-in users with experimental badge and stable states", async ({ page }) => {
    await gotoApp(page);
    const button = page.locator("#marketInformationTabBtn");
    await expect(button).toBeVisible({ timeout: 10_000 });
    await expect(button).toContainText("Market Radar");
    await expect(button).toContainText("EXPERIMENTAL");

    await button.click();
    await expect(page.locator("#marketInformationTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#marketInformationContainer")).toBeAttached();
    await expect(page.locator("#marketInformationRefresh")).toBeVisible();
    await expect(page.locator("#marketInformationSearch")).toBeVisible();
    await expect(page.locator("#marketInformationSource")).toBeVisible();
    await expect(page.locator("#marketInformationScope")).toBeVisible();

    await expect(
      page.locator("#marketInformationContainer .market-information-card, #marketInformationContainer .empty-state, #marketInformationContainer .state--loading, #marketInformationContainer .state--error").first(),
    ).toBeAttached({ timeout: 10_000 });
  });

  test("warming API state renders an error without throwing", async ({ page }) => {
    await page.route("**/api/market-information/latest**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ schema_version: "market-information-v1", status: "warming", message: "warming" }),
      }),
    );
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await gotoApp(page, { tab: "marketInformation" });
    await expect(page.locator("[data-testid='market-information-error']")).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });
});
