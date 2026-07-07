// Platform menu contract.
//
// The top-right menu duplicates platform navigation from the same tab guards
// used by switchTab(). Account actions stay in the avatar menu.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const ADMIN_ME = {
  userId: "e2e-owner",
  email: "mtaluja11@gmail.com",
  name: "Owner",
  picture: "",
  isAdmin: true,
};

const PUBLIC_MENU_LABELS = [
  "India Market",
  "Market Intelligence",
  "Portfolio Analyzer",
  "Watchlist",
  "US Market",
  "Earnings Watch",
  "Risk Lab",
  "5x Lab",
  "Sector Outlook",
  "Track Record",
];

async function mockAdmin(page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ADMIN_ME),
    }),
  );
}

async function openPlatformMenu(page) {
  const button = page.locator("#labsMenuBtn");
  await expect(button).toBeVisible({ timeout: 10_000 });
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toHaveClass(/is-active/);
  await expect(page.locator("#labsMenuDropdown")).toBeVisible();
}

test.describe("Platform sections menu", () => {
  test("normal user: public platform sections are in the menu and Users stays hidden", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#densityToggleBtn")).toHaveCount(0);
    await expect(page.locator("#labsMenuBtn")).toHaveAccessibleName("Platform menu");
    await expect(page.locator("#labsMenuBtn")).not.toContainText("Platform");
    await expect(page.locator("#labsMenuBtn")).not.toHaveClass(/is-active/);

    await openPlatformMenu(page);
    for (const label of PUBLIC_MENU_LABELS) {
      await expect(page.locator("#labsMenuDropdown [role='menuitem']", { hasText: label })).toBeVisible();
    }
    await expect(page.locator("#platformItem_users")).toHaveCount(0);
    await expect(page.locator("#platformThemeToggle")).toHaveAttribute("role", "menuitemcheckbox");
    await expect(page.locator("#userMenuSignout")).toBeHidden();
  });

  test("admin: Users appears in the tab bar and Platform menu", async ({ page }) => {
    await mockAdmin(page);
    await gotoApp(page);

    await expect(page.locator("#usersTabBtn")).toBeVisible({ timeout: 10_000 });
    await openPlatformMenu(page);
    await expect(page.locator("#platformItem_users")).toBeVisible();
  });

  test("admin: singular #tab=user deep link opens the Users tab", async ({ page }) => {
    await mockAdmin(page);
    await page.goto("/index.html#tab=user", { waitUntil: "domcontentloaded" });

    await expect(page.locator("#usersTabBtn")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#usersTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#usersTabBtn")).toHaveClass(/active/);
  });

  test("clicking a platform section activates its tab and aria-current state", async ({ page }) => {
    await gotoApp(page);
    await openPlatformMenu(page);

    await page.locator("#platformItem_riskLab").click();
    await expect(page.locator("#riskLabTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#riskLabTabBtn")).toHaveAttribute("aria-selected", "true");

    await openPlatformMenu(page);
    await expect(page.locator("#platformItem_riskLab")).toHaveAttribute("aria-current", "page");
  });

  test("Platform menu closes on Escape and outside click", async ({ page }) => {
    await gotoApp(page);
    await openPlatformMenu(page);

    await page.keyboard.press("Escape");
    await expect(page.locator("#labsMenuDropdown")).toBeHidden();
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#labsMenuBtn")).not.toHaveClass(/is-active/);

    await openPlatformMenu(page);
    await page.locator("#main").click({ position: { x: 20, y: 20 } });
    await expect(page.locator("#labsMenuDropdown")).toBeHidden();
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#labsMenuBtn")).not.toHaveClass(/is-active/);
  });
});
