// Shared helpers for Playwright e2e tests against the gated SPA.
//
// The server is launched by playwright.config.mjs via the `webServer` block
// without OAuth env vars, so AUTH_ENABLED is false and the gate is bypassed.
// Every test starts from /index.html with a clean localStorage.

import { expect } from "@playwright/test";

export async function gotoApp(page, { tab } = {}) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
  });
  await page.goto("/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.switchTab === "function", null, {
    timeout: 10_000,
  });
  // Page boots into the "picks" tab via its own DOMContentLoaded handler.
  // Only invoke switchTab again when caller wants a non-default tab — calling
  // it on "picks" twice re-fires loadPicks() and resets the container to the
  // loading-spinner mid-test.
  if (tab && tab !== "picks") await switchTab(page, tab);
  else await expect(page.locator("#picksTab")).toBeVisible({ timeout: 10_000 });
}

export async function switchTab(page, tab) {
  await page.evaluate((t) => window.switchTab(t), tab);
  await expect(page.locator(`#${tab}Tab`)).toBeVisible({ timeout: 10_000 });
}

export async function waitForPicksLoaded(page) {
  await page.waitForFunction(
    () => {
      const tab = document.getElementById("picksTab");
      if (!tab || tab.style.display === "none") return false;
      return tab.querySelectorAll(".sws-pick-card, [data-pick-symbol]").length > 0;
    },
    null,
    { timeout: 30_000 }
  );
}
