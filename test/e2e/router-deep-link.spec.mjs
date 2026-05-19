// PR #7: hash-based deep linking. Visiting /#tab=watchlist with no
// session should land directly on the watchlist tab (without first
// flickering to picks). Visiting /#tab=picks&symbol=RELIANCE should
// open the SWS modal pre-loaded with that ticker.

import { test, expect } from "@playwright/test";
import { setRiskProfile } from "./helpers/app.mjs";

test.describe("PR #7 hash deep-linking", () => {
  test("/index.html#tab=watchlist lands on watchlist tab without a click", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });
    await setRiskProfile(page, "MODERATE");
    await page.goto("/index.html#tab=watchlist", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => typeof window.switchTab === "function",
      null,
      { timeout: 10_000 },
    );
    await expect(page.locator("#watchlistTab")).toBeVisible({ timeout: 8000 });
  });

  test("/index.html#tab=track lands on track-record tab", async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });
    await setRiskProfile(page, "MODERATE");
    await page.goto("/index.html#tab=track", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => typeof window.switchTab === "function",
      null,
      { timeout: 10_000 },
    );
    await expect(page.locator("#trackTab")).toBeVisible({ timeout: 8000 });
  });

  test("writeHash + parseHash round-trip a deep state", async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });
    await setRiskProfile(page, "MODERATE");
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => typeof window.parseHash === "function",
      null,
      { timeout: 10_000 },
    );

    const result = await page.evaluate(() => {
      window.writeHash({ tab: "earnings", symbol: "RELIANCE" });
      const back = window.parseHash();
      return { hash: location.hash, back };
    });
    expect(result.hash).toBe("#tab=earnings&symbol=RELIANCE");
    expect(result.back.tab).toBe("earnings");
    expect(result.back.symbol).toBe("RELIANCE");
  });
});
