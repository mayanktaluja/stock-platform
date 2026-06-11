// C1: visual-regression baselines.
//
// Captures key surfaces in BOTH themes. Fixture data (SWS_REPO_ROOT_OVERRIDE)
// is static, so the only volatile pixels are the live clock + scrolling
// ticker, which we mask. Each surface PR in Epic D intentionally updates its
// OWN baseline (run with --update-snapshots); the value of this harness is
// catching UNINTENDED drift in the surfaces a PR didn't mean to touch.
//
// Regenerate baselines:
//   SWS_REPO_ROOT_OVERRIDE=.e2e/sws-root npx playwright test visual/ --update-snapshots

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "../helpers/app.mjs";

// Baselines are rendered per-OS (…-chromium-darwin.png). Self-skip in CI so a
// linux runner without matching baselines doesn't false-fail; regenerate with
// --update-snapshots on whatever platform owns the baselines.
test.skip(!!process.env.CI, "visual baselines are environment-specific");

// Re-apply a theme/density AFTER gotoApp (which clears storage on first nav),
// then reload so the <head> boot script re-resolves from localStorage. The
// gotoApp sentinel prevents the storage-clear from re-firing on reload.
async function applyMode(page, theme, density = "comfortable") {
  await page.evaluate(
    ([t, d]) => {
      localStorage.setItem("theme", t);
      localStorage.setItem("density", d);
    },
    [theme, density],
  );
  await page.reload();
}

function volatileMasks(page) {
  return [
    page.locator(".market-ticker-shell"),
    page.locator(".header-clock"),
    page.locator("#marketCountdown"),
    page.locator("#statusText"),
  ];
}

for (const theme of ["dark", "light"]) {
  test(`Picks tab — ${theme}`, async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await applyMode(page, theme);
    await waitForPicksLoaded(page);
    // settle fonts/layout
    await page.waitForTimeout(400);
    await expect(page.locator("#picksTab")).toHaveScreenshot(
      `picks-${theme}.png`,
      { mask: volatileMasks(page) },
    );
  });
}
