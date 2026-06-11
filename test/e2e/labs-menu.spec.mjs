// Platform menu contract.
//
// The old Labs/More DOM IDs remain for compatibility, but the user-facing
// control is now the Platform menu. Public sections appear in both the menu
// and #mainTabs; Users is admin-gated.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const ADMIN_ME = {
  userId: "e2e-owner",
  email: "mtaluja11@gmail.com",
  name: "Owner",
  picture: "",
  isAdmin: true,
};

const PLATFORM_TAB_ORDER = [
  ["picksTabBtn", "India Market"],
  ["newsTabBtn", "Market Intelligence"],
  ["analyzerTabBtn", "Portfolio Analyzer"],
  ["watchlistTabBtn", "Watchlist"],
  ["usPicksTabBtn", "US Market"],
  ["krPicksTabBtn", "Korea Market"],
  ["twPicksTabBtn", "Taiwan Market"],
  ["earningsTabBtn", "Earnings Watch"],
  ["riskLabTabBtn", "Risk Lab"],
  ["multibaggerLabTabBtn", "5x Lab"],
  ["sectorOutlookTabBtn", "Sector Outlook"],
  ["trackTabBtn", "Track Record"],
];

const PUBLIC_DEEP_LINKS = [
  ["multibaggerLab", "#multibaggerLabTab", "#multibaggerLabTabBtn"],
  ["riskLab", "#riskLabTab", "#riskLabTabBtn"],
  ["sectorOutlook", "#sectorOutlookTab", "#sectorOutlookTabBtn"],
  ["usPicks", "#usPicksTab", "#usPicksTabBtn"],
];

const RETIRED_DEEP_LINKS = ["compounder", "earningsEdge"];

async function openPlatformMenu(page) {
  await page.locator("#labsMenuBtn").click();
  await expect(page.locator("#labsMenuDropdown")).toBeVisible();
}

async function mockAdmin(page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ADMIN_ME),
    }),
  );
}

test.describe("Platform sections menu", () => {
  test("normal user: public platform sections are in the Platform menu and tablist; Users stays hidden", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#labsMenu")).toBeVisible();
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute(
      "aria-label",
      "Platform menu",
    );
    await expect(page.locator("#labsMenuBtn")).toContainText("Platform");
    await expect(page.locator("#labsMenuDropdown")).toHaveAttribute(
      "aria-label",
      "Platform sections",
    );
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
    await expect(page.locator("#mainTabs")).toHaveAttribute(
      "aria-label",
      "Platform sections",
    );
    await expect(page.locator("#mainTabs")).toHaveAttribute(
      "role",
      "tablist",
    );

    for (const [id, label] of PLATFORM_TAB_ORDER) {
      const tab = page.locator(`#${id}`);
      await expect(tab, `${label} tab should be present`).toBeVisible();
      await expect(tab).toHaveAttribute("role", "tab");
      await expect(tab).toContainText(label);
      const controls = await tab.getAttribute("aria-controls");
      expect(controls, `${label} must point at a tabpanel`).toBeTruthy();
      await expect(page.locator(`#${controls}`)).toHaveAttribute(
        "role",
        "tabpanel",
      );
    }

    await openPlatformMenu(page);
    for (const [, label] of PLATFORM_TAB_ORDER) {
      await expect(
        page.locator("#labsMenuDropdown .labs-menu-item", { hasText: label }),
        `${label} menu item should be present`,
      ).toBeVisible();
    }
    await expect(page.locator("#labsMenuDropdown")).not.toContainText("Users");
    await expect(page.locator("#platformThemeToggle")).toBeVisible();
    await expect(page.locator("#platformThemeToggle")).toHaveAttribute(
      "role",
      "menuitemcheckbox",
    );
  });

  test("admin: Users appears in the tab bar, while public tabs remain in the bar", async ({ page }) => {
    await mockAdmin(page);
    await gotoApp(page);

    await expect(page.locator("#usersTabBtn")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#labsMenu")).toBeVisible();
    for (const [id] of PLATFORM_TAB_ORDER) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    await openPlatformMenu(page);
    await expect(
      page.locator("#labsMenuDropdown .labs-menu-item", { hasText: "Users" }),
    ).toBeVisible();
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
      await openPlatformMenu(page);
      await expect(page.locator(`#platformItem_${tab}`)).toHaveAttribute(
        "aria-current",
        "page",
      );
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

  test("clicking a platform section activates its tab and aria-selected state", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("#riskLabTabBtn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#riskLabTabBtn").click();
    await expect(page.locator("#riskLabTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#riskLabTabBtn")).toHaveClass(/active/);
    await expect(page.locator("#riskLabTabBtn")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#picksTabBtn")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await openPlatformMenu(page);
    await expect(page.locator("#platformItem_riskLab")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("Platform menu closes on Escape and outside click", async ({ page }) => {
    await gotoApp(page);

    await openPlatformMenu(page);
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#labsMenuDropdown")).toBeHidden();
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await openPlatformMenu(page);
    await page.locator("#picksTab h2").click();
    await expect(page.locator("#labsMenuDropdown")).toBeHidden();
  });
});
