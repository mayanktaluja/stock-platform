// Shared helpers for Playwright e2e tests against the gated SPA.
//
// The server is launched by playwright.config.mjs via the `webServer` block
// without OAuth env vars, so AUTH_ENABLED is false and the gate is bypassed.
// Every test starts from /index.html with a clean localStorage.

import { expect } from "@playwright/test";

// Default-bucket answer maps for the 3-question risk profile (see
// riskProfile.js). Used by gotoApp() to pre-set a MODERATE profile so the
// 2026-05-16 hard-gate doesn't break tests that don't care about it.
const RISK_PROFILE_DEFAULTS = {
  CONSERVATIVE: { horizon: "short",  loss_tolerance: "low",    age_bracket: "older" },
  MODERATE:     { horizon: "medium", loss_tolerance: "medium", age_bracket: "mid"   },
  AGGRESSIVE:   { horizon: "long",   loss_tolerance: "high",   age_bracket: "young" },
};

export async function setRiskProfile(page, bucket = "MODERATE") {
  if (!bucket) {
    await page.request.delete("/api/risk-profile").catch(() => {});
    return;
  }
  const answers = RISK_PROFILE_DEFAULTS[bucket] || RISK_PROFILE_DEFAULTS.MODERATE;
  await page.request.post("/api/risk-profile", {
    data: { answers },
    headers: { "Content-Type": "application/json" },
  }).catch(() => {});
}

export async function clearRiskProfile(page) {
  await page.request.delete("/api/risk-profile").catch(() => {});
}

export async function gotoApp(page, { tab, riskProfile = "MODERATE" } = {}) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
  });
  // Set (or clear) the per-user risk profile via API before navigating so
  // the hard-gated /api/portfolio/* routes work for the default fast-path.
  // Tests that exercise the gate itself pass riskProfile: null.
  await setRiskProfile(page, riskProfile);
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
