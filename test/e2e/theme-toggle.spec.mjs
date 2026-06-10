// A1: light/dark theme boot + token flip.
//
// Covers the FOUC-safe boot script in <head>: it must set data-theme on
// <html> synchronously, resolving stored choice > OS preference > dark, and
// the [data-theme="light"] token block must actually flip the cascade.
//
// Navigates directly to /index.html (NOT gotoApp) because gotoApp clears
// localStorage on first navigation, which would wipe the stored-choice case.

import { test, expect } from "@playwright/test";

async function themeAttr(page) {
  return page.evaluate(() =>
    document.documentElement.getAttribute("data-theme"),
  );
}
async function token(page, name) {
  return page.evaluate(
    (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

test.describe("A1 theme boot", () => {
  test("OS light + no stored choice → light", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto("/index.html");
    expect(await themeAttr(page)).toBe("light");
    await ctx.close();
  });

  test("OS dark + no stored choice → dark", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/index.html");
    expect(await themeAttr(page)).toBe("dark");
    await ctx.close();
  });

  test("stored choice overrides OS preference", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    // Seed the stored choice before the boot script runs.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("theme", "light");
      } catch (e) {}
    });
    await page.goto("/index.html");
    expect(await themeAttr(page)).toBe("light");
    await ctx.close();
  });

  test("data-theme is set synchronously (no FOUC)", async ({ page }) => {
    // domcontentloaded, not networkidle: the attribute must already be there
    // because the boot script is synchronous in <head>.
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const t = await themeAttr(page);
    expect(["light", "dark"]).toContain(t);
    // density default also applied early
    expect(await page.evaluate(() =>
      document.documentElement.getAttribute("data-density"),
    )).toBe("comfortable");
  });

  test("light tokens actually flip the cascade", async ({ browser }) => {
    const dark = await browser.newContext({ colorScheme: "dark" });
    const dp = await dark.newPage();
    await dp.goto("/index.html");
    const darkBg = await token(dp, "--bg-primary");
    const darkText = await token(dp, "--text-primary");
    const darkGreen = await token(dp, "--green");
    await dark.close();

    const light = await browser.newContext({ colorScheme: "light" });
    const lp = await light.newPage();
    await lp.goto("/index.html");
    const lightBg = await token(lp, "--bg-primary");
    const lightText = await token(lp, "--text-primary");
    const lightGreen = await token(lp, "--green");
    await light.close();

    // Surfaces and ink invert; semantic green darkens — all must differ.
    expect(darkBg).not.toBe(lightBg);
    expect(darkText).not.toBe(lightText);
    expect(darkGreen).not.toBe(lightGreen);
    // Sanity: the declared values resolved (not empty).
    expect(lightBg.toLowerCase()).toBe("#fbfaf7");
    expect(darkBg.toLowerCase()).toBe("#0b0c10");
  });
});
