// Login page (public/login.html) — theme-aware first impression.
//
// The login page is the pre-auth surface. It must mirror the app's theme
// resolution (starbhaiTheme > legacy `theme` > light) so a first-time visitor
// lands in light (consistent with the post-auth default) and a returning dark
// user gets a dark login with no light↔dark whiplash. Direct navigation, not
// gotoApp — login.html is a standalone static file with no app bundle.

import { test, expect } from "@playwright/test";

function bodyBg(page) {
  return page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
}

test.describe("login page theme", () => {
  test("first-time visitor (no stored theme) → light", async ({ browser }) => {
    // Suite default colorScheme is dark; the boot ignores OS by design.
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/login.html", { waitUntil: "domcontentloaded" });

    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("light");
    // #FBFAF7 → rgb(251, 250, 247)
    expect(await bodyBg(page)).toBe("rgb(251, 250, 247)");

    await expect(page.locator("a.google-btn")).toBeVisible();
    await expect(page.locator("a.google-btn")).toHaveAttribute(
      "href",
      "/api/auth/google",
    );
    await expect(page.locator(".footer")).toHaveText(
      "Private terminal · authorized access only",
    );
    await ctx.close();
  });

  test("returning dark user (starbhaiTheme=dark) → dark", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem("starbhaiTheme", "dark");
      } catch (e) {}
    });
    await page.goto("/login.html", { waitUntil: "domcontentloaded" });

    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("dark");
    // #0B0C10 → rgb(11, 12, 16)
    expect(await bodyBg(page)).toBe("rgb(11, 12, 16)");
    // meta theme-color tracks the dark theme for mobile browser chrome
    expect(
      await page.evaluate(
        () => document.querySelector('meta[name="theme-color"]').content,
      ),
    ).toBe("#0B0C10");
    await ctx.close();
  });
});
