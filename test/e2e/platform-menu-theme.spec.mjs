import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

async function openPlatformMenu(page) {
  await page.locator("#labsMenuBtn").click();
  await expect(page.locator("#labsMenuDropdown")).toBeVisible();
}

test.describe("Platform menu + starbhai theme", () => {
  test("light is the default with empty storage; dark persists through starbhaiTheme", async ({ page }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content)).toBe("#FBFAF7");

    await page.locator("#themeToggleBtn").click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("starbhaiTheme"))).toBe("dark");
    expect(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content)).toBe("#0B0C10");

    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  });

  test("Platform menu theme toggle updates DOM, storage, and meta", async ({ page }) => {
    await gotoApp(page);
    await openPlatformMenu(page);
    const item = page.locator("#platformThemeToggle");
    await expect(item).toHaveAttribute("role", "menuitemcheckbox");
    await item.click();

    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("starbhaiTheme"))).toBe("dark");
    await expect(item).toHaveAttribute("aria-checked", "true");
  });

  test("Platform menu navigation opens US Market and Risk Lab with active heading/title", async ({ page }) => {
    await gotoApp(page);
    await openPlatformMenu(page);
    await page.locator("#platformItem_usPicks").click();
    await expect(page.locator("#usPicksTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#liveTabHeading")).toHaveText(/US Market/);
    await expect(page).toHaveTitle(/US Market/);

    await openPlatformMenu(page);
    await page.locator("#platformItem_riskLab").click();
    await expect(page.locator("#riskLabTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#liveTabHeading")).toHaveText(/Risk Lab/);
    await expect(page).toHaveTitle(/Risk Lab/);
  });

  test("320px mobile header/menu fit without horizontal overflow", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 812 } });
    const page = await ctx.newPage();
    await gotoApp(page);
    await openPlatformMenu(page);
    const result = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, hidden: el.hidden };
      };
      const menu = rect("#labsMenuDropdown");
      const platformBtn = rect("#labsMenuBtn");
      const bottomNav = rect(".bottom-nav, #bottomNav");
      return {
        scrollWidth: document.documentElement.scrollWidth,
        width: window.innerWidth,
        densityButtons: document.querySelectorAll("#densityToggleBtn").length,
        menu,
        platformBtn,
        bottomNav,
      };
    });
    expect(result.scrollWidth).toBeLessThanOrEqual(result.width + 1);
    expect(result.densityButtons).toBe(0);
    expect(result.platformBtn.left).toBeGreaterThanOrEqual(0);
    expect(result.platformBtn.right).toBeLessThanOrEqual(result.width);
    expect(result.menu.left).toBeGreaterThanOrEqual(0);
    expect(result.menu.right).toBeLessThanOrEqual(result.width);
    expect(result.menu.bottom).toBeLessThanOrEqual(812);
    expect(result.bottomNav.bottom).toBeLessThanOrEqual(812);
    await ctx.close();
  });
});
