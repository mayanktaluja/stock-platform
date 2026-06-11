// A2: comfortable / compact density mode.
//
// Density no longer has a visible header button; the mode still persists via
// localStorage and can be toggled by command surfaces.

import { test, expect } from "@playwright/test";

const densityAttr = (page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-density"));
const spaceToken = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--space-300")
      .trim(),
  );

test.describe("A2 density toggle", () => {
  test("defaults to comfortable with the :root spacing scale", async ({
    page,
  }) => {
    await page.goto("/index.html");
    expect(await densityAttr(page)).toBe("comfortable");
    expect(await spaceToken(page)).toBe("24px"); // :root --space-300
  });

  test("runtime helper flips to compact, tightens spacing, persists across reload", async ({
    page,
  }) => {
    await page.goto("/index.html");
    await expect(page.locator("#densityToggleBtn")).toHaveCount(0);

    await page.evaluate(() => window.togglePlatformDensity());
    expect(await densityAttr(page)).toBe("compact");
    expect(await spaceToken(page)).toBe("18px"); // compact --space-300
    expect(await page.evaluate(() => localStorage.getItem("density"))).toBe(
      "compact",
    );

    await page.reload();
    expect(await densityAttr(page)).toBe("compact");
    expect(await spaceToken(page)).toBe("18px");
  });

  test("density is independent of theme", async ({ browser }) => {
    // compact + light together resolve correctly.
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto("/index.html");
    await page.evaluate(() => window.togglePlatformDensity());
    expect(await densityAttr(page)).toBe("compact");
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("light");
    expect(await spaceToken(page)).toBe("18px");
    await ctx.close();
  });
});
