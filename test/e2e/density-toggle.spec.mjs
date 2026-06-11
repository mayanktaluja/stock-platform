// A2: comfortable / compact density toggle.
//
// The header density toggle flips [data-density] on <html>, persists it, and
// overrides the spacing-scale tokens so the UI tightens. Default is
// comfortable (inherits the :root scale unchanged).

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

  test("click flips to compact, tightens spacing, persists across reload", async ({
    page,
  }) => {
    await page.goto("/index.html");
    const btn = page.locator("#densityToggleBtn");
    await expect(btn).toHaveAttribute("aria-pressed", "false");

    await btn.click();
    expect(await densityAttr(page)).toBe("compact");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await expect(btn).toHaveAttribute("aria-label", /comfortable/i);
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
    await page.locator("#densityToggleBtn").click();
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
