// Main tab visibility contract.
//
// Public research sections stay in #mainTabs for every signed-in user. The
// legacy More menu remains hidden; only Users is admin-only and is revealed in
// the tab bar by the real /api/auth/me bootstrap.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const ADMIN_ME = {
  userId: "e2e-owner",
  email: "mtaluja11@gmail.com",
  name: "Owner",
  picture: "",
  isAdmin: true,
};

const PUBLIC_MAIN_TABS = [
  "picksTabBtn",
  "analyzerTabBtn",
  "earningsTabBtn",
  "usPicksTabBtn",
  "krPicksTabBtn",
  "twPicksTabBtn",
  "riskLabTabBtn",
  "multibaggerLabTabBtn",
  "sectorOutlookTabBtn",
];

const PUBLIC_DEEP_LINKS = [
  ["multibaggerLab", "#multibaggerLabTab", "#multibaggerLabTabBtn"],
];

const RETIRED_DEEP_LINKS = ["compounder", "earningsEdge"];

async function mockAdmin(page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ADMIN_ME),
    }),
  );
}

test.describe("Main tab visibility", () => {
  test("normal user: public former-dropdown tabs are in the tab bar; Users stays hidden", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#labsMenu")).toBeHidden();
    await expect(page.locator("#usersTabBtn")).toBeHidden();
    await expect(page.locator("#compounderTabBtn")).toHaveCount(0);
    await expect(page.locator("#earningsEdgeTabBtn")).toHaveCount(0);
    await expect(page.locator("#compounderTab")).toHaveCount(0);
    await expect(page.locator("#earningsEdgeTab")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => ({
        compounder: typeof window.loadCompounderLab,
        earningsEdge: typeof window.loadEarningsEdge,
      })))
      .toEqual({ compounder: "undefined", earningsEdge: "undefined" });
    for (const id of PUBLIC_MAIN_TABS) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test("admin: Users appears in the tab bar, while public tabs remain in the bar", async ({ page }) => {
    await mockAdmin(page);
    await gotoApp(page);

    await expect(page.locator("#usersTabBtn")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#labsMenu")).toBeHidden();
    for (const id of PUBLIC_MAIN_TABS) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test("admin: singular #tab=user deep link opens the Users tab", async ({ page }) => {
    await mockAdmin(page);
    await page.goto("/index.html#tab=user", { waitUntil: "domcontentloaded" });

    await expect(page.locator("#usersTabBtn")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#usersTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#usersTabBtn")).toHaveClass(/active/);
  });

  for (const [tab, panel, button] of PUBLIC_DEEP_LINKS) {
    test(`normal user: #tab=${tab} deep link opens the public lab tab`, async ({ page }) => {
      await page.goto(`/index.html#tab=${tab}`, { waitUntil: "domcontentloaded" });

      await expect(page.locator(button)).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(panel)).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(button)).toHaveClass(/active/);
      await expect(page.locator("#usersTabBtn")).toBeHidden();
    });
  }

  for (const tab of RETIRED_DEEP_LINKS) {
    test(`normal user: retired #tab=${tab} deep link falls back to India Market`, async ({ page }) => {
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(`/index.html#tab=${tab}`, { waitUntil: "domcontentloaded" });

      await expect(page.locator("#picksTab")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#picksTabBtn")).toHaveClass(/active/);
      await expect(page.locator("#compounderTabBtn")).toHaveCount(0);
      await expect(page.locator("#earningsEdgeTabBtn")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => window.location.hash))
        .toBe("#tab=picks");
      expect(errors).toEqual([]);
    });
  }

  test("clicking a promoted public tab activates its main-bar button", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("#riskLabTabBtn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#riskLabTabBtn").click();
    await expect(page.locator("#riskLabTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#riskLabTabBtn")).toHaveClass(/active/);
    await expect(page.locator("#labsMenu")).toBeHidden();
  });
});
