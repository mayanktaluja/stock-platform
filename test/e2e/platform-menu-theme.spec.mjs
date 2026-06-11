// Platform menu + theme contract.
//
// Light is the default regardless of OS preference. The Platform menu owns the
// explicit light/dark toggle and persists it in localStorage.starbhaiTheme.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const LIGHT_THEME = "#F7F8FB";
const DARK_THEME = "#0B0C10";

const ADMIN_ME = {
  userId: "e2e-owner",
  email: "mtaluja11@gmail.com",
  name: "Owner",
  picture: "",
  isAdmin: true,
};

const NORMAL_ME = {
  userId: "e2e-user",
  email: "friend@example.com",
  name: "Friend",
  picture: "",
  isAdmin: false,
};

async function mockMe(page, me) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(me),
    }),
  );
}

function parseRgb(input) {
  const match = String(input).match(
    /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)/,
  );
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] == null ? 1 : Number(match[4]),
  };
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
    a: 1,
  };
}

function blend(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function relLum({ r, g, b }) {
  const channel = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return channel[0] * 0.2126 + channel[1] * 0.7152 + channel[2] * 0.0722;
}

function contrast(fg, bg) {
  const a = relLum(fg);
  const b = relLum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function readTheme(page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      metaTheme: document.head.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
      htmlTheme: document.documentElement.getAttribute("data-theme"),
      storedTheme: localStorage.getItem("starbhaiTheme"),
      bgPrimary: root.getPropertyValue("--bg-primary").trim(),
      bgCard: root.getPropertyValue("--bg-card").trim(),
      textPrimary: root.getPropertyValue("--text-primary").trim(),
      textSecondary: root.getPropertyValue("--text-secondary").trim(),
      textMuted: root.getPropertyValue("--text-muted").trim(),
      gold: root.getPropertyValue("--gold").trim(),
      bodyBackground: body.backgroundColor,
      bodyColor: body.color,
    };
  });
}

async function openPlatformMenu(page) {
  await page.locator("#labsMenuBtn").click();
  await expect(page.locator("#labsMenuDropdown")).toBeVisible();
}

test.describe("Platform menu + light/dark theme", () => {
  test("light is the default with empty storage and static metadata matches manifest", async ({
    page,
    request,
  }) => {
    await mockMe(page, NORMAL_ME);
    await gotoApp(page);

    const manifestResponse = await request.get("/manifest.webmanifest");
    expect(manifestResponse.status()).toBe(200);
    const manifest = JSON.parse(await manifestResponse.text());

    const theme = await readTheme(page);
    expect(theme.htmlTheme).toBe("light");
    expect(theme.storedTheme).toBeNull();
    expect(theme.metaTheme).toBe(LIGHT_THEME);
    expect(theme.bgPrimary).toBe(LIGHT_THEME);
    expect(manifest.theme_color).toBe(LIGHT_THEME);
    expect(manifest.background_color).toBe(LIGHT_THEME);
  });

  test("theme toggle updates DOM, storage, meta, and persists dark across reload", async ({
    page,
  }) => {
    await mockMe(page, NORMAL_ME);
    await gotoApp(page);

    await openPlatformMenu(page);
    await expect(page.locator("#platformThemeToggle")).toHaveAttribute("aria-checked", "false");
    await page.locator("#platformThemeToggle").click();
    await expect
      .poll(() => readTheme(page))
      .toMatchObject({
        htmlTheme: "dark",
        storedTheme: "dark",
        metaTheme: DARK_THEME,
      });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.switchTab === "function");
    const after = await readTheme(page);
    expect(after.htmlTheme).toBe("dark");
    expect(after.storedTheme).toBe("dark");
    expect(after.metaTheme).toBe(DARK_THEME);
    expect(after.bgPrimary).toBe(DARK_THEME);

    await openPlatformMenu(page);
    await expect(page.locator("#platformThemeToggle")).toHaveAttribute("aria-checked", "true");
  });

  test("menu navigation opens US Market and Risk Lab with active heading/title", async ({
    page,
  }) => {
    await mockMe(page, NORMAL_ME);
    await gotoApp(page);

    await openPlatformMenu(page);
    await page.locator("#platformItem_usPicks").click();
    await expect(page.locator("#usPicksTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#liveTabHeading")).toHaveText("Starbhai — US Market");
    await expect(page).toHaveTitle(/US Market — Starbhai Stock Platform/);

    await openPlatformMenu(page);
    await page.locator("#platformItem_riskLab").click();
    await expect(page.locator("#riskLabTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#liveTabHeading")).toHaveText("Starbhai — Risk Lab");
    await expect(page).toHaveTitle(/Risk Lab — Starbhai Stock Platform/);
    await openPlatformMenu(page);
    await expect(page.locator("#platformItem_riskLab")).toHaveAttribute("aria-current", "page");
  });

  test("Users menu item is hidden for non-admin and visible for admin", async ({
    page,
  }) => {
    await mockMe(page, NORMAL_ME);
    await gotoApp(page);
    await openPlatformMenu(page);
    await expect(page.locator("#platformItem_users")).toHaveCount(0);

    const adminPage = await page.context().newPage();
    await mockMe(adminPage, ADMIN_ME);
    await gotoApp(adminPage);
    await openPlatformMenu(adminPage);
    await expect(adminPage.locator("#platformItem_users")).toBeVisible();
    await adminPage.close();
  });

  test("core shell surfaces keep readable contrast in both themes", async ({
    page,
  }) => {
    for (const themeName of ["light", "dark"]) {
      const themedPage = await page.context().newPage();
      await mockMe(themedPage, NORMAL_ME);
      await themedPage.addInitScript((theme) => localStorage.setItem("starbhaiTheme", theme), themeName);
      await themedPage.goto("/index.html", { waitUntil: "domcontentloaded" });
      await themedPage.waitForFunction(() => typeof window.switchTab === "function");
      await expect(themedPage.locator("#picksTab")).toBeVisible({ timeout: 10_000 });
      await openPlatformMenu(themedPage);

      const samples = await themedPage.evaluate(() => {
        const pick = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const cs = getComputedStyle(el);
          let bg = cs.backgroundColor;
          let parent = el.parentElement;
          while (parent && (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")) {
            bg = getComputedStyle(parent).backgroundColor;
            parent = parent.parentElement;
          }
          if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
            bg = getComputedStyle(document.body).backgroundColor;
          }
          return { selector, color: cs.color, bg };
        };
        return [
          pick("body"),
          pick("#picksTab p"),
          pick("#searchInput"),
          pick("#picksTabBtn"),
          pick("#newsTabBtn"),
          pick(".bottom-nav-btn"),
          pick(".info-icon"),
          pick("#platformThemeToggle"),
        ].filter(Boolean);
      });

      for (const sample of samples) {
        const fg = parseRgb(sample.color);
        const bg = parseRgb(sample.bg);
        expect(fg, `${themeName} ${sample.selector} color`).not.toBeNull();
        expect(bg, `${themeName} ${sample.selector} bg`).not.toBeNull();
        expect(
          contrast(blend(fg, bg), bg),
          `${themeName} ${sample.selector} contrast`,
        ).toBeGreaterThanOrEqual(3);
      }
      await themedPage.close();
    }
  });
});
