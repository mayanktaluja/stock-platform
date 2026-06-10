import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Portfolio Analyzer — SWS input alerts", () => {
  test("renders mocked fundamental-change alerts and persists the email toggle", async ({ page }) => {
    let prefsPost = null;
    await page.route("**/api/portfolio/sws-input-alerts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          prefs: { inApp: true, email: false },
          run_id: "run-e2e",
          suppressed_count: 0,
          alerts: [{
            ticker: "TCS",
            name: "Tata Consultancy Services",
            severity: "medium",
            change_hash: "tcs-alert",
            changes: [{ field: "snowflake.future", previous: 4, current: 3, severity: "medium" }],
          }],
        }),
      });
    });
    await page.route("**/api/portfolio/sws-input-alerts/prefs", async (route) => {
      prefsPost = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, prefs: { inApp: true, email: true } }),
      });
    });

    await gotoApp(page, { tab: "analyzer" });
    await page.evaluate(async () => {
      const root = document.createElement("div");
      root.id = "swsInputAlertE2ERoot";
      root.style.position = "fixed";
      root.style.inset = "120px 24px auto 24px";
      root.style.zIndex = "9999";
      root.style.background = "var(--bg-primary)";
      document.body.prepend(root);
      await window.renderSwsInputAlertsPanel(root);
    });

    const panel = page.locator("#swsInputAlertE2ERoot [data-sws-input-alerts]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("SWS input changes");
    // Collapsed by default — the <details> starts closed.
    expect(await panel.evaluate((el) => el.open)).toBe(false);
    // textContent is present even while collapsed.
    await expect(panel).toContainText("TCS");
    await expect(panel).toContainText("snowflake.future");
    await expect(panel).toContainText("4 -> 3");

    // Expand so the email toggle is actionable, then persist the preference.
    await panel.locator("summary").click();
    expect(await panel.evaluate((el) => el.open)).toBe(true);
    await page.locator("#swsInputAlertEmailToggle").check();
    await expect.poll(() => prefsPost).toEqual({ inApp: true, email: true });
  });
});
